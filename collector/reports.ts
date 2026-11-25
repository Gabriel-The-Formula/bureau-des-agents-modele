// Les rapports longs (onglet « Rapports ») : les fichiers .md du dossier des rapports (BUREAU_REPORTS_DIR, réglé par
// `npm run local -- --rapports <dossier>`), sur deux niveaux (<dossier>/<sujet>/x.md), qui commencent par un en-tête `---`
// avec `rapport:`. Seuls ceux-là partent : les fichiers de travail (PLAN, notes) restent sur ta machine. Les images citées
// (![légende](chemin relatif)) partent au R2 privé comme les captures du fil ; le texte, caviardé, part au Worker
// (PUT /api/reports/<id>.json) avec la liste (index.json). Un rapport n'est renvoyé que s'il a changé (empreinte gardée dans
// ~/.config/bureau-collector/reports.json). Tout est asynchrone : la boucle du collecteur (salles en direct) n'attend jamais
// la lecture des dossiers ni la réduction des images.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { breathe, stage } from './stall.ts';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { levelOf, redact, redactUrl, type Report, type ReportIndex, type ReportMeta } from '../shared/live.ts';
import { AUDIO_MIN_WORDS, audioReady, audioSource, MP3_MIN_BYTES, mp3Seconds, renderReportAudio, type AudioMade } from './reportAudio.ts';
import { closePdfBrowser, renderReportPdf, type PdfImage } from './reportPdf.ts';
import { WORK_DIR } from './summarize.ts';

const run = promisify(execFile);
/** le dossier des rapports ; sans lui, l'onglet Rapports reste vide */
const MISSIONS = process.env.BUREAU_REPORTS_DIR ? path.resolve(process.env.BUREAU_REPORTS_DIR) : '';
/** les images peuvent venir de ce dossier-là seulement */
const IMAGE_ROOTS = MISSIONS ? [MISSIONS] : [];
/** ce qui a déjà été envoyé ; npm run local le range avec l'état de son Worker local (BUREAU_REPORTS_STORE), pour que
 * des rapports « déjà envoyés » à un autre bureau ne manquent pas à un bureau neuf */
const FILE = process.env.BUREAU_REPORTS_STORE || path.join(os.homedir(), '.config', 'bureau-collector', 'reports.json');
/** dossiers jamais parcourus (gros, ou sans rapport) */
const SKIP_DIRS = new Set(['node_modules', '.git', 'logs', 'data', 'tmp', 'cache', 'archive', 'archives', 'venv', '.venv', 'dist', 'build', 'raw', 'sauvegardes', 'backup', 'backups']);
/** copie de sauvegarde d'un rapport (RAPPORT-BUREAU-avant-s26.md, RAPPORT-BUREAU.avant-cq2.md) : elle garde son en-tête
 * `rapport:` et serait publiée comme un deuxième rapport, périmé, à côté du vrai */
export const isBackupReportName = (name: string) => /[._-]avant[._-]/i.test(name);
const MAX_BODY = 600_000;
const MAX_IMAGES = 40;
/** au-delà, l'image est réduite (JPEG, MAX_WIDTH px de large au plus) avant l'envoi (900 Ko -> 1,5 Mo) */
const SHRINK_BYTES = 1_500_000;
const MAX_WIDTH = 1800;
const MAX_IMAGE_BYTES = 3_000_000;
/** la forme d'adresse acceptée par le Worker ; « index » est réservé à la liste */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,150}$/;

type UploadFn = (body: Buffer, type: string, id: string) => Promise<boolean>;
/** PUT (texte JSON) ou DELETE d'un fichier de rapports sur le Worker */
export type PutFn = (name: string, json: string | null) => Promise<boolean>;

interface Stored {
  /** image (chemin) -> son envoi : taille et date du fichier, identifiant dans le R2 */
  images: Record<string, { size: number; mtime: number; id: string; v?: number }>;
  /** rapport -> empreinte envoyée */
  sent: Record<string, string>;
  /** rapport -> sa fiche telle qu'envoyée (gardée dans la liste si un nouvel envoi échoue) */
  metas: Record<string, ReportMeta>;
  indexSig: string;
  /** rapport -> le PDF fait pour sa version visible (pdfKey) ; url null : Chromium a échoué (nouvel essai 6 h après) */
  pdfs?: Record<string, { key: string; url: string | null; at?: number; look?: number }>;
  /** rapport -> le résumé audio fait pour cette version du texte (audioKey) ; audio null : échec (nouvel essai 6 h après) */
  audios?: Record<string, { key: string; audio: { url: string; seconds: number } | null; at?: number }>;
  /** résumés audio lancés aujourd'hui (un appel à Claude chacun) : le plafond du jour */
  audioDay?: { day: string; n: number };
}

let store: Stored = { images: {}, sent: {}, metas: {}, indexSig: '' };
try { store = { ...store, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* premier lancement */ }

async function save() {
  try { await fsp.mkdir(path.dirname(FILE), { recursive: true, mode: 0o700 }); await fsp.writeFile(FILE, JSON.stringify(store), { mode: 0o600 }); } catch { /* tant pis */ }
}

const list = async (dir: string) => { try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; } };

async function head(file: string): Promise<string> {
  let fh: fsp.FileHandle | null = null;
  try { fh = await fsp.open(file, 'r'); const b = Buffer.alloc(800); const { bytesRead } = await fh.read(b, 0, 800, 0); return b.subarray(0, bytesRead).toString('utf8'); } catch { return ''; } finally { await fh?.close(); }
}

/** Les .md à en-tête `rapport:` du dossier des rapports : dossier/x.md et dossier/sous-dossier/x.md. */
export async function findReports(): Promise<string[]> {
  const out: string[] = [];
  if (!MISSIONS) return out;
  const look = async (dir: string, depth: number) => {
    for (const d of await list(dir)) {
      if (d.name.startsWith('.')) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (depth < 2 && !SKIP_DIRS.has(d.name.toLowerCase())) await look(p, depth + 1); continue; }
      if (!d.isFile() || !/\.md$/i.test(d.name) || depth === 0 || isBackupReportName(d.name)) continue;
      const h = await head(p);
      if (/^---\r?\n/.test(h) && /^rapport\s*:/m.test(h.split(/\r?\n---/)[0] ?? '')) out.push(p);
    }
  };
  await look(MISSIONS, 0);
  return out;
}

/** L'en-tête `---` (clé: valeur sur une ligne) et le texte qui suit. */
export function parseFront(text: string): { meta: Record<string, string>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-zéèàç_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Typographie du texte courant : pas de tiret cadratin, et jamais « 3 000 » ou « 8 % » coupé en fin de ligne. */
function typo(t: string): string {
  return t
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/—/g, ', ')
    .replace(/–/g, '-')
    .replace(/(\d) (?=\d{3}(?!\d))/g, '$1 ')
    .replace(/(\d) (?=(?:%|€|k€|M€|\$|h\b|min\b|ms\b|ans?\b|jours?\b|mois\b|fois\b))/g, '$1 ')
    .replace(/« /g, '« ')
    .replace(/ (?=[»:;!?](?:\s|$|[.,)]))/gm, ' ');
}

/**
 * Nettoie un texte affiché : secrets caviardés et jamais de chemin complet partout ; la typographie seulement hors du
 * code (blocs et `code`) et des adresses de liens, qu'elle abîmerait.
 */
function clean(t: string): string {
  // Les adresses de liens à part : redact() casserait un slug d'article, un watch?v= ou un #r=<rapport> ;
  // redactUrl() les caviarde à leur manière au moment de les remettre. La marque fait 4 caractères : derrière
  // « API_KEY= », le motif clé=valeur de redact() l'avale, et l'adresse avec.
  const urls: string[] = [];
  const mark = (u: string) => { urls.push(u); return `\u0002L${urls.length - 1}\u0002`; };
  const marked = String(t ?? '').replace(/(\]\()([^)\s]*)(?=\))|https?:\/\/[^\s)>\]`"'<]+/g, (m, open?: string, target?: string) => {
    if (open !== undefined) return open + mark(target ?? '');
    const tail = /[.,;:!?]+$/.exec(m)?.[0] ?? '';
    return mark(m.slice(0, m.length - tail.length)) + tail;
  });
  const home = /(?:\/private)?\/(?:Users|home)\/[^/\s)]+\//g;
  const safe = redact(marked).replace(home, '~/');
  const kept: string[] = [];
  const hold = (m: string) => { kept.push(m); return `\u0001${kept.length - 1}\u0001`; };
  return typo(safe.replace(/```[\s\S]*?```|`[^`\n]*`/g, hold))
    .replace(/\u0001(\d+)\u0001/g, (_m, n: string) => kept[Number(n)])
    .replace(/\u0002L(\d+)\u0002/g, (_m, n: string) => {
      const u = redactUrl(urls[Number(n)]);
      return /^https?:/i.test(u) ? u : u.replace(home, '~/');
    });
}

const slugOf = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** L'adresse du rapport : son dossier, et le nom du fichier s'il n'est pas RAPPORT-BUREAU.md ; toujours acceptée par le Worker. */
export function idOf(file: string): string {
  const rel = path.relative(MISSIONS, file).split(path.sep);
  const dir = slugOf(rel[0]);
  const name = rel.slice(1).join('-').replace(/\.md$/i, '');
  let id = (/^rapport-bureau$/i.test(name) ? dir : [dir, slugOf(name)].filter(Boolean).join('--')).slice(0, 150).replace(/^-+|-+$/g, '');
  // un dossier sans lettre latine (ou « index », réservé à la liste) : une adresse tirée du chemin
  if (!ID_RE.test(id) || id === 'index') id = `rapport-${createHash('sha256').update(rel.join('/')).digest('hex').slice(0, 10)}`;
  return id;
}

async function inside(file: string): Promise<boolean> {
  let real: string;
  try { real = await fsp.realpath(file); } catch { return false; }
  for (const r of IMAGE_ROOTS) {
    try { const rr = await fsp.realpath(r); if (real === rr || real.startsWith(rr + path.sep)) return true; } catch { /* dossier absent */ }
  }
  return false;
}

/** largeur et hauteur d'une image en pixels (sips), mises en cache par version du fichier ; null si illisible. */
const dims = new Map<string, { w: number; h: number } | null>();
async function imageDims(file: string, st?: fs.Stats): Promise<{ w: number; h: number } | null> {
  try { st ??= await fsp.stat(file); } catch { return null; }
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (dims.has(key)) return dims.get(key)!;
  let d: { w: number; h: number } | null = null;
  try {
    const { stdout } = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeout: 10_000 });
    const w = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]); const h = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]);
    if (w > 0 && h > 0) d = { w, h };
  } catch { /* illisible */ }
  dims.set(key, d);
  return d;
}

/**
 * Lit une image (réduite si elle est lourde) : son contenu, son type et son extension ; null si elle n'est pas utilisable.
 * la réduction se fait par la LARGEUR (MAX_WIDTH au plus, jamais agrandie) : une capture haute (780 x 9 370)
 * garde ses 780 px de large ; si le JPEG dépasse encore la limite du Worker, qualité puis largeur baissent.
 */
export async function readImage(file: string, st: fs.Stats): Promise<{ body: Buffer; type: string; ext: string } | null> {
  const m = /\.(png|jpe?g|webp)$/i.exec(file);
  if (!m || !st.isFile() || st.size < 200 || st.size > 40_000_000) return null;
  if (st.size > SHRINK_BYTES) {
    const out = path.join(WORK_DIR, `report-shrink-${process.pid}.jpg`);
    const d = await imageDims(file, st);
    const w0 = d ? Math.min(d.w, MAX_WIDTH) : 0;
    try {
      await fsp.mkdir(WORK_DIR, { recursive: true, mode: 0o700 });
      for (const [k, q] of [[1, 82], [1, 68], [0.8, 68], [0.6, 62]] as const) {
        const size = w0 ? ['--resampleWidth', String(Math.round(w0 * k))] : [];
        await run('/usr/bin/sips', [...size, '-s', 'format', 'jpeg', '-s', 'formatOptions', String(q), file, '--out', out], { timeout: 30_000 });
        const body = await fsp.readFile(out);
        if (body.length <= MAX_IMAGE_BYTES) return { body, type: 'image/jpeg', ext: 'jpg' };
        if (!w0) break;
      }
      return null;
    } catch { return null; } finally { await fsp.rm(out, { force: true }).catch(() => undefined); }
  }
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
  return { body: await fsp.readFile(file), ext, type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
}

/** adresse /media/<id> -> le fichier d'origine sur le Mac (pour le PDF) */
const localOf = new Map<string, string>();

/** Envoie une image (une fois par version du fichier) et renvoie son adresse /media/<id> ; null si impossible. */
async function imageUrl(file: string, upload: UploadFn): Promise<string | null> {
  let st: fs.Stats;
  try { st = await fsp.stat(file); } catch { return null; }
  const known = store.images[file];
  // une image lourde envoyée avant la réduction par la largeur (v absent) repart une fois
  if (known && known.size === st.size && known.mtime === st.mtimeMs && (st.size <= 900_000 || known.v === 2)) {
    localOf.set(`/media/${known.id}`, file);
    return `/media/${known.id}`;
  }
  const img = await readImage(file, st);
  if (!img) return null;
  const id = createHash('sha256').update(img.body).digest('hex').slice(0, 32) + '.' + img.ext;
  if (!(await upload(img.body, img.type, id))) return null;
  store.images[file] = { size: st.size, mtime: st.mtimeMs, id, v: 2 };
  localOf.set(`/media/${id}`, file);
  return `/media/${id}`;
}

/** largeur / hauteur d'une image ; null si illisible (la carte garde alors son cadre 16:9). */
async function imageRatio(file: string): Promise<number | null> {
  const d = await imageDims(file);
  return d ? Math.round((d.w / d.h) * 100) / 100 : null;
}

/** un extrait sonore cité dans un rapport (![légende](extrait.mp3)) : envoyé tel quel, lu sur place avec ses
 * commandes (banc de voix, comparaison d'extraits). 12 Mo au plus, comme le résumé audio. */
async function audioFileUrl(file: string, upload: UploadFn): Promise<string | null> {
  let st: fs.Stats;
  try { st = await fsp.stat(file); } catch { return null; }
  if (!st.isFile() || st.size < 2_000 || st.size > 12_000_000) return null;
  const known = store.images[file];
  if (known && known.size === st.size && known.mtime === st.mtimeMs && known.id.endsWith('.mp3')) return `/media/${known.id}`;
  const body = await fsp.readFile(file);
  const id = createHash('sha256').update(body).digest('hex').slice(0, 32) + '.mp3';
  if (!(await upload(body, 'audio/mpeg', id))) return null;
  store.images[file] = { size: st.size, mtime: st.mtimeMs, id, v: 2 };
  return `/media/${id}`;
}
const isClip = (u: string | null) => !!u && u.endsWith('.mp3');

const IMG_RE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** AAAA-MM-JJ à l'heure du Mac (pas en UTC : un fichier modifié à 0 h 30 garde sa date). */
const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Un rapport prêt à partir ; null si le fichier n'en est plus un. Les images manquantes deviennent leur légende. */
export async function buildReport(file: string, upload: UploadFn): Promise<Report | null> {
  let text: string;
  let st: fs.Stats;
  try { st = await fsp.stat(file); text = await fsp.readFile(file, 'utf8'); } catch { return null; }
  const fm = parseFront(text);
  if (!fm || !fm.meta.rapport) return null;
  const dir = path.dirname(file);
  const resolve = (src: string) => { try { return path.resolve(dir, decodeURI(src)); } catch { return path.resolve(dir, src); } };

  // les images d'abord mises de côté (le caviardage abîmerait leurs adresses), puis remises avec leur adresse /media/<id>
  const found: { alt: string; src: string }[] = [];
  const issue = Number(fm.meta.issue);
  const text0 = markers(fm);
  let body = text0.slice(0, MAX_BODY).replace(IMG_RE, (_m, alt: string, src: string) => { found.push({ alt, src }); return `\u0000IMG${found.length - 1}\u0000`; });
  body = clean(body);
  const urls: (string | null)[] = [];
  for (const [i, f] of found.entries()) {
    const abs = resolve(f.src);
    urls.push(i < MAX_IMAGES && !/^[a-z]+:/i.test(f.src) && (await inside(abs)) ? await (/\.mp3$/i.test(abs) ? audioFileUrl : imageUrl)(abs, upload) : null);
  }
  body = body.replace(/\u0000IMG(\d+)\u0000/g, (_m, n: string) => {
    const f = found[Number(n)];
    const alt = clean(f.alt).replace(/[[\]]/g, '');
    const url = urls[Number(n)];
    return url ? `![${alt}](${url})` : alt ? `*${alt}*` : '';
  });

  let cover: string | undefined;
  let coverFile: string | undefined;
  if (fm.meta.couverture) {
    const abs = resolve(fm.meta.couverture);
    if (await inside(abs)) { cover = (await imageUrl(abs, upload)) ?? undefined; if (cover) coverFile = abs; }
  }
  if (!cover) {
    const i = urls.findIndex((u) => !!u && !isClip(u));
    if (i >= 0) { cover = urls[i]!; coverFile = resolve(found[i].src); }
  }
  // la forme de la couverture : la carte de la liste la montre entière sans bandes vides ni saut de mise en page
  const coverRatio = coverFile ? await imageRatio(coverFile) : null;

  const date = /^\d{4}-\d{2}-\d{2}$/.test(fm.meta.date ?? '') ? fm.meta.date : localDay(st.mtimeMs);
  const meta: Omit<ReportMeta, 'sig'> = {
    id: idOf(file),
    title: clean(fm.meta.rapport).slice(0, 140),
    subject: clean(fm.meta.sujet || 'Autres').slice(0, 40),
    summary: clean(fm.meta.resume || fm.meta['résumé'] || '').slice(0, 400),
    ...(Number.isInteger(issue) && issue > 0 ? { issue } : {}),
    date,
    updatedAt: Math.round(st.mtimeMs),
    // le détail replié d'une carte ne compte pas dans le temps de lecture (il ne s'ouvre que si on veut)
    words: body.replace(/<!--\s*detail[^>]*-->[\s\S]*?<!--\s*\/detail\s*-->/gi, '').replace(/@@detail[^@]*@@[\s\S]*?@@\/detail@@/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').split(/\s+/).filter((w) => /[\p{L}\d]/u.test(w)).length,
    images: urls.filter((u) => !!u && !isClip(u)).length,
    ...(cover ? { cover } : {}),
    ...(cover && coverRatio ? { coverRatio } : {}),
    level: levelOf(fm.meta.niveau),
  };
  const sig = createHash('sha256').update(JSON.stringify(meta) + body).digest('hex').slice(0, 16);
  return { ...meta, sig, body };
}

/** Le texte du rapport (en-tête à part) ; un premier titre « # … » identique au titre du rapport (fiche lisible aussi sur
 *  GitHub) n'est pas répété ; `<!-- detail: Voir plus -->` … `<!-- /detail -->` devient un bloc replié à la lecture. */
function markers(fm: NonNullable<ReturnType<typeof parseFront>>): string {
  const own = /^\s*# (.+)\r?\n/.exec(fm.body);
  const text = own && own[1].trim() === fm.meta.rapport.trim() ? fm.body.slice(own[0].length) : fm.body;
  return text
    .replace(/<!--\s*detail(?:\s*:\s*([^<>@\n]{1,60}?))?\s*-->/gi, (_m, label?: string) => `\n\n@@detail${label ? `:${label.trim()}` : ''}@@\n\n`)
    .replace(/<!--\s*\/detail\s*-->/gi, '\n\n@@/detail@@\n\n');
}

/** Republier les rapports au prochain tour du collecteur, sans attendre 5 min. */
let soon = false;
export function publishSoon() { soon = true; }
export function takePublishSoon() { const s = soon; soon = false; return s; }

let running = false;

/** essai à la main (scripts/report-pdf.ts) : le PDF d'un rapport .md, sans rien envoyer */
export async function reportPdfOf(file: string): Promise<Buffer | null> {
  const r = await buildReport(file, async () => true);
  if (!r) return null;
  let out: Buffer | null = null;
  try { await makePdf(r, async (body) => { out = body; return true; }); } finally { await closePdfBrowser(); }
  return out;
}

/** essai à la main (scripts/report-audio.ts) : le résumé audio d'un rapport .md (MP3, durée, texte dit), sans rien envoyer */
export async function reportAudioOf(file: string): Promise<AudioMade | null> {
  const r = await buildReport(file, async () => true);
  return r ? renderReportAudio(r) : null;
}

/** PDF faits par passage au plus (le premier passage rattrape les anciens rapports par lots) */
const PDF_PER_PASS = 6;
/** version de la mise en page du PDF : la changer refait tous les PDF, peu à peu, sans retirer les anciens */
const PDF_LOOK = 4;
/** la limite du Worker pour un PDF */
const MAX_PDF_BYTES = 30_000_000;
/** noms des fichiers temporaires : uniques même si un rendu hors délai finit après le suivant */
let pdfSeq = 0;
/** ce qui se voit dans le PDF */
const pdfKey = (r: Report) => createHash('sha256')
  .update(JSON.stringify([r.title, r.subject, r.summary, r.issue, r.date, r.words, r.cover, r.body])).digest('hex').slice(0, 16);

/** version du gabarit du résumé audio (consigne, voix) : la changer refait les résumés, un à la fois */
const AUDIO_LOOK = 2;
/** un rapport encore retouché attend : pas de résumé audio tant qu'il a bougé depuis moins de 30 min */
const AUDIO_QUIET_MS = 30 * 60_000;
/** deux minutes au moins entre deux fabrications (un appel à Claude et 20 à 40 s de voix chacune) : 30 par heure au plus */
const AUDIO_GAP_MS = 2 * 60_000;
/** 100 résumés audio par jour au plus (BUREAU_AUDIO_PER_DAY) : chacun est un appel à Claude sur ton abonnement, les
 * anciens rapports se rattrapent donc en quelques jours, les « À lire » et les plus récents d'abord */
const AUDIO_PER_DAY = Math.max(0, Number(process.env.BUREAU_AUDIO_PER_DAY ?? 100) || 0);
const audioToday = () => new Date().toLocaleDateString('fr-CA');
const audioLeft = () => AUDIO_PER_DAY - (store.audioDay?.day === audioToday() ? store.audioDay.n : 0);
/** ce qui s'entend : le texte envoyé à Claude (titre, sujet, date, résumé, texte ; une image régénérée ne refait pas le son) */
const audioKey = (r: Report) => createHash('sha256').update(JSON.stringify([AUDIO_LOOK, audioSource(r)])).digest('hex').slice(0, 16);
/** l'ordre de fabrication : les rapports « À lire » d'abord, puis du plus récent au plus ancien */
/** BUREAU_AUDIO_FIRST (ids séparés par des virgules) passe devant tout le reste : rapports à refaire en priorité (nouvelle voix) */
const AUDIO_FIRST = new Set((process.env.BUREAU_AUDIO_FIRST ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const audioRank = (r: Report) => (AUDIO_FIRST.has(r.id) ? 2e15 : 0) + (r.level === 'a-lire' ? 1e15 : 0) + r.updatedAt;
/** une publication en attente repousse le résumé audio au passage suivant, mais 10 min au plus : des rapports réécrits sans
 * arrêt ne l'affament pas */
const AUDIO_STARVE_MS = 10 * 60_000;
let audioBusy = false;
let audioStartedAt = 0;
/** échecs de suite ; au 3e, pause d'une heure : une panne générale (limite d'usage, voix, envoi) ne vide pas le plafond du jour */
let audioFails = 0;
let audioPausedUntil = 0;
const AUDIO_PAUSE_MS = 3_600_000;
function audioResult(ok: boolean, log: (s: string) => void) {
  audioFails = ok ? 0 : audioFails + 1;
  if (audioFails < 3) return;
  audioFails = 0;
  audioPausedUntil = Date.now() + AUDIO_PAUSE_MS;
  log('résumés audio : 3 échecs de suite, pause d’une heure');
}

/** un MP3 fait mais non envoyé (R2 en panne) attend ici, à côté du suivi des envois : le nouvel essai le renvoie
 * tel quel, sans nouvel appel à Claude ; un fichier resté plus de 7 jours (texte modifié entre-temps) est retiré */
const AUDIO_WAIT_DIR = path.join(path.dirname(FILE), 'audio-attente');
const audioWaitFile = (key: string) => path.join(AUDIO_WAIT_DIR, `${key}.mp3`);
async function audioWaiting(key: string): Promise<Buffer | null> {
  const mp3 = await fsp.readFile(audioWaitFile(key)).catch(() => null);
  return mp3 && mp3.length >= MP3_MIN_BYTES ? mp3 : null;
}
async function keepAudio(key: string, mp3: Buffer) {
  await fsp.mkdir(AUDIO_WAIT_DIR, { recursive: true, mode: 0o700 });
  for (const f of await fsp.readdir(AUDIO_WAIT_DIR)) {
    const p = path.join(AUDIO_WAIT_DIR, f);
    if (Date.now() - (await fsp.stat(p)).mtimeMs > 7 * 86_400_000) await fsp.rm(p, { force: true });
  }
  await fsp.writeFile(audioWaitFile(key), mp3, { mode: 0o600 });
}

/** Fait le résumé audio (ou reprend celui qui attend) et le range dans le R2 : son adresse et sa durée, ou null si l'envoi a échoué. */
async function makeAudio(r: Report, key: string, upload: UploadFn): Promise<{ url: string; seconds: number } | null> {
  const kept = await audioWaiting(key);
  const mp3 = kept ?? (await renderReportAudio(r)).mp3;
  const id = createHash('sha256').update(mp3).digest('hex').slice(0, 32) + '.mp3';
  if (await upload(mp3, 'audio/mpeg', id)) {
    await fsp.rm(audioWaitFile(key), { force: true }).catch(() => undefined);
    return { url: `/media/${id}`, seconds: mp3Seconds(mp3) };
  }
  if (!kept) await keepAudio(key, mp3).catch(() => undefined);
  return null;
}

/**
 * Fabrique le résumé audio d'un rapport EN DEHORS du passage de publication (une minute ou plus : le passage ne
 * l'attend pas). À la fin, le résultat est retenu et un passage
 * repart : il publie le rapport avec son résumé audio et lance le suivant.
 */
function startAudio(r: Report, key: string, upload: UploadFn, log: (s: string) => void) {
  audioBusy = true;
  audioStartedAt = Date.now();
  // un MP3 qui attend son envoi repart sans appel à Claude : il ne compte pas dans le plafond du jour
  if (!fs.existsSync(audioWaitFile(key))) store.audioDay = { day: audioToday(), n: (store.audioDay?.day === audioToday() ? store.audioDay.n : 0) + 1 };
  void (async () => {
    let entry: NonNullable<Stored['audios']>[string];
    try {
      const audio = await makeAudio(r, key, upload);
      // envoi refusé : nouvel essai dans 1 h, avec le MP3 gardé (pas un nouvel appel à Claude)
      entry = audio ? { key, audio } : { key, audio: null, at: Date.now() - 5 * 3_600_000 };
      log(audio ? `résumé audio fait : ${r.id} (${audio.seconds} s)` : `résumé audio non envoyé : ${r.id}`);
      audioResult(!!audio, log);
    } catch (e) {
      entry = { key, audio: null, at: Date.now() };
      log(`résumé audio impossible : ${r.id} : ${(e as Error).message.split('\n')[0]}`);
      audioResult(false, log);
    }
    (store.audios ??= {})[r.id] = entry;
    audioBusy = false;
    await save();
    soon = true;
    setTimeout(publishSoon, Math.max(0, AUDIO_GAP_MS - (Date.now() - audioStartedAt)) + 1000).unref();
  })();
}

/**
 * Imprime le rapport (Chromium) et range le PDF dans le R2 : son adresse /media/<id>.pdf, ou null si l'envoi a
 * échoué (retenté au passage suivant). Lève une erreur si Chromium échoue.
 */
async function makePdf(r: Report, upload: UploadFn): Promise<string | null> {
  const urls = new Set([...r.body.matchAll(/\]\((\/media\/[0-9a-f]{32}\.(?:jpg|png|webp))\)/g)].map((m) => m[1]));
  if (r.cover) urls.add(r.cover);
  const images = new Map<string, PdfImage>();
  const tmp: string[] = [];
  try {
    for (const u of urls) {
      const file = localOf.get(u);
      if (!file) continue;
      let st: fs.Stats;
      try { st = await fsp.stat(file); } catch { continue; }
      const d = await imageDims(file, st);
      if (!d) continue;
      let src = file;
      let size: { w: number; h: number } | null = d;
      // une image très lourde : la version réduite (par la largeur) envoyée au Bureau, avec SA taille (les coupes en dépendent)
      if (st.size > MAX_IMAGE_BYTES) {
        const img = await readImage(file, st);
        if (!img) continue;
        src = path.join(WORK_DIR, `report-pdf-${process.pid}-${++pdfSeq}.${img.ext}`);
        await fsp.writeFile(src, img.body, { mode: 0o600 });
        tmp.push(src);
        size = await imageDims(src);
        if (!size) continue;
      }
      images.set(u, { src: pathToFileURL(src).href, width: size.w, height: size.h });
    }
    const pdf = await renderReportPdf(r, images, WORK_DIR);
    if (pdf.length > MAX_PDF_BYTES) throw new Error(`PDF trop lourd (${Math.round(pdf.length / 1e6)} Mo)`);
    const id = createHash('sha256').update(pdf).digest('hex').slice(0, 32) + '.pdf';
    return (await upload(pdf, 'application/pdf', id)) ? `/media/${id}` : null;
  } finally {
    for (const f of tmp) await fsp.rm(f, { force: true }).catch(() => undefined);
  }
}

/** range des rapports dans la vue Archivés ; renvoie le nombre rangé, ou null si l'envoi a échoué */
export type ArchiveNewFn = (ids: string[]) => Promise<number | null>;
/** la synthèse vivante d'un sujet : son dossier commence par « synthese- » */
export const isSynthesisId = (id: string) => id.startsWith('synthese-');
let archivePending: string[] = [];

/** les adresses #r=<id> citées par un rapport (liens vers un autre rapport du Bureau) */
export function refLinks(text: string): string[] {
  return [...new Set([...text.matchAll(/#r=([a-z0-9][a-z0-9-]{0,150})/g)].map((m) => m[1].replace(/-+$/, '')))];
}

export interface DeadLink { id: string; issue?: number; file: string; dead: string[] }
/** les liens #r= qui ne mènent à aucun rapport publié (archivé compris), par rapport qui les cite */
export function deadLinks(links: Map<string, { file: string; issue?: number; refs: string[] }>, ids: Set<string>): DeadLink[] {
  const out: DeadLink[] = [];
  for (const [id, l] of links) {
    const dead = l.refs.filter((r) => !ids.has(r));
    if (dead.length) out.push({ id, file: l.file, ...(l.issue ? { issue: l.issue } : {}), dead });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
const DEAD_FILE = path.join(path.dirname(FILE), 'liens-morts.json');
let deadSig: string | null = null;

/**
 * Publie les rapports qui ont changé, puis la liste ; retire ceux qui ont disparu. Renvoie le nombre de rapports en
 * ligne, ou null si un envoi a échoué (retenté au passage suivant). `persist` faux (essai) : rien n'est retenu.
 */
export async function publishReports(upload: UploadFn, put: PutFn, log: (s: string) => void = () => {}, persist = true,
  archiveNew?: ArchiveNewFn): Promise<number | null> {
  // une publication déjà en route : la suivante repart au tour suivant
  if (running) { soon = true; return null; }
  running = true;
  const before = JSON.stringify(store);
  try {
    const metas: ReportMeta[] = [];
    let failed = false;
    const ids = new Set<string>();
    /** rapports publiés pour la première fois dans ce passage */
    const fresh: string[] = [];
    let pdfBudget = PDF_PER_PASS;
    // un seul résumé audio à la fois, jamais pendant un essai (persist faux)
    const audioOpen = persist && !audioBusy && Date.now() - audioStartedAt >= AUDIO_GAP_MS && Date.now() >= audioPausedUntil
      && audioLeft() > 0 && audioReady();
    let audioNext: { r: Report; key: string } | null = null;
    const links = new Map<string, { file: string; issue?: number; refs: string[] }>();
    store.pdfs ??= {};
    store.audios ??= {};
    stage('rapports : recherche');
    for (const file of await findReports()) {
      await breathe();
      stage(`rapports : ${path.basename(path.dirname(file))}/${path.basename(file)}`);
      const r0 = await buildReport(file, upload);
      if (!r0 || ids.has(r0.id)) continue;
      ids.add(r0.id);
      try { const refs = refLinks(await fsp.readFile(file, 'utf8')).filter((x) => x !== r0.id); if (refs.length) links.set(r0.id, { file, ...(r0.issue ? { issue: r0.issue } : {}), refs }); } catch { /* relu au passage suivant */ }
      // le PDF net (Chromium), une fois par version visible du rapport
      const key = pdfKey(r0);
      const had = store.pdfs[r0.id];
      // même contenu : le PDF déjà fait reste servi, même d'une ancienne mise en page, jusqu'à ce qu'il soit refait
      let pdf = had?.key === key ? had.url : null;
      // une publication attend : plus de nouveau PDF dans ce passage (ils viendront au suivant)
      if (soon) pdfBudget = 0;
      const changed = had?.key !== key || (!had.url && Date.now() - (had.at ?? 0) > 6 * 3_600_000);
      // nouvelle mise en page seule : la moitié du budget au plus, le reste garde la priorité aux rapports modifiés (sans PDF)
      const relook = !changed && !!had?.url && (had.look ?? 1) !== PDF_LOOK && pdfBudget > PDF_PER_PASS / 2
        && Date.now() - (had.at ?? 0) > 6 * 3_600_000;
      if ((changed || relook) && pdfBudget > 0) {
        pdfBudget--;
        let timer: NodeJS.Timeout | undefined;
        try {
          // borné : Chromium ne doit jamais retenir la publication ; hors délai, il est fermé (le rendu s'arrête)
          pdf = await Promise.race([makePdf(r0, upload), new Promise<never>((_ok, ko) => { timer = setTimeout(() => ko(new Error('plus de 3 min')), 180_000); })]);
          if (pdf) { store.pdfs[r0.id] = { key, url: pdf, look: PDF_LOOK }; log(`PDF fait : ${r0.id}`); }
          // envoi refusé : nouvel essai dans 1 h (pas un rendu Chromium à chaque passage)
          // (une nouvelle mise en page ratée garde l’ancien PDF, nouvel essai 6 h après)
          else if (!relook) { store.pdfs[r0.id] = { key, url: null, at: Date.now() - 5 * 3_600_000 }; log(`PDF non envoyé : ${r0.id}`); }
          else { pdf = had!.url; store.pdfs[r0.id] = { ...had!, at: Date.now() }; log(`PDF non envoyé : ${r0.id}`); }
        } catch (e) {
          if ((e as Error).message === 'plus de 3 min') await closePdfBrowser();
          // nouvelle mise en page ratée : l'ancien PDF reste servi, nouvel essai 6 h après
          if (relook) { pdf = had!.url; store.pdfs[r0.id] = { ...had!, at: Date.now() }; }
          else store.pdfs[r0.id] = { key, url: null, at: Date.now() };
          log(`PDF impossible : ${r0.id} : ${(e as Error).message.split('\n')[0]}`);
        } finally { clearTimeout(timer); }
      }
      // le résumé audio, une fois par version du texte ; un texte modifié n'est plus servi avec l'ancien son
      const akey = audioKey(r0);
      const ahad = store.audios[r0.id];
      const audio = ahad?.key === akey ? ahad.audio : null;
      if (audioOpen && r0.words >= AUDIO_MIN_WORDS && Date.now() - r0.updatedAt > AUDIO_QUIET_MS
        && (ahad?.key !== akey || (!ahad.audio && Date.now() - (ahad.at ?? 0) > 6 * 3_600_000))
        && (!audioNext || audioRank(r0) > audioRank(audioNext.r))) audioNext = { r: r0, key: akey };
      const r: Report = { ...r0, ...(pdf ? { pdf } : {}), ...(audio ? { audio } : {}) };
      const { body: _body, ...meta } = r;
      if (store.sent[r.id] !== r.sig || (store.metas[r.id]?.pdf ?? null) !== (pdf ?? null)
        || (store.metas[r.id]?.audio?.url ?? null) !== (audio?.url ?? null)) {
        if (await put(r.id, JSON.stringify(r))) { if (!(r.id in store.sent)) fresh.push(r.id); store.sent[r.id] = r.sig; store.metas[r.id] = meta; log(`rapport publié : ${r.id} (${r.words} mots, ${r.images} images)`); }
        else {
          failed = true;
          // l'ancienne version reste en ligne : on la garde dans la liste
          if (store.metas[r.id]) metas.push(store.metas[r.id]);
          continue;
        }
      }
      metas.push(store.metas[r.id] ?? meta);
    }
    if (audioNext && (!soon || Date.now() - audioStartedAt > AUDIO_STARVE_MS)) startAudio(audioNext.r, audioNext.key, upload, log);
    // les liens #r= morts, au journal à chaque changement (et au premier passage), et dans liens-morts.json à côté du
    // suivi des envois
    const dead = deadLinks(links, ids);
    const dsig = JSON.stringify(dead);
    if (dsig !== deadSig) {
      deadSig = dsig;
      const n = dead.reduce((k, d) => k + d.dead.length, 0);
      log(`liens #r= morts : ${n} (${[...links.values()].reduce((k, l) => k + l.refs.length, 0)} liens dans ${links.size} rapports)`);
      for (const d of dead) log(`lien #r= mort${d.issue ? ` (#${d.issue})` : ''} : ${d.id} -> ${d.dead.join(', ')} (${path.relative(MISSIONS, d.file)})`);
      if (persist) { try { await fsp.writeFile(DEAD_FILE, JSON.stringify({ at: Date.now(), dead }, null, 1), { mode: 0o600 }); } catch { /* tant pis */ } }
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt);
    const index: ReportIndex = { at: Date.now(), reports: metas };
    const sig = createHash('sha256').update(JSON.stringify(metas)).digest('hex').slice(0, 16);
    if (sig !== store.indexSig) {
      if (await put('index', JSON.stringify(index))) store.indexSig = sig;
      else failed = true;
    }
    // un rapport par sujet : un nouveau rapport de détail part tout de suite dans la vue Archivés (sa synthèse
    // missions/synthese-<sujet>-… reste seule visible) ; jamais un rapport déjà archivé ou remis à la main
    // (un envoi raté est retenté au passage suivant)
    // seule la Trace (en-tête sans niveau compris) est rangée d'office : un « À lire » ou une « Référence » reste visible
    const levelById = new Map(metas.map((m) => [m.id, m.level]));
    archivePending = [...new Set([...archivePending, ...fresh.filter((id) => !isSynthesisId(id) && (levelById.get(id) ?? 'trace') === 'trace')])];
    if (archiveNew && archivePending.length && store.indexSig === sig) {
      const todo = archivePending;
      const n = await archiveNew(todo);
      if (n !== null) { archivePending = archivePending.filter((id) => !todo.includes(id)); if (n > 0) log(`rangés dans Archivés dès la publication : ${todo.join(', ')}`); }
    }
    // les rapports retirés (fichier supprimé, en-tête enlevé) : effacés du R2 dès que la liste est à jour
    if (store.indexSig === sig) {
      for (const id of Object.keys(store.sent)) {
        if (ids.has(id)) continue;
        if (await put(id, null)) { delete store.sent[id]; delete store.metas[id]; delete store.pdfs[id]; delete store.audios?.[id]; log(`rapport retiré : ${id}`); }
      }
    }
    if (persist) await save();
    else store = JSON.parse(before) as Stored;
    return failed ? null : metas.length;
  } finally {
    await closePdfBrowser();
    running = false;
  }
}
