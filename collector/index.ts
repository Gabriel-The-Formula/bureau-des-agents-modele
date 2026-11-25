// Le collecteur local du Bureau des agents (suivi en ligne).
// Il lit les transcriptions de Claude Code (~/.claude/projects), en tire un RÉSUMÉ par session
// (titre, statut, plan, sous-agents, compteurs) et des événements de bureau déjà caviardés,
// puis les envoie au Worker (POST /api/ingest). Zéro dépendance : Node 22.18+ lance ce fichier tel quel.
//
//   node collector/index.ts            boucle continue
//   node collector/index.ts --once     un seul passage, puis quitte
//   node collector/index.ts --dry      n'envoie rien : affiche les envois (JSON, un par ligne) sur stdout
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DONE_VISIBLE_MS, type DayStats, type IngestPayload, type IngestReply, type RoomEvent, type SessionSummary } from '../shared/live.ts';
import { safe, untilde } from './describe.ts';
import { SessionState, type DesktopMeta } from './session.ts';
import { WORK_DIR, onSummary } from './summarize.ts';
import { entriesSince, feedNotSent, feedPending, maybeAdd, pumpDigest, setSessionResolver, takeFeed, uploadMedia } from './feed.ts';
import { publishReports, takePublishSoon } from './reports.ts';
import { backfillThumbs, sendThumb } from './thumbs.ts';
import { TokenTotals } from './totals.ts';
import { dayOf } from './session.ts';
import { breathe, collectorLog, stage, startWatchdog } from './stall.ts';

type Json = Record<string, any>;

// ── Configuration ──

function readConfigFile(): Json {
  const file = path.join(os.homedir(), '.config', 'bureau-collector', 'config.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function machineName(): string {
  if (process.platform === 'darwin') {
    try { const n = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 3000 }).trim(); if (n) return n; } catch { /* repli */ }
  }
  return os.hostname().replace(/\.(local|home|lan)$/i, '');
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'machine';

const args = new Set(process.argv.slice(2));
const file = readConfigFile();
/** les clés du fichier de config : BUREAU_URL ou url, BUREAU_SOURCE_LABEL ou sourceLabel… */
const ALIAS: Record<string, string> = {
  BUREAU_URL: 'url', BUREAU_TOKEN: 'token', BUREAU_SOURCE_ID: 'sourceId', BUREAU_SOURCE_LABEL: 'sourceLabel',
  CLAUDE_PROJECTS_DIR: 'projectsDir', BUREAU_WINDOW_H: 'windowH', BUREAU_SNIPPETS: 'snippets', BUREAU_ENTRYPOINTS: 'entrypoints', BUREAU_HIDE_TITLES: 'hideTitles',
};
const conf = (k: string): string | undefined => {
  const v = process.env[k] ?? file[k] ?? file[ALIAS[k] ?? ''];
  return v === undefined || v === null || v === '' ? undefined : String(v);
};

const DRY = args.has('--dry');
const ONCE = args.has('--once');
const URL_BASE = (conf('BUREAU_URL') ?? '').replace(/\/+$/, '');
const TOKEN = conf('BUREAU_TOKEN') ?? '';
const SOURCE_ID = slug(conf('BUREAU_SOURCE_ID') ?? os.hostname().replace(/\.(local|home|lan)$/i, ''));
const SOURCE_LABEL = safe(conf('BUREAU_SOURCE_LABEL') ?? machineName(), 60);
const PROJECTS_DIR = conf('CLAUDE_PROJECTS_DIR') ?? path.join(os.homedir(), '.claude', 'projects');
const WINDOW_MS = Math.max(0.1, Number(conf('BUREAU_WINDOW_H') ?? 24)) * 3600_000;
/**
 * Les points d'entrée suivis. Par défaut tout, mais les sessions automatiques (sdk-cli, sdk-py : `claude -p`, scripts)
 * ne restent à l'étage que tant qu'elles travaillent. « claude-desktop,cli » pour ne garder que les sessions interactives.
 */
const ENTRYPOINTS = (conf('BUREAU_ENTRYPOINTS') ?? 'all').split(',').map((x) => x.trim()).filter(Boolean);
/** titres de sessions à ne jamais afficher (expression régulière) : par défaut, les revues de sécurité automatiques */
const HIDE_TITLES = new RegExp(conf('BUREAU_HIDE_TITLES') ?? '^Review this change for security', 'i');
/** le résumé de tes demandes dans la salle (BUREAU_SHARE_REQUEST=0 pour ne rien envoyer) ; BUREAU_AI_SUMMARY=0 pour l'extrait seul */
const SHARE_REQUEST = !['0', 'false', 'non', 'no'].includes((conf('BUREAU_SHARE_REQUEST') ?? '1').toLowerCase());
const AI_SUMMARY = !['0', 'false', 'non', 'no'].includes((conf('BUREAU_AI_SUMMARY') ?? '1').toLowerCase());
const SNIPPETS = !['0', 'false', 'non', 'no'].includes((conf('BUREAU_SNIPPETS') ?? '1').toLowerCase());

const SCAN_MS = 2000;
/** cadence d'envoi : toutes les 8 s quand quelqu'un regarde le bureau, toutes les 60 s sinon (en ligne, l'offre gratuite
 * de Cloudflare compte 100 000 requêtes Workers par jour) */
const SEND_LIVE_MS = 8000;
const SEND_IDLE_MS = 60_000;
/** sans spectateur, un signe de vie toutes les 30 s : un navigateur qui s'ouvre reçoit la liste fraîche en moins de 30 s */
const PING_MS = 30_000;
const PING_LIVE_MS = 8_000;
const pingEvery = () => (viewers ? PING_LIVE_MS : PING_MS);
/** la liste complète des salles (et le bandeau), toutes les 5 min, et dès que quelqu'un ouvre le bureau */
const FULL_MS = 5 * 60_000;
/** le cumul de jetons compte depuis BUREAU_TOTAL_SINCE (date ISO), sinon sur les 30 derniers jours */
const TOTAL_SINCE = conf('BUREAU_TOTAL_SINCE') ? new Date(conf('BUREAU_TOTAL_SINCE')!).getTime() : Date.now() - 30 * 86_400_000;
const EXPECTED_SOURCES = Math.max(1, Number(conf('BUREAU_EXPECTED_SOURCES') ?? 1));
const EVENTS_PER_POST = 3000;
/** rattrapage : événements gardés par salle (récente / ancienne) */
const CATCHUP_RECENT = 150;
const CATCHUP_OLD = 40;
const RECENT_MS = 3 * 3600_000;
/** plafond global de la file d'événements (en cas de panne réseau) */
const QUEUE_MAX = 20_000;

if (!DRY && (!URL_BASE || !TOKEN)) {
  console.error('[bureau] BUREAU_URL et BUREAU_TOKEN sont requis (variables d’environnement ou ~/.config/bureau-collector/config.json). Ajoute --dry pour tester sans envoyer.');
  process.exit(1);
}

const log = (s: string) => console.error(`[bureau ${new Date().toLocaleTimeString('fr-FR')}] ${s}`);

/** Une salle part au bureau si son point d'entrée est suivi, et (si elle est terminée) pas depuis trop longtemps. */
/** Une vraie session de travail (pas un script jetable, une revue de sécurité automatique ou un appel de résumé). */
function real(s: SessionState): boolean {
  if (!s.hasAssistant) return false;
  if (!ENTRYPOINTS.includes('all') && !ENTRYPOINTS.includes(s.entrypoint)) return false;
  // les sessions lancées dans un dossier temporaire (revues de sécurité, scripts jetables) ne sont pas des salles
  if (/^\/(?:private\/)?(?:tmp|var\/folders)\b/.test(s.cwd) || s.cwd.startsWith(WORK_DIR)) return false;
  return !(s.entrypoint.startsWith('sdk') && HIDE_TITLES.test(s.title()));
}

function shown(s: SessionState, now: number): boolean {
  if (!real(s)) return false;
  const automatic = s.entrypoint.startsWith('sdk');
  if (s.status === 'done') return !automatic && now - s.lastActivity < DONE_VISIBLE_MS;
  return true;
}

// ── Découverte des sessions ──

const sessions = new Map<string, SessionState>();
const dirMtimes = new Map<string, number>();
const removed = new Set<string>();
const totals = new TokenTotals(TOTAL_SINCE, PROJECTS_DIR);
/** navigateurs ouverts sur le bureau (renvoyé par le Worker à chaque envoi) */
let viewers = 0;
let lastSendAt = 0;
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Passe sur les dossiers de projets. full = stat de tous les fichiers ; sinon seulement les dossiers qui ont bougé. */
async function discover(full: boolean, now: number): Promise<SessionState[]> {
  const fresh: SessionState[] = [];
  let dirs: string[];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { log(`dossier introuvable : ${untilde(PROJECTS_DIR)}`); return fresh; }
  for (const d of dirs) {
    // profil du 4/11 (charge 45) : 1 120 dossiers puis leurs milliers de fichiers lus d'un bloc = 7 à 18 s figées ;
    // la main est rendue toutes les 50 ms, dans chaque boucle
    await breathe();
    const dir = path.join(PROJECTS_DIR, d);
    let st: fs.Stats;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (!full && dirMtimes.get(dir) === st.mtimeMs) continue;
    dirMtimes.set(dir, st.mtimeMs);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    await breathe();
    for (const n of names) {
      await breathe();
      const m = SESSION_FILE.exec(n);
      if (!m || sessions.has(m[1])) continue;
      const f = path.join(dir, n);
      let fst: fs.Stats;
      try { fst = fs.statSync(f); } catch { continue; }
      if (fst.size === 0 || now - fst.mtimeMs > WINDOW_MS) continue;
      const s = new SessionState(f, m[1], { sourceId: SOURCE_ID, snippets: SNIPPETS, eventCap: CATCHUP_RECENT, shareRequest: SHARE_REQUEST, aiSummary: AI_SUMMARY });
      sessions.set(m[1], s);
      fresh.push(s);
    }
  }
  return fresh;
}

// ── Ce que l'app desktop sait des sessions (titre, archivage, session parente) ──
// Fichiers ~/Library/Application Support/Claude/claude-code-sessions/<compte>/<organisation>/local_<id>.json :
// on n'en lit que l'identifiant de transcription (cliSessionId), le titre, l'archivage et spawnedFrom.

const DESKTOP_DIR = conf('CLAUDE_DESKTOP_SESSIONS_DIR') ?? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const desktopMtimes = new Map<string, number>();
const desktopByCli = new Map<string, DesktopMeta>();
const cliOfLocal = new Map<string, string>();
let lastDesktopScan = 0;

async function scanDesktop(now: number) {
  if (now - lastDesktopScan < 10_000) return;
  lastDesktopScan = now;
  const files: string[] = [];
  try {
    for (const acc of fs.readdirSync(DESKTOP_DIR)) {
      const a = path.join(DESKTOP_DIR, acc);
      let orgs: string[] = [];
      try { orgs = fs.readdirSync(a); } catch { continue; }
      for (const org of orgs) {
        await breathe();
        const o = path.join(a, org);
        let names: string[] = [];
        try { names = fs.readdirSync(o); } catch { continue; }
        for (const n of names) if (/^local_[\w-]+\.json$/.test(n)) files.push(path.join(o, n));
      }
    }
  } catch { return; }
  for (const f of files) {
    await breathe();
    let st: fs.Stats;
    try { st = fs.statSync(f); } catch { continue; }
    if (now - st.mtimeMs > WINDOW_MS * 2 || desktopMtimes.get(f) === st.mtimeMs) continue;
    desktopMtimes.set(f, st.mtimeMs);
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const cli = typeof d.cliSessionId === 'string' ? d.cliSessionId : '';
      const local = typeof d.sessionId === 'string' ? d.sessionId : '';
      if (!cli || !local) continue;
      const meta: DesktopMeta = { localId: local, archived: !!d.isArchived };
      if (typeof d.title === 'string' && d.title) meta.title = d.title;
      if (typeof d.spawnedFrom?.sessionId === 'string') meta.parentLocalId = d.spawnedFrom.sessionId;
      desktopByCli.set(cli, meta);
      cliOfLocal.set(local, cli);
    } catch { /* fichier en cours d'écriture : on le relira */ }
  }
}

/** Rattache à chaque salle ses infos desktop, sa salle parente et ses salles enfants. */
function linkSessions() {
  const children = new Map<string, string[]>();
  for (const s of sessions.values()) {
    s.desktop = desktopByCli.get(s.sessionId) ?? null;
    const parentCli = s.desktop?.parentLocalId ? cliOfLocal.get(s.desktop.parentLocalId) : undefined;
    const parent = parentCli ? sessions.get(parentCli) : undefined;
    const parentKey = parent && parent !== s ? parent.key : undefined;
    if (parentKey !== s.parentKey) { s.parentKey = parentKey; s.dirty = true; }
    if (parent && parentKey) children.set(parent.sessionId, [...(children.get(parent.sessionId) ?? []), s.key]);
  }
  for (const s of sessions.values()) {
    const kids = (children.get(s.sessionId) ?? []).sort();
    if (kids.join() !== s.childKeys.join()) { s.childKeys = kids; s.dirty = true; }
  }
}

// le fil des réalisations retrouve une session finie pour refaire son résumé : en mémoire, sinon en relisant sa
// transcription (une fois, pour les entrées résumées avant le détail et les décisions)
const RELOAD_MAX_BYTES = 40 * 1024 * 1024;
setSessionResolver((key) => {
  if (!key.startsWith(SOURCE_ID + ':')) return null;
  stage('fil : relecture d’une ancienne session');
  const id = key.slice(SOURCE_ID.length + 1);
  const live = sessions.get(id);
  if (live) return live;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const f = path.join(PROJECTS_DIR, d, `${id}.jsonl`);
      let st: fs.Stats;
      try { st = fs.statSync(f); } catch { continue; }
      if (st.size > RELOAD_MAX_BYTES) return null;
      const s = new SessionState(f, id, { sourceId: SOURCE_ID, snippets: false, eventCap: 1, shareRequest: false, aiSummary: false });
      s.update();
      return s;
    }
  } catch { /* dossier illisible */ }
  return null;
});

// un résumé de Haiku vient d'arriver : les salles le reprendront au prochain envoi
onSummary(() => { for (const s of sessions.values()) if (s.hasAssistant) s.dirty = true; });

// ── Un passage ──

let lastFullDiscover = 0;

// le passage rend la main toutes les 50 ms (breathe) : 3 000 sessions relues d'un bloc figeaient la boucle (premier
// passage 45 à 193 s), et avec elle les clics du Bureau, l'envoi et les délais des commandes gh
async function scan(now: number) {
  const full = now - lastFullDiscover >= FULL_MS;
  if (full) lastFullDiscover = now;
  stage(full ? 'passage : découverte complète' : 'passage : découverte');
  const fresh = new Set(await discover(full, now));
  stage('passage : lecture des transcriptions');
  for (const s of sessions.values()) { s.update(); await breathe(); }
  stage('passage : app desktop');
  await scanDesktop(now);
  linkSessions();
  stage('passage : salles');
  // rattrapage d'historique : seulement les derniers événements de chaque salle, avec leur vraie date
  for (const s of fresh) { s.trimOutbox(now - s.lastActivity < RECENT_MS ? CATCHUP_RECENT : CATCHUP_OLD); await breathe(); }
  for (const [id, s] of sessions) {
    await breathe();
    if (now - Math.max(s.reader.mtime, s.lastActivity) > WINDOW_MS) {
      sessions.delete(id);
      if (s.hasAssistant) removed.add(s.key);
      continue;
    }
    s.refreshStatus(now);
    if (real(s)) maybeAdd(s);
  }
  // plafond global de la file : on rogne les salles les moins récentes
  let total = 0;
  for (const s of sessions.values()) total += s.outbox.length;
  if (total > QUEUE_MAX) {
    const byAge = [...sessions.values()].sort((a, b) => a.lastActivity - b.lastActivity);
    for (const s of byAge) {
      if (total <= QUEUE_MAX) break;
      const drop = Math.min(s.outbox.length, total - QUEUE_MAX);
      s.outbox.splice(0, drop);
      total -= drop;
    }
  }
}

// ── Envoi ──

let lastFullSend = 0;
let failures = 0;
let nextSendAt = 0;

/** Dernier filet : aucun chemin personnel ne doit rester dans le JSON envoyé. */
function scrubPayload(p: IngestPayload): string {
  return JSON.stringify(p, (_k, v) => (typeof v === 'string' ? untilde(v) : v));
}

/** Le bandeau du jour : tâches cochées, sessions finies et coût du jour (toutes sessions). */
function dayStats(now: number): DayStats {
  const day = dayOf(now);
  let tasksDone = 0; let sessionsDone = 0; let cost = 0; let partial = false;
  for (const s of sessions.values()) {
    if (!real(s)) continue;
    tasksDone += s.doneByDay.get(day) ?? 0;
    cost += s.costByDay.get(day) ?? 0;
    if (s.unknownDays.has(day)) partial = true;
  }
  sessionsDone = entriesSince(day);
  const d: DayStats = { day, tasksDone, sessionsDone, cost: Math.round(cost * 100) / 100 };
  if (partial) d.costPartial = true;
  d.total = { ...totals.value, sources: 1, expectedSources: EXPECTED_SOURCES };
  return d;
}

/** Envoie une capture au Worker (rangée dans le R2 privé). */
async function uploadOne(body: Buffer, type: string, id: string): Promise<boolean> {
  const ok = await putMedia(body, type, id, false);
  // le PDF d'un rapport n'a pas de vignette
  if (ok && type.startsWith('image/')) await sendThumb(body, id, putMedia).catch(() => undefined);
  return ok;
}
/** Range une capture, ou sa vignette (thumb), dans le R2 privé. */
async function putMedia(body: Buffer, type: string, id: string, thumb: boolean): Promise<boolean> {
  if (DRY) return true;
  try {
    const res = await fetch(`${URL_BASE}/api/media/${id}${thumb ? '?thumb=1' : ''}`, {
      method: 'PUT', headers: { 'content-type': type, authorization: `Bearer ${TOKEN}` }, body: new Uint8Array(body), signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) { log(`capture refusée : HTTP ${res.status}`); return false; }
    return true;
  } catch (e) { log(`capture impossible : ${(e as Error).message}`); return false; }
}
/** Range un rapport long (ou la liste, « index ») sur le Worker, ou l'efface (json null). */
async function putReport(name: string, json: string | null): Promise<boolean> {
  if (DRY) return true;
  try {
    const res = await fetch(`${URL_BASE}/api/reports/${name}.json`, {
      method: json === null ? 'DELETE' : 'PUT',
      headers: { ...(json === null ? {} : { 'content-type': 'application/json' }), authorization: `Bearer ${TOKEN}` },
      ...(json === null ? {} : { body: json }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) { log(`rapport refusé (${name}) : HTTP ${res.status}`); return false; }
    return true;
  } catch (e) { log(`rapport impossible (${name}) : ${(e as Error).message}`); return false; }
}
/**
 * Range dans la vue Archivés les rapports jamais vus par l'archive (ni archivés ni remis à la main : un rapport
 * remis à la main ou par un agent reste visible). Renvoie le nombre rangé, ou null si l'envoi a échoué.
 */
async function archiveNewReports(ids: string[]): Promise<number | null> {
  if (DRY) return 0;
  try {
    const res = await fetch(`${URL_BASE}/api/reports-archive.json`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) { log(`archive illisible : HTTP ${res.status}`); return null; }
    const known = ((await res.json()) as { items?: Record<string, unknown> }).items ?? {};
    const todo = ids.filter((id) => !(id in known));
    if (!todo.length) return 0;
    const post = await fetch(`${URL_BASE}/api/reports-archive.json`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ids: todo, archived: true }), signal: AbortSignal.timeout(30_000),
    });
    if (!post.ok) { log(`archivage refusé : HTTP ${post.status}`); return null; }
    return todo.length;
  } catch (e) { log(`archivage impossible : ${(e as Error).message}`); return null; }
}
/** les rapports longs : relus toutes les 5 min (seuls ceux qui ont changé repartent) */
const REPORTS_MS = 5 * 60_000;
let lastReportsAt = 0;

let lastMediaAt = 0;
let mediaRunning = false;

async function post(body: string): Promise<boolean> {
  if (DRY) { process.stdout.write(body + '\n'); return true; }
  try {
    const res = await fetch(`${URL_BASE}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) { log(`envoi refusé : HTTP ${res.status}`); return false; }
    try {
      const r = (await res.json()) as Partial<IngestReply>;
      const was = viewers;
      viewers = Number(r.viewers ?? 0);
      // quelqu'un vient d'ouvrir le bureau : liste complète et bandeau tout de suite
      if (!was && viewers) lastFullSend = 0;
      // le Worker vient de redémarrer sans notre liste complète : tout repart au prochain passage
      if (r.cold) { lastFullSend = 0; feedNotSent(); }
    } catch { /* ancienne version du Worker */ }
    return true;
  } catch (e) {
    log(`envoi impossible : ${(e as Error).name === 'TimeoutError' ? 'délai dépassé' : (e as Error).message}`);
    return false;
  }
}

/** Envoie ce qui a changé (ou tout, toutes les 60 s). Renvoie vrai s'il reste des événements à envoyer. */
let lastFeedAt = 0;
let lastPingAt = 0;

async function flush(now: number, catchUp = false): Promise<boolean> {
  if (now < nextSendAt) return false;
  if (!catchUp && !DRY && now - lastSendAt < (viewers ? SEND_LIVE_MS : SEND_IDLE_MS) && now - lastFullSend < FULL_MS) {
    // personne ne regarde : seulement un signe de vie de temps en temps, dont la réponse dit si quelqu'un vient
    // d'ouvrir le bureau (la liste complète part alors au passage suivant, au lieu d'attendre la minute)
    if (now - Math.max(lastPingAt, lastSendAt) >= pingEvery()) {
      lastPingAt = now;
      await post(JSON.stringify({ source: { id: SOURCE_ID, label: SOURCE_LABEL }, sessions: [], events: [] } satisfies IngestPayload));
    }
    return false;
  }
  const visible = [...sessions.values()].filter((s) => s.hasAssistant && shown(s, now));
  const full = now - lastFullSend >= FULL_MS;
  const toSend = full ? visible : visible.filter((s) => s.dirty);
  // les événements : les salles les plus récentes d'abord, dans l'ordre chronologique de chaque salle
  const events: RoomEvent[] = [];
  const taken = new Map<SessionState, number>();
  for (const s of [...visible].sort((a, b) => b.lastActivity - a.lastActivity)) {
    if (!s.outbox.length) continue;
    if (events.length >= EVENTS_PER_POST) break;
    s.outbox.sort((a, b) => a.at - b.at);
    const n = Math.min(s.outbox.length, EVENTS_PER_POST - events.length);
    events.push(...s.outbox.slice(0, n));
    taken.set(s, n);
    if (!toSend.includes(s)) toSend.push(s);
  }
  if (!full && !(feedPending() && now - lastFeedAt > 60_000) && !toSend.length && !events.length && !removed.size) {
    // rien de neuf : un signe de vie de temps en temps (sa réponse dit si quelqu'un regarde)
    if (!DRY && now - Math.max(lastPingAt, lastSendAt) >= pingEvery()) {
      lastPingAt = now;
      await post(JSON.stringify({ source: { id: SOURCE_ID, label: SOURCE_LABEL }, sessions: [], events: [] } satisfies IngestPayload));
    }
    return false;
  }
  const summaries: SessionSummary[] = [];
  for (const s of toSend) { summaries.push(s.summary()); await breathe(); }
  const payload: IngestPayload = { source: { id: SOURCE_ID, label: SOURCE_LABEL }, sessions: summaries, events };
  if (full) payload.full = true;
  if (full) payload.day = dayStats(now);
  // le fil part avec l'envoi complet, ou dès qu'il change (au plus une fois par minute : écritures du Durable Object)
  const feed = full || now - lastFeedAt > 60_000 ? takeFeed() : null;
  if (feed) lastFeedAt = now;
  if (feed) payload.feed = feed;
  if (removed.size) payload.removed = [...removed];
  const ok = await post(scrubPayload(payload));
  if (!ok) {
    if (feed) feedNotSent();
    failures++;
    nextSendAt = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(failures, 5));
    return false;
  }
  if (failures) log('envoi rétabli');
  failures = 0;
  nextSendAt = 0;
  for (const [s, n] of taken) s.outbox.splice(0, n);
  for (const s of toSend) s.markSent();
  removed.clear();
  if (full) lastFullSend = now;
  lastSendAt = now;
  // les captures partent à côté, sans retenir les envois (le rattrapage des anciennes réalisations peut durer)
  if (!mediaRunning && now - lastMediaAt > 30_000) {
    lastMediaAt = now; mediaRunning = true;
    void uploadMedia(sessions, uploadOne).catch((e) => log(`captures : ${(e as Error).message}`)).finally(() => { mediaRunning = false; });
  }
  return [...sessions.values()].some((s) => s.hasAssistant && s.outbox.length > 0);
}

// ── Boucle ──

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // « --reports » : publier les rapports longs une fois, sans suivre les sessions
  if (args.has('--reports')) {
    const n = await publishReports(uploadOne, putReport, log, !DRY, archiveNewReports);
    log(n === null ? 'rapports : envoi incomplet' : `rapports : ${n} en ligne`);
    if (n === null) process.exitCode = 1;
    return;
  }
  // « --thumbs » : une vignette pour chaque capture déjà en ligne qui n'en a pas
  if (args.has('--thumbs')) {
    const n = await backfillThumbs(URL_BASE, TOKEN, putMedia, log);
    log(`vignettes : ${n} envoyées`);
    return;
  }
  startWatchdog(collectorLog());
  const t0 = Date.now();
  await scan(t0);
  const visible = [...sessions.values()].filter((s) => s.hasAssistant);
  const evs = visible.reduce((n, s) => n + s.outbox.length, 0);
  log(`source « ${SOURCE_LABEL} » (${SOURCE_ID}) : ${visible.length} sessions sur ${Math.round(WINDOW_MS / 3600_000)} h, ${evs} événements, premier passage en ${((Date.now() - t0) / 1000).toFixed(1)} s${DRY ? ' (essai, rien n’est envoyé)' : ''}`);
  if (ONCE) await totals.refresh();
  else void totals.refresh();
  let lastTotals = Date.now();
  if (ONCE) {
    // tout vider, par paquets
    for (let i = 0; i < 1000; i++) {
      const more = await flush(Date.now(), true);
      if (failures) { log('arrêt : envoi impossible'); process.exitCode = 1; break; }
      if (!more) break;
    }
    return;
  }
  for (;;) {
    const started = Date.now();
    stage('envoi');
    let more = await flush(started);
    // tant qu'il reste des événements (rattrapage), on renvoie un paquet à chaque tour
    while (more && Date.now() - started < SCAN_MS) more = await flush(Date.now(), true);
    stage('résumés');
    pumpDigest();
    // un résumé audio vient d'être fait : les rapports repartent tout de suite
    if (Date.now() - lastReportsAt > REPORTS_MS || takePublishSoon()) {
      lastReportsAt = Date.now();
      void publishReports(uploadOne, putReport, log, !DRY, archiveNewReports).catch((e) => log(`rapports : ${(e as Error).message}`));
    }
    if (Date.now() - lastTotals > 30_000) { lastTotals = Date.now(); void totals.refresh(); }
    stage('attente (rappel asynchrone non marqué)');
    await sleep(Math.max(200, SCAN_MS - (Date.now() - started)));
    try { await scan(Date.now()); } catch (e) { log(`erreur de lecture : ${(e as Error).message}`); }
  }
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main().catch((e) => { log(`arrêt : ${(e as Error).message}`); process.exit(1); });
