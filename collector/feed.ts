// Le fil des réalisations : une entrée par session terminée (plan coché à 100 %, ou fin de travail annoncée sans
// question), avec un résumé de ce qui a été fait, ses liens (PR, artefacts), ses fichiers livrés et ses captures.
// Gardé sur disque (~/.config/bureau-collector/feed.json, 30 jours) : le collecteur ne lit que 24 h de transcriptions.
// Les captures sont envoyées au Worker (POST /api/media, même jeton), rangées dans un R2 privé et servies seulement
// derrière la connexion (/media/<id>).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CATEGORY_LABELS, redact, type Decision, type FeedCategory, type FeedEntry } from '../shared/live.ts';
import { firstSentence, safe } from './describe.ts';
import { clean, type SessionState } from './session.ts';
import { MODEL, WORK_DIR, coreOf, excerpt, findClaude, haikuEnv } from './summarize.ts';
import { breathe, stage } from './stall.ts';

const FILE = path.join(os.homedir(), '.config', 'bureau-collector', 'feed.json');
const KEEP_MS = 30 * 24 * 3600_000;
const MAX_ENTRIES = 400;
const MAX_MEDIA = 8;
const MEDIA_MIN_BYTES = 15_000;
const MEDIA_MAX_BYTES = 3_000_000;
/** au-delà, l'image est réduite (1600 px de large, JPEG) avant l'envoi */
const MEDIA_SHRINK_BYTES = 700_000;
/** version de la collecte des captures : une entrée collectée par une version plus ancienne est recollectée une fois */
const MEDIA_V = 2;

/**
 * src : le texte source de chaque entrée (titre, demande, compte rendu, tâches), gardé sur le Mac seulement, pour le
 * résumé par Haiku ; jamais envoyé. tried : nombre d'essais de résumé par entrée.
 */
interface Stored {
  entries: FeedEntry[]; uploaded: Record<string, string>; src: Record<string, string>; tried: Record<string, number>;
  /** version du résumé par entrée, et essais de le refaire à la nouvelle version */
  v: Record<string, number>; retried: Record<string, number>;
  /** version de la collecte des captures par entrée */
  mv: Record<string, number>;
}

let store: Stored = { entries: [], uploaded: {}, src: {}, tried: {}, v: {}, retried: {}, mv: {} };
try { store = { ...store, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* premier lancement */ }
let changed = true;

function save() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 }); fs.writeFileSync(FILE, JSON.stringify(store), { mode: 0o600 }); } catch { /* tant pis */ }
}

// ── Catégorie et intérêt ──

// Le classement de secours (avant le résumé par Haiku, ou sans lui), par mots-clés. À adapter à ton activité, avec
// FeedCategory et CATEGORY_LABELS (shared/live.ts) et la consigne DIGEST_SYSTEM plus bas.
const CATS: [FeedCategory, RegExp][] = [
  ['organisation', /claude code|\bagents?\b|bureau des agents|automatisation|organisation|planning/i],
  ['contenu', /\bposts?\b|contenu|vid[ée]o|youtube|newsletter|article|blog|carrousel|infographi/i],
  ['recherche', /recherche|analyse|[ée]tude|benchmark|concurren|veille|comparatif|rapport/i],
  ['business', /\boffres?\b|tarifs?|\bprix\b|paiement|factur|clients?|ventes?|prospect|marketing|\bpubs?\b|\bseo\b|landing/i],
  ['code', /\bcode\b|\bbug\b|\bapi\b|front|backend|composant|\btests?\b|d[ée]ploie|\bpr\b|application|\bapp\b|site/i],
];

/** La catégorie de secours : d'après le sujet (titre et compte rendu), puis d'après le projet ou le dossier. */
export function categoryOf(subject: string, place = ''): FeedCategory {
  for (const [c, re] of CATS) if (re.test(subject)) return c;
  for (const [c, re] of CATS) if (re.test(place)) return c;
  return 'autre';
}

/** Maintenance, sécurité, CI, refactor, relecture de PR : masqué par défaut. */
const BORING = /relire et int[ée]grer|int[ée]grer la PR|s[ée]curit[ée]|vuln|\bCI\b|pipeline|refactor|lint|d[ée]pendanc|dependabot|maintenance|m[ée]nage|nettoyage|purge|sauvegarde|backup|typecheck|tests? (unitaires|e2e)|flaky|monitoring|revue de code|code review/i;

// ── Construction d'une entrée ──

export function entryOf(s: SessionState, at: number): FeedEntry {
  const sum = s.summary();
  const title = sum.title;
  const recap = clean(s.recap ? excerpt(s.recap, 320) : s.lastChefText ? excerpt(s.lastChefText, 260) : '');
  const links: FeedEntry['links'] = [];
  if (sum.prUrl) links.push({ label: prLabel(sum.prUrl), url: sum.prUrl });
  for (const u of s.links) {
    if (links.some((l) => l.url === u)) continue;
    links.push({ label: u.includes('/pull/') ? prLabel(u) : 'Artefact', url: u });
  }
  const files = [...s.files].map((f) => safe(f, 60)).slice(0, 8);
  const subject = `${title} ${recap}`;
  const place = [sum.project, sum.worktree, s.cwd].join(' ');
  const tasks = s.plan.filter((p) => p.status === 'completed').length;
  const hasResult = !!(recap || links.length || files.length || tasks);
  // le texte source du résumé par Haiku (gardé sur le Mac)
  store.src[s.key] = sourceOf(s);
  const entry: FeedEntry = {
    key: s.key,
    title,
    at,
    category: categoryOf(subject, place),
    interesting: hasResult && !BORING.test(`${title} ${recap}`),
    summary: recap || (tasks ? firstSentence(s.plan.map((p) => p.text).join('. '), 200) : ''),
    links: links.slice(0, 6),
    files,
    media: [],
    cost: sum.cost,
    tasks,
  };
  return entry;
}

const prLabel = (u: string) => `PR ${u.split('/').slice(-3, -2)[0]} #${u.split('/').pop()}`;

/**
 * Le texte source du résumé par Haiku : la demande, le compte rendu, le dernier message (souvent le rapport complet),
 * les tâches et la dernière question posée avec ses choix. Gardé sur le Mac seulement, jamais envoyé.
 */
function sourceOf(s: SessionState): string {
  const d = s.lastDecision;
  const last = s.lastChefText && s.lastChefText !== s.recap ? s.lastChefText : '';
  return [
    `Titre de la session : ${s.summary().title}`,
    s.requestText ? `Demande : ${coreOf(s.requestText).slice(0, 1500)}` : '',
    s.recap ? `Compte rendu : ${redact(s.recap.slice(0, 2000))}` : '',
    last ? `Dernier message de l'agent : ${redact(last.slice(0, 3500))}` : '',
    s.plan.length ? `Tâches : ${s.plan.map((p) => `${p.status === 'completed' ? '[fait]' : '[pas fait]'} ${p.text}`).join(' ; ').slice(0, 1200)}` : '',
    d ? `Question posée : ${d.question}${d.options.length ? ` Choix proposés : ${d.options.map((o) => (o.effect ? `${o.label} (${o.effect})` : o.label)).join(' ; ')}` : ''}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Pour les entrées résumées avant le détail (fait / résultats / reste) : retrouve leur session (en mémoire, sinon en
 * relisant sa transcription) et refait le texte source. Réglé par index.ts.
 */
let resolveSession: (key: string) => SessionState | null = () => null;
export function setSessionResolver(fn: (key: string) => SessionState | null) { resolveSession = fn; }

/** Une session terminée entre dans le fil (une seule fois). */
export function maybeAdd(s: SessionState): boolean {
  if (s.status !== 'done' || !s.hasAssistant) return false;
  if (store.entries.some((e) => e.key === s.key)) return false;
  const finished = s.planComplete || (!!s.recap && s.statusText !== 'Archivée') || !!s.summary().prUrl;
  if (!finished) return false;
  store.entries.push(entryOf(s, s.lastActivity));
  changed = true;
  return true;
}

interface Upload { body: Buffer; type: string; ext: string; label?: string }

const IMG_FILE = /\.(png|jpe?g|webp)$/i;
/** « avant », « après », « déployé » (= après), au début ou dans le nom */
const BEFORE = /(^|[-_ .])(avant|before)([-_ .]|$)/;
const AFTER = /(^|[-_ .])(apr[eè]s|after|d[ée]ploy[ée]e?)([-_ .]|$)/;

/** Le nom lisible d'une capture : sans préfixe d'envoi ni numéro, « 390 » = téléphone, « bureau » = ordinateur. */
function niceName(base: string): string {
  return base
    .replace(/^tg-/i, '')
    .replace(/(^|[-_])(avant|before|apr[eè]s|after|d[ée]ploy[ée]e?)(?=[-_]|$)/gi, '$1')
    .replace(/(^|[-_])390(?=[-_]|$)/g, '$1(téléphone)')
    .replace(/(^|[-_])bureau(?=[-_]|$)/gi, '$1(ordinateur)')
    .replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Une légende courte tirée du nom du fichier : « Avant : fiche produit (téléphone) », sinon le nom lisible. */
function labelOf(file: string, caption?: string): string | undefined {
  const base = path.basename(file).replace(/\.[a-z0-9]+$/i, '');
  const low = base.toLowerCase();
  const rest = niceName(base);
  const tail = rest && rest.length >= 3 ? ` : ${rest}` : '';
  if (BEFORE.test(low.replace(/^tg-/, ''))) return safe(`Avant${tail}`, 60);
  if (AFTER.test(low.replace(/^tg-/, ''))) return safe(`Après${tail}`, 60);
  // noms techniques (captures du navigateur, blobs, identifiants) : pas de légende
  if (/blob|^mcp-|^screenshot|[0-9a-f]{12,}|^\d{6,}/.test(low)) return caption ? safe(caption, 60) : undefined;
  return rest.length >= 3 ? safe(rest[0].toUpperCase() + rest.slice(1), 50) : undefined;
}

/** Lit une image (réduite si elle est lourde) ; null si elle n'existe plus ou n'a pas une taille utile. */
// tout en asynchrone : la réduction par sips (jusqu'à 20 s par image) et la relecture d'une transcription entière se
// faisaient d'un bloc et figeaient la boucle du collecteur, donc les clics du Bureau
const sipsShrink = (file: string, out: string) => new Promise<boolean>((ok) => {
  execFile('/usr/bin/sips', ['-Z', '1600', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', file, '--out', out], { timeout: 20_000, killSignal: 'SIGKILL' }, (err) => ok(!err));
});
let shrinkN = 0;
async function readImage(file: string, label?: string): Promise<Upload | null> {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || st.size < MEDIA_MIN_BYTES || st.size > 40_000_000) return null;
  const m = /\.(png|jpe?g|webp)$/i.exec(file);
  if (!m) return null;
  if (st.size > MEDIA_SHRINK_BYTES) {
    const out = path.join(WORK_DIR, `shrink-${process.pid}-${shrinkN++}.jpg`);
    try {
      await fsp.mkdir(WORK_DIR, { recursive: true, mode: 0o700 });
      if (!(await sipsShrink(file, out))) return null;
      const body = await fsp.readFile(out);
      return body.length <= MEDIA_MAX_BYTES ? { body, type: 'image/jpeg', ext: 'jpg', label } : null;
    } catch { return null; } finally { await fsp.rm(out, { force: true }).catch(() => undefined); }
  }
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
  let body: Buffer;
  try { body = await fsp.readFile(file); } catch { return null; }
  return { body, ext, type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg', label };
}

/**
 * Les captures d'une session, au plus MAX_MEDIA, dans cet ordre : les images jointes à ses messages (avant /
 * après, graphiques, planches), puis les captures du navigateur (dossier tool-results, ou images intégrées aux résultats
 * d'outils), puis les images qu'elle a seulement regardées.
 */
export async function screenshotsOf(s: SessionState): Promise<Upload[]> {
  stage('fil : captures d’une session');
  const out: Upload[] = [];
  const push = (u: Upload | null) => { if (u && out.length < MAX_MEDIA) out.push(u); };
  for (const sh of s.shots.filter((x) => x.sent)) push(await readImage(sh.path, labelOf(sh.path, sh.caption)));
  const browser: { t: number; u: Upload }[] = [];
  try {
    // seules les 4 dernières servent : on ne lit (et ne réduit) que les 8 plus récentes, pas les centaines d'une longue session
    const files = fs.readdirSync(s.toolResultsDir).filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).map((n) => {
      const f = path.join(s.toolResultsDir, n);
      try { return { f, t: fs.statSync(f).mtimeMs }; } catch { return null; }
    }).filter((x): x is { f: string; t: number } => !!x).sort((a, c) => a.t - c.t).slice(-8);
    for (const { f, t } of files) { const u = await readImage(f); if (u) browser.push({ t, u }); }
  } catch { /* pas de dossier */ }
  if (!browser.length && out.length < MAX_MEDIA) {
    // les images intégrées : on ne décode que les lignes qui en contiennent
    let text = '';
    try { text = await fsp.readFile(s.file, 'utf8'); } catch { text = ''; }
    let i = 0;
    for (const line of text.split('\n')) {
      i++;
      await breathe();
      if (!line.includes('"type":"image"') || !line.includes('"tool_result"')) continue;
      let m: { message?: { content?: unknown } };
      try { m = JSON.parse(line); } catch { continue; }
      const walk = (c: unknown) => {
        if (Array.isArray(c)) { c.forEach(walk); return; }
        if (!c || typeof c !== 'object') return;
        const o = c as { type?: string; source?: { type?: string; media_type?: string; data?: string }; content?: unknown };
        if (o.type === 'image' && o.source?.type === 'base64' && /^image\/(png|jpeg|webp)$/.test(o.source.media_type ?? '') && o.source.data) {
          const body = Buffer.from(o.source.data, 'base64');
          if (body.length >= MEDIA_MIN_BYTES && body.length <= MEDIA_MAX_BYTES) {
            const ext = o.source.media_type === 'image/png' ? 'png' : o.source.media_type === 'image/webp' ? 'webp' : 'jpg';
            browser.push({ t: i, u: { body, ext, type: o.source.media_type! } });
          }
        }
        if (o.content) walk(o.content);
      };
      walk(m.message?.content);
      if (browser.length > 12) browser.splice(0, browser.length - 12);
    }
  }
  // les dernières captures du navigateur (l'état final), sans dépasser la place restante ; inutiles quand la session a déjà
  // joint ses propres captures (avant / après, parcours)
  const room = out.length >= 2 ? 0 : MAX_MEDIA - out.length;
  for (const b of browser.sort((a, c) => a.t - c.t).slice(-Math.min(room, 4))) push(b.u);
  if (room) for (const sh of s.shots.filter((x) => !x.sent)) { if (out.length >= MAX_MEDIA) break; push(await readImage(sh.path, labelOf(sh.path))); }
  // une même image envoyée deux fois (même contenu) n'apparaît qu'une fois
  const seen = new Set<string>();
  return out.filter((u) => { const h = createHash('sha256').update(u.body).digest('hex'); if (seen.has(h)) return false; seen.add(h); return true; });
}

type UploadFn = (body: Buffer, type: string, id: string) => Promise<boolean>;

/** Envoie les captures (une fois par image) et renvoie les médias à afficher ; null si un envoi a échoué. */
async function uploadShots(shots: Upload[], upload: UploadFn): Promise<FeedEntry['media'] | null> {
  const media: FeedEntry['media'] = [];
  for (const shot of shots) {
    const id = createHash('sha256').update(shot.body).digest('hex').slice(0, 32) + '.' + shot.ext;
    if (!store.uploaded[id]) {
      if (!(await upload(shot.body, shot.type, id))) return null;
      store.uploaded[id] = new Date().toISOString();
    }
    media.push({ url: `/media/${id}`, kind: 'image', label: shot.label || `Capture ${media.length + 1}` });
  }
  return media;
}

/**
 * Les captures du fil : pour chaque entrée intéressante ou qui attend une décision, collectées une fois (et recollectées
 * une fois à chaque nouvelle version de la collecte) ; puis celles des sessions qui attendent ta réponse (affichées dans
 * leur fiche de décision), à chaque nouvelle image.
 */
export async function uploadMedia(sessions: Map<string, SessionState>, upload: UploadFn) {
  let lookups = 2;
  // au plus 4 entrées par passage (lecture des transcriptions, réduction des images) : le reste au passage suivant
  let budget = 4;
  for (const e of [...store.entries].sort((a, b) => b.at - a.at)) {
    if (budget <= 0) break;
    if (!(e.interesting || e.needsYou) || (store.mv[e.key] ?? (store.uploaded['done:' + e.key] ? 1 : 0)) >= MEDIA_V) continue;
    let s = sessions.get(e.key.split(':').slice(1).join(':')) ?? null;
    if (!s) { if (lookups-- <= 0) continue; s = resolveSession(e.key); }
    if (s) {
      const media = await uploadShots(await screenshotsOf(s), upload);
      if (!media) return;
      if (media.length) e.media = media;
    }
    store.mv[e.key] = MEDIA_V;
    changed = true;
    budget--;
    await new Promise((r) => setImmediate(r));
  }
  for (const s of sessions.values()) {
    if (s.status !== 'waiting') continue;
    const sig = s.shots.map((x) => x.path + (x.sent ? '!' : '')).join('|');
    if (waitingSig.get(s.key) === sig) continue;
    const media = await uploadShots(await screenshotsOf(s), upload);
    if (!media) return;
    waitingSig.set(s.key, sig);
    s.media = media;
    s.dirty = true;
  }
}
const waitingSig = new Map<string, string>();

/**
 * Les décisions déjà tranchées : ~/.config/bureau-collector/decided.json, { "<clé de salle>": "ce qui a été
 * décidé" }. Relu à chaque envoi du fil ; une entrée qui y figure ne s'affiche plus dans « À toi de jouer ».
 */
const DECIDED = path.join(os.homedir(), '.config', 'bureau-collector', 'decided.json');
let decidedMtime = 0;
function applyDecided() {
  let st: fs.Stats;
  try { st = fs.statSync(DECIDED); } catch { return; }
  if (st.mtimeMs === decidedMtime) return;
  decidedMtime = st.mtimeMs;
  let map: Record<string, string> = {};
  try { map = JSON.parse(fs.readFileSync(DECIDED, 'utf8')); } catch { return; }
  for (const e of store.entries) {
    const note = map[e.key];
    if (note && e.resolved !== note) { e.resolved = safe(String(note), 200); changed = true; }
  }
}

/** Le fil à envoyer s'il a changé depuis le dernier envoi (null sinon). */
export function takeFeed(): FeedEntry[] | null {
  applyDecided();
  if (!changed) return null;
  const now = Date.now();
  store.entries = store.entries.filter((e) => now - e.at < KEEP_MS).sort((a, b) => a.at - b.at).slice(-MAX_ENTRIES);
  const keys = new Set(store.entries.map((e) => e.key));
  for (const k of Object.keys(store.src)) if (!keys.has(k)) delete store.src[k];
  for (const m of [store.tried, store.v, store.retried, store.mv]) for (const k of Object.keys(m)) if (!keys.has(k)) delete m[k];
  changed = false;
  save();
  return [...store.entries].reverse();
}

/** Le fil a changé et pourrait partir (au plus une fois par minute, voir index.ts). */
export function feedPending() { return changed; }

/** À rappeler si l'envoi échoue : le fil repartira au prochain essai. */
export function feedNotSent() { changed = true; }

/** Les réalisations d'un jour (pour le bandeau). */
export function entriesSince(t: number): number { return store.entries.filter((e) => e.at >= t).length; }

// ── Le résumé par Claude Haiku : titre clair, deux phrases, le détail (fait / résultats / reste), catégorie,
//    sous-catégorie, intérêt, et ce qui t'attend avec de quoi trancher ──

const DIGEST_SYSTEM = `Tu ranges et résumes le travail fini d'un agent Claude Code pour la personne qui l'a lancé. Elle lit ça sur un tableau de suivi : elle veut comprendre en cinq secondes ce qui a changé, puis pouvoir lire le détail sans ouvrir la conversation, et trancher une décision sans aller chercher le contexte ailleurs.
Réponds UNIQUEMENT par un objet JSON sur une ligne, sans texte autour, avec ces clés :
{"titre":"","resume":"","fait":[],"resultats":[],"reste":[],"categorie":"","sous_categorie":"","interessant":true,"attend_toi":"","decision":{"question":"","contexte":"","pourquoi":"","options":[{"choix":"","consequence":""}],"conseil":""}}
Règles communes : français simple, au tutoiement (tu t'adresses à cette personne), phrases courtes ; pas de hash, de chemin de fichier, de numéro d'issue ou de PR, pas de jargon (PR, worktree, commit, merge, flag) : dis ce que ça veut dire concrètement ; jamais d'anglais ; n'invente rien qui n'est pas dans le texte.
- titre : 8 mots au plus, ce qui a été livré ou trouvé.
- resume : une ou deux phrases courtes et concrètes : ce qui est fait et ce que ça change.
- fait : 2 à 6 points courts (une phrase chacun), ce qui a été fait concrètement.
- resultats : 0 à 5 points, ce que ça change ou ce qui a été vérifié, avec les chiffres du texte s'il y en a.
- reste : 0 à 4 points, ce qui reste à faire ou les limites connues.
- categorie : une seule clé parmi code (code, application, site, bugs, déploiement), contenu (posts, vidéos, articles, newsletter), recherche (études, analyses, veille, comparatifs, rapports), business (offres, prix, clients, ventes, marketing), organisation (organisation du travail, agents, automatisations, outils), autre.
- sous_categorie : 1 à 3 mots en français (« Page d'accueil », « Newsletter », « Veille concurrents »).
- interessant : false pour la cuisine interne sans effet visible (relecture ou intégration de PR, tests, CI, lint, refactor, ménage, rien de livré) ; true sinon.
- attend_toi : ne remplis ce champ QUE si l'agent attend vraiment une décision de la personne (dépenser de l'argent, écrire à un vrai client ou partenaire, supprimer des données pour de bon, donner un accès, un choix de prix, d'offre ou de stratégie, une mise en ligne). Dans ce cas, une phrase courte à l'infinitif (« Valider le texte de la page »). Pour tout le reste (tests, correctif, choix technique, question dont l'agent connaît la réponse), mets "".
- decision : seulement si attend_toi n'est pas vide, sinon {}. question : ce qu'il faut trancher, en une question claire. contexte : 2 ou 3 phrases pour quelqu'un qui n'a pas suivi : ce qui a été fait et où on en est. pourquoi : pourquoi c'est à la personne de décider et ce qui reste bloqué sans sa réponse. options : 2 à 4 choix réalistes tirés du texte (au minimum dire oui ou attendre), chacun avec sa conséquence concrète en une phrase. conseil : ce que l'agent recommande s'il l'a dit, sinon "".`;

/** Version du résumé : une entrée résumée par une version plus ancienne (sans détail ni décision) est refaite une fois. */
const DIGEST_V = 2;
const CAT_KEYS = Object.keys(CATEGORY_LABELS) as FeedCategory[];
let digestRunning = 0;
let digestDisabledUntil = 0;

type Raw = Record<string, unknown>;

function applyDigest(e: FeedEntry, out: string): boolean {
  const m = /\{[\s\S]*\}/.exec(out);
  if (!m) return false;
  let d: Raw;
  try { d = JSON.parse(m[0]); } catch { return false; }
  const str = (v: unknown, n: number) => (typeof v === 'string' ? safe(redact(v.replace(/\s+/g, ' ').trim()), n) : '');
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.map((x) => str(x, 220)).filter(Boolean).slice(0, max) : []);
  const title = str(d.titre, 90);
  const summary = str(d.resume, 360);
  if (!title || !summary) return false;
  e.title = title;
  e.summary = summary;
  const detail = { done: list(d.fait, 6), results: list(d.resultats, 5), left: list(d.reste, 4) };
  if (detail.done.length || detail.results.length || detail.left.length) e.detail = detail; else delete e.detail;
  if (typeof d.categorie === 'string' && CAT_KEYS.includes(d.categorie as FeedCategory)) e.category = d.categorie as FeedCategory;
  const sub = str(d.sous_categorie, 30);
  if (sub) e.sub = sub; else delete e.sub;
  if (typeof d.interessant === 'boolean') e.interesting = d.interessant;
  const needs = str(d.attend_toi, 160);
  if (needs) e.needsYou = needs; else delete e.needsYou;
  const dec = (d.decision && typeof d.decision === 'object' ? d.decision : {}) as Raw;
  const question = str(dec.question, 240) || needs;
  if (needs && question) {
    const options = (Array.isArray(dec.options) ? dec.options as Raw[] : [])
      .map((o) => ({ label: str(o?.choix, 80), effect: str(o?.consequence, 240) }))
      .filter((o) => o.label)
      .map((o) => (o.effect ? o : { label: o.label }))
      .slice(0, 4);
    const decision: Decision = { question, options, from: 'resume' };
    const context = str(dec.contexte, 700);
    const why = str(dec.pourquoi, 400);
    const advice = str(dec.conseil, 300);
    if (context) decision.context = context;
    if (why) decision.why = why;
    if (advice) decision.advice = advice;
    e.decision = decision;
  } else delete e.decision;
  e.ai = true;
  store.v[e.key] = DIGEST_V;
  return true;
}

/** À refaire : jamais résumée, ou résumée par une ancienne version (une seule fois). */
function needsDigest(e: FeedEntry): boolean {
  if (!e.ai) return (store.tried[e.key] ?? 0) < 2;
  return (store.v[e.key] ?? 1) < DIGEST_V && (store.retried[e.key] ?? 0) < 1;
}

/**
 * Met en file les entrées à résumer, deux à la fois : d'abord celles qui attendent une décision, puis les plus
 * récentes. La source est gardée après le résumé (sur le Mac), pour pouvoir le refaire si sa forme change.
 */
export function pumpDigest() {
  if (Date.now() < digestDisabledUntil || digestRunning >= 2) return;
  const bin = findClaude();
  if (!bin) return;
  const todo = store.entries.filter(needsDigest).sort((a, b) => Number(!!b.needsYou) - Number(!!a.needsYou) || b.at - a.at);
  // retrouver une ancienne session peut demander de relire sa transcription : au plus 3 par passage
  let lookups = 3;
  while (digestRunning < 2 && todo.length) {
    const e = todo.shift()!;
    if (e.ai && !store.src[e.key]) {
      if (lookups-- <= 0) break;
      const s = resolveSession(e.key);
      if (s) store.src[e.key] = sourceOf(s);
      // sans source, refaire le résumé n'apporterait rien de plus
      if (!store.src[e.key]) { store.retried[e.key] = 1; changed = true; continue; }
    }
    if (e.ai) store.retried[e.key] = (store.retried[e.key] ?? 0) + 1;
    else store.tried[e.key] = (store.tried[e.key] ?? 0) + 1;
    const input = store.src[e.key] || [`Titre : ${e.title}`, e.summary ? `Compte rendu : ${e.summary}` : '', e.links.length ? `Liens : ${e.links.map((l) => l.label).join(', ')}` : ''].filter(Boolean).join('\n');
    digestRunning++;
    fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
    const child = execFile(bin, ['-p', '--model', MODEL, '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--system-prompt', DIGEST_SYSTEM],
      { cwd: WORK_DIR, timeout: 120_000, maxBuffer: 1 << 20, env: haikuEnv() },
      (err, stdout, stderr) => {
        digestRunning--;
        const out = String(stdout ?? '').trim();
        if (!err && out && applyDigest(e, out)) { changed = true; save(); }
        else if (/auth|login|expired|credit|limit/i.test(String(stderr) + out + String(err?.message ?? ''))) digestDisabledUntil = Date.now() + 3600_000;
        pumpDigest();
      });
    child.stdin?.end(input);
  }
}
