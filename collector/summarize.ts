// Le résumé de tes demandes, pour le bloc « Ta demande » de la salle. Jamais le message complet :
//  - si la CLI `claude` est connectée, un résumé d'une ou deux phrases par Claude Haiku (sans outils, sans
//    session enregistrée), mis en cache sur disque ;
//  - sinon (ou en attendant), un extrait : le cœur du message, nettoyé, coupé à ~220 caractères.
// Dans les deux cas, le texte passe ensuite par le caviardage avant l'envoi.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../shared/live.ts';
import { safe, untilde } from './describe.ts';

const DIR = path.join(os.homedir(), '.config', 'bureau-collector');
const CACHE_FILE = path.join(DIR, 'summaries.json');
/** dossier de travail des appels à Haiku (ses sessions ne sont pas enregistrées, et ce dossier est ignoré par le collecteur) */
export const WORK_DIR = path.join(DIR, 'work');
export const MODEL = process.env.BUREAU_SUMMARY_MODEL || 'claude-haiku-5-5';
const MAX_CACHE = 5000;

const SYSTEM = 'Tu résumes la demande qu’une personne a faite à un agent de code. Réponds en français, en une ou deux phrases courtes '
  + '(220 caractères au plus), au tutoiement, en commençant par un verbe (« Construire… », « Corriger… »). Pas de préambule, '
  + 'pas de guillemets, pas de mise en forme, aucun secret, aucune adresse e-mail, aucun nom de client.';

let cache: Record<string, string> = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { /* premier lancement */ }
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const keys = Object.keys(cache);
    if (keys.length > MAX_CACHE) for (const k of keys.slice(0, keys.length - MAX_CACHE)) delete cache[k];
    try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), { mode: 0o600 }); } catch { /* tant pis */ }
  }, 2000);
}

/** Le cœur d'un message : sans les blocs techniques, sans le contexte d'une session qui en lance une autre. */
export function coreOf(text: string): string {
  let t = text
    .replace(/<(system-reminder|task-notification|local-command-\w+|command-\w+|ide_\w+)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/?(cross-session-message|pasted_content|scheduled-task)[^>]*>/g, ' ')
    .replace(/^Another Claude session sent a message:\s*/i, '')
    // le préambule standard d'une tâche planifiée (jusqu'à « …is the correct output. »)
    .replace(/This is an automated run of a scheduled task\.[\s\S]*?correct output\.\s*/i, '')
    .replace(/^\s*Contexte\s*:\s*/i, '')
    .replace(/This came from another Claude session[\s\S]*$/i, '');
  // un brief de session : le contexte d'abord, puis « Task: » ; on garde la tâche
  const task = /(?:^|\n)\s*Task:\s*\n?([\s\S]+)/.exec(t);
  if (task) t = task[1];
  // le gras et le code d'abord (sans toucher aux « _ » qui font partie des jetons), puis le caviardage, avant toute coupe
  t = redact(untilde(t.replace(/\*\*|`+/g, '')));
  return t.replace(/^#+\s*/gm, '').replace(/^\s*[-*]\s+/gm, '').replace(/\s+/g, ' ').trim();
}

/** L'extrait : les premières phrases, coupées proprement. */
export function excerpt(text: string, n = 220): string {
  const core = coreOf(text);
  if (core.length <= n) return safe(core, n);
  const cut = core.slice(0, n);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' ? '), cut.lastIndexOf(' : '));
  return safe(end > n * 0.5 ? cut.slice(0, end + 1) : cut, n);
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

let claudeBin: string | null | undefined;
export function findClaude(): string | null {
  if (claudeBin !== undefined) return claudeBin;
  const cands = [process.env.CLAUDE_BIN, path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  claudeBin = cands.find((c) => !!c && fs.existsSync(c)) ?? null;
  return claudeBin;
}

/**
 * L'environnement d'un appel à Haiku : celui du collecteur, donc la CLI `claude` telle que tu l'as connectée (ton
 * abonnement). BUREAU_COLLECTOR_SUMMARY=1 permet à tes hooks de reconnaître ces appels et de les laisser passer.
 */
export function haikuEnv(): NodeJS.ProcessEnv {
  return { ...process.env, BUREAU_COLLECTOR_SUMMARY: '1' };
}

let disabledUntil = 0;
let running = 0;
const queue: { key: string; core: string }[] = [];
const queued = new Set<string>();
let onDone: () => void = () => {};

export function onSummary(fn: () => void) { onDone = fn; }

/** Le résumé d'un message : celui de Haiku s'il est prêt, sinon l'extrait (et Haiku est mis en file). */
export function summarize(text: string, useAi: boolean): { text: string; kind: 'ia' | 'extrait' } {
  const core = coreOf(text).slice(0, 12_000);
  if (!core) return { text: '', kind: 'extrait' };
  const key = hash(core);
  if (cache[key]) return { text: cache[key], kind: 'ia' };
  if (useAi && core.length > 160 && !queued.has(key) && Date.now() > disabledUntil) { queued.add(key); queue.push({ key, core }); pump(); }
  return { text: excerpt(text), kind: 'extrait' };
}

function pump() {
  while (running < 2 && queue.length && Date.now() > disabledUntil) {
    const job = queue.pop()!; // les plus récents d'abord
    const bin = findClaude();
    if (!bin) { disabledUntil = Number.MAX_SAFE_INTEGER; return; }
    running++;
    fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
    const child = execFile(bin, ['-p', '--model', MODEL, '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--system-prompt', SYSTEM],
      { cwd: WORK_DIR, timeout: 60_000, maxBuffer: 1 << 20, env: haikuEnv() },
      (err, stdout, stderr) => {
        running--;
        queued.delete(job.key);
        const out = String(stdout ?? '').trim();
        if (err || !out || /failed to authenticate|oauth|please run|\/login|api error/i.test(out)) {
          // CLI pas connectée, limite d'usage… : on se contente des extraits pendant une heure
          if (/auth|login|expired|credit|limit/i.test(String(stderr) + out + String(err?.message ?? ''))) disabledUntil = Date.now() + 3600_000;
        } else {
          cache[job.key] = safe(out.replace(/\s+/g, ' '), 240);
          save();
          onDone();
        }
        pump();
      });
    child.stdin?.end(job.core);
  }
}
