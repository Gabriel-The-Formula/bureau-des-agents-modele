// Le cumul des jetons depuis le démarrage de la nouvelle organisation (22/10/2026), toutes sessions et sous-agents
// confondus, pour le bandeau. Lecture incrémentale : chaque transcription n'est lue qu'une fois (on garde l'offset
// atteint), puis seulement sa suite ; chaque message n'est compté qu'une fois (son id), même s'il est recopié dans une
// autre transcription (session reprise ou dupliquée). Cache : ~/.config/bureau-collector/totals.json.
// Pour aller vite, on ne décode pas les lignes : on n'en extrait que l'id du message, le modèle, la date et l'usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { breathe, stage } from './stall.ts';
import { costOf, type Usage } from '../shared/pricing.ts';

export interface Totals {
  since: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  cost: number;
  /** jetons d'un modèle hors de la table des tarifs (le coût est alors un minimum) */
  unknown: number;
  /** vrai tant que le premier passage n'a pas tout lu */
  partial: boolean;
}

const FILE = path.join(os.homedir(), '.config', 'bureau-collector', 'totals.json');
const CHUNK = 8 << 20;
const KEY_RE: Record<string, RegExp> = Object.fromEntries(
  ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens']
    .map((k) => [k, new RegExp(`"${k}":(\\d+)`)]),
);

interface Cache { since: number; files: Record<string, number>; ids: string[]; sum: Omit<Totals, 'since' | 'partial'> }

export class TokenTotals {
  private readonly since: number;
  private readonly dir: string;
  private files = new Map<string, number>();
  private ids = new Set<string>();
  private sum = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, unknown: 0 };
  private firstPassDone = false;
  private busy = false;
  private dirty = false;
  private lastSave = 0;

  constructor(since: number, dir: string) {
    this.since = since;
    this.dir = dir;
    try {
      const c = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Cache;
      if (c.since === since) {
        this.files = new Map(Object.entries(c.files));
        this.ids = new Set(c.ids);
        this.sum = { ...this.sum, ...c.sum };
      }
    } catch { /* premier lancement : tout sera lu */ }
  }

  get value(): Totals {
    return { since: this.since, ...this.sum, cost: Math.round(this.sum.cost * 100) / 100, partial: !this.firstPassDone };
  }

  /** Lit ce qui est nouveau dans les transcriptions (un fichier par tour de boucle, sans bloquer le reste). */
  async refresh(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    const before = JSON.stringify(this.sum);
    try {
      stage('cumul de jetons : liste des fichiers');
      const files = await this.listFiles();
      stage('cumul de jetons : lecture');
      for (const f of files) {
        this.readFile(f.path, f.size);
        await new Promise((r) => setImmediate(r));
      }
      this.firstPassDone = true;
    } finally {
      this.busy = false;
    }
    const moved = JSON.stringify(this.sum) !== before;
    if (moved) this.dirty = true;
    if (this.dirty && Date.now() - this.lastSave > 5 * 60_000) this.save();
    return moved;
  }

  // 21 779 transcriptions parcourues toutes les 30 s (0,7 à 4 s d'un bloc) : la main est rendue en chemin
  private async listFiles(): Promise<{ path: string; size: number }[]> {
    const out: { path: string; size: number }[] = [];
    const walk = async (d: string, depth: number) => {
      let names: fs.Dirent[];
      try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      await breathe();
      for (const n of names) {
        const p = path.join(d, n.name);
        if (n.isDirectory()) { if (depth < 5 && n.name !== 'tool-results') await walk(p, depth + 1); continue; }
        if (!n.name.endsWith('.jsonl')) continue;
        await breathe();
        let st: fs.Stats;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs < this.since) continue;
        if ((this.files.get(p) ?? 0) === st.size) continue;
        out.push({ path: p, size: st.size });
      }
    };
    await walk(this.dir, 0);
    return out;
  }

  private readFile(file: string, size: number) {
    let offset = this.files.get(file) ?? 0;
    if (offset > size) offset = 0; // fichier réécrit : les ids déjà vus évitent le double comptage
    let fd: number;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      let rest = '';
      const buf = Buffer.alloc(CHUNK);
      while (offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - offset), offset);
        if (n <= 0) break;
        const text = rest + buf.toString('utf8', 0, n);
        const lines = text.split('\n');
        rest = lines.pop() ?? '';
        offset += n;
        for (const l of lines) this.line(l);
      }
      // une ligne pas encore terminée sera relue au prochain passage
      this.files.set(file, offset - Buffer.byteLength(rest));
    } finally {
      fs.closeSync(fd);
    }
  }

  private line(l: string) {
    if (!l.includes('"usage"') || !l.includes('"type":"assistant"')) return;
    const id = /"message":\{[^{}]*?"id":"(msg_[\w-]+)"/.exec(l)?.[1] ?? /"id":"(msg_[\w-]+)"/.exec(l)?.[1];
    if (!id || this.ids.has(id)) return;
    const ts = Date.parse(/"timestamp":"([^"]+)"/.exec(l)?.[1] ?? '');
    if (!(ts >= this.since)) return;
    const model = /"model":"([^"]+)"/.exec(l)?.[1] ?? '';
    if (model === '<synthetic>') return;
    // l'usage contient des objets imbriqués (iterations…) : on lit seulement ses premiers compteurs, ceux du message
    const at = l.indexOf('"usage":{');
    if (at < 0) return;
    const seg = l.slice(at, at + 1500);
    const n = (k: string) => Number(KEY_RE[k].exec(seg)?.[1] ?? 0);
    const u: Usage = {
      input_tokens: n('input_tokens'), output_tokens: n('output_tokens'),
      cache_read_input_tokens: n('cache_read_input_tokens'), cache_creation_input_tokens: n('cache_creation_input_tokens'),
      cache_creation: { ephemeral_1h_input_tokens: n('ephemeral_1h_input_tokens'), ephemeral_5m_input_tokens: n('ephemeral_5m_input_tokens') },
    };
    // une vraie copie : une sous-chaîne garderait en mémoire toute la ligne (souvent plusieurs Mo)
    this.ids.add(Buffer.from(id).toString());
    const input = Number(u.input_tokens ?? 0);
    const output = Number(u.output_tokens ?? 0);
    const cw = Number(u.cache_creation_input_tokens ?? 0);
    const cr = Number(u.cache_read_input_tokens ?? 0);
    this.sum.input += input; this.sum.output += output; this.sum.cacheWrite += cw; this.sum.cacheRead += cr;
    const c = costOf(model, u);
    if (c === null) this.sum.unknown += input + output + cw + cr;
    else this.sum.cost += c;
  }

  save() {
    this.lastSave = Date.now();
    this.dirty = false;
    const c: Cache = { since: this.since, files: Object.fromEntries(this.files), ids: [...this.ids], sum: this.sum };
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 }); fs.writeFileSync(FILE, JSON.stringify(c), { mode: 0o600 }); } catch { /* tant pis */ }
  }
}
