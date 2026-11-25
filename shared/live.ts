// Le suivi en direct des vraies sessions Claude Code (version en ligne).
//
//   collecteur (Mac, lit ~/.claude/projects)  --POST /api/ingest-->  Worker + Durable Object  --WebSocket /ws-->  navigateur
//
// Le collecteur ne transmet que des RÉSUMÉS : nom d'outil, chemin court, titre de tâche, statut, compteurs.
// Jamais une transcription, jamais un message complet ; tout texte passe par le caviardage (redact) avant l'envoi.
// Syntaxe « effaçable » uniquement : lu tel quel par Node (collecteur), par le Worker et par Vite.
import type { OfficeEvent, PlanItem } from './protocol.ts';

/** en cours / attend ta réponse / bloquée (permission, commande qui ne rend pas la main) / terminée */
export type SessionStatus = 'working' | 'waiting' | 'blocked' | 'done';

/** Une source = une machine ou un compte qui fait tourner un collecteur. */
export interface SourceInfo {
  id: string;
  /** libellé affiché (« Mon Mac », « Portable »…) */
  label: string;
  /** dernier envoi reçu (ms) : sert à repérer un collecteur éteint */
  seenAt: number;
}

export interface SubagentSummary {
  /** identifiant de l'appel Agent (tool_use id) */
  id: string;
  /** type d'agent (general-purpose, Explore…) */
  type: string;
  /** la description courte donnée par le chef */
  task: string;
  status: 'working' | 'done' | 'failed';
  startedAt: number;
  endedAt?: number;
  tokens: number;
  tools: number;
  /** la dernière action, déjà résumée (« Je lis store.ts ») */
  lastAct?: string;
  /** équivalent tarif API en dollars ; null = modèle hors de la table des tarifs (« prix inconnu ») */
  cost?: number | null;
  /** fond / premier plan / arrière-plan : `background` = lancé avec run_in_background */
  background?: boolean;
}

/** Une salle du bureau = une session Claude Code. */
export interface SessionSummary {
  /** clé unique : `${sourceId}:${sessionId}` */
  key: string;
  sourceId: string;
  sessionId: string;
  title: string;
  /** dossier du projet, raccourci (« mon-projet », « site-vitrine ») */
  project: string;
  /** nom du worktree s'il y en a un (« bureau-des-agents-1df542 ») */
  worktree?: string;
  branch?: string;
  /** claude-desktop, sdk-cli, sdk-py… */
  entrypoint?: string;
  model?: string;
  status: SessionStatus;
  /** une phrase courte qui explique le statut (« Attend ta réponse », « Commande en cours depuis 12 min ») */
  statusText: string;
  startedAt: number;
  lastActivity: number;
  /** la dernière action du chef, déjà résumée */
  lastAct?: string;
  plan: PlanItem[];
  subagents: SubagentSummary[];
  /** sous-agents en cours */
  activeSubagents: number;
  /** jetons consommés (entrée + création de cache + sortie, chef et sous-agents ; lectures de cache exclues) */
  tokens: number;
  /** nombre d'appels d'outils (chef et sous-agents) */
  tools: number;
  /** lien de PR repéré dans la session, s'il y en a un */
  prUrl?: string;
  /**
   * « Qu'est-ce que je suis en train de faire », en une ligne courte : la tâche du plan en cours, sinon le titre.
   * C'est la première chose affichée (en gras) sur la carte et dans la salle.
   */
  doing: string;
  /** équivalent tarif API en dollars (chef + sous-agents) ; null si au moins un modèle est inconnu et rien n'a pu être compté */
  cost: number | null;
  /** vrai si une partie des jetons vient d'un modèle hors de la table (le coût affiché est alors un minimum) */
  costPartial?: boolean;
  /** la session qui a lancé celle-ci (clé de salle), si on a pu la retrouver */
  parentKey?: string;
  /** les sessions lancées par celle-ci (clés de salles) */
  childKeys?: string[];
  /**
   * Ta demande, résumée (jamais le message complet) : la première, et la dernière si tu en as envoyé d'autres.
   * Absent si BUREAU_SHARE_REQUEST=0.
   */
  request?: RequestSummary;
  /** ce que la session attend de toi (question posée, plan à valider, choix proposés), quand elle attend ta réponse */
  decision?: Decision;
  /** les captures de la session (jointes à un message, regardées par l'agent), quand elle attend ta réponse */
  media?: FeedMedia[];
}

/**
 * Une décision qui t'attend, avec de quoi trancher sans aller chercher ailleurs : le contexte, la question, les choix
 * possibles et ce que chacun change. Tout est déjà résumé et caviardé par le collecteur.
 */
export interface Decision {
  /** la question à trancher, en une phrase */
  question: string;
  /** ce qui s'est passé et pourquoi on te demande (quelques phrases) */
  context?: string;
  /** pourquoi c'est à toi de décider (ce qui bloque sans ta réponse) */
  why?: string;
  /** les choix possibles et leurs conséquences */
  options: DecisionOption[];
  /** ce que l'agent conseille, s'il l'a dit */
  advice?: string;
  /** d'où vient la décision : une question posée (outil), un plan à valider, la fin d'un tour, ou le résumé du travail fini */
  from: 'question' | 'plan' | 'fin-de-tour' | 'resume';
}

export interface DecisionOption { label: string; effect?: string }

export interface RequestSummary {
  /** résumé de la demande de départ */
  first: string;
  firstAt: number;
  /** résumé du dernier message envoyé, s'il y en a eu plusieurs */
  last?: string;
  lastAt?: number;
  /** nombre de messages envoyés dans la session */
  count: number;
  /** « ia » = résumé par Claude Haiku ; « extrait » = début du message, nettoyé et coupé */
  kind: 'ia' | 'extrait';
}

/** Un événement de salle, déjà résumé et caviardé. `who` = « chef » ou l'id d'un sous-agent. */
export interface RoomEvent { key: string; at: number; ev: OfficeEvent }

// ── Le bandeau de l'étage : la journée ──

export interface DayStats {
  /** début du jour (minuit, heure de la machine) */
  day: number;
  /** tâches du plan cochées aujourd'hui, toutes sessions confondues */
  tasksDone: number;
  /** sessions terminées aujourd'hui */
  sessionsDone: number;
  /** coût du jour en équivalent tarif API, toutes sessions confondues (sous-agents compris) */
  cost: number;
  costPartial?: boolean;
  /** le cumul depuis BUREAU_TOTAL_SINCE (30 derniers jours par défaut), toutes sessions et sous-agents compris */
  total?: TokenTotal;
}

export interface TokenTotal {
  since: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** équivalent tarif API */
  cost: number;
  /** jetons d'un modèle hors de la table des tarifs (le coût est alors un minimum) */
  unknown: number;
  /** vrai tant que le premier passage de lecture n'est pas fini */
  partial: boolean;
  /** nombre de sources (machines ou comptes) comptées, et nombre attendu (BUREAU_EXPECTED_SOURCES) */
  sources: number;
  expectedSources: number;
}

// ── Le fil des réalisations ──

/** Les grandes catégories du fil des réalisations (à adapter à ton activité : collector/feed.ts les devine). */
export type FeedCategory = 'code' | 'contenu' | 'recherche' | 'business' | 'organisation' | 'autre';

export const CATEGORY_LABELS: Record<FeedCategory, string> = {
  code: 'Code et produit', contenu: 'Contenu', recherche: 'Recherche et analyses', business: 'Business',
  organisation: 'Organisation', autre: 'Autre',
};

export interface FeedMedia {
  /** chemin servi par le Worker derrière la connexion (/media/<id>) */
  url: string;
  kind: 'image';
  /** légende courte (« Avant », « Après », « Capture 1 ») */
  label?: string;
}

/**
 * Un rapport long (onglet « Rapports ») : un fichier .md du dossier des rapports (--rapports, deux niveaux) qui commence
 * par un en-tête `---` avec `rapport:` (le titre), `sujet:`, `issue:`, `resume:`, `date:`, `couverture:`. Le collecteur envoie
 * ses images au R2 privé (comme les captures) et son texte au Worker ; le navigateur les lit derrière la connexion.
 */
export interface ReportMeta {
  /** « <dossier>--<fichier> » en minuscules : l'adresse du rapport (#r=<id>) */
  id: string;
  title: string;
  /** le sujet, qui range la liste (« Produit », « Marketing », « Veille »…) */
  subject: string;
  /** le verdict en une ou deux phrases */
  summary: string;
  issue?: number;
  /** la date de l'en-tête (AAAA-MM-JJ), sinon celle du fichier */
  date: string;
  /** dernière modification du fichier */
  updatedAt: number;
  words: number;
  images: number;
  /** l'image de couverture (/media/<id>), sinon la première image du rapport */
  cover?: string;
  /** largeur / hauteur de la couverture (le cadre de la carte prend sa forme, bornée) */
  coverRatio?: number;
  /** le PDF imprimé par le collecteur (Chromium, texte vectoriel) : /media/<id>.pdf ; absent = photographie de la page */
  pdf?: string;
  /** le résumé audio (voix de synthèse, fait par le collecteur une fois par version du texte) : /media/<id>.mp3 et sa durée */
  audio?: { url: string; seconds: number };
  /** le niveau de l'en-tête (`niveau: a-lire | reference | trace`) ; absent ou inconnu = trace */
  level?: ReportLevel;
  /** empreinte du texte : le navigateur recharge le rapport quand elle change */
  sig: string;
}

/**
 * Les trois niveaux d'un rapport. À lire : une décision à prendre ou une information à connaître,
 * complète (rare). Référence : une étude à garder, rangée par sujet. Trace : le compte rendu d'une tâche technique.
 */
export type ReportLevel = 'a-lire' | 'reference' | 'trace';
export const REPORT_LEVELS: readonly ReportLevel[] = ['a-lire', 'reference', 'trace'];
/** l'en-tête tel qu'écrit (« À lire », « a-lire », « Référence »…) ; absent ou inconnu = trace (garde) */
export function levelOf(raw: string | undefined): ReportLevel {
  const k = (raw ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  return k === 'a-lire' ? 'a-lire' : k === 'reference' ? 'reference' : 'trace';
}

export interface Report extends ReportMeta {
  /** le texte en markdown (caviardé), images réécrites en /media/<id> */
  body: string;
}

export interface ReportIndex { at: number; reports: ReportMeta[] }

/**
 * Les rapports archivés : rangés à part (vue « Archivés »), jamais supprimés. Un seul fichier dans le R2
 * (reports-archive.json), écrit par le bouton Archiver de l'onglet Rapports (connecté) ou par un agent (jeton du collecteur).
 * archived: false = remis dans la liste. at : la date du dernier geste.
 */
export interface ReportArchive { at: number; items: Record<string, { archived: boolean; at: number }> }

export interface FeedEntry {
  /** clé de la salle (une entrée par session terminée) */
  key: string;
  title: string;
  /** fin de la session */
  at: number;
  category: FeedCategory;
  /** la sous-catégorie, courte (« Messagerie », « Campagnes », « Pubs Meta ») ; absente si inconnue */
  sub?: string;
  /** faux = maintenance, sécurité, CI, relecture ou intégration de PR, tests, sans résultat : masqué par défaut */
  interesting: boolean;
  /** ce qui a été fait, en deux ou trois phrases simples, en français (caviardé) */
  summary: string;
  /** vrai si le titre et le résumé ont été réécrits par Claude Haiku (sinon : extrait du compte rendu) */
  ai?: boolean;
  /** le détail de la réalisation, lisible sans ouvrir GitHub (absent sur les anciennes entrées) */
  detail?: FeedDetail;
  /** ce qui t'attend (une décision, une vérification), en une phrase ; absent si rien */
  needsYou?: string;
  /** la décision en entier (contexte, choix, conséquences), quand needsYou est présent */
  decision?: Decision;
  /** la décision a été tranchée (par Claude sur délégation, ou ailleurs) : elle ne s'affiche plus dans « À toi de jouer » */
  resolved?: string;
  /** liens utiles : PR, artefacts claude.ai, pages en ligne */
  links: { label: string; url: string }[];
  /** fichiers produits (nom seulement) */
  files: string[];
  media: FeedMedia[];
  cost: number | null;
  tasks: number;
}

/** Le détail d'une réalisation : des listes courtes, en français simple. */
export interface FeedDetail {
  /** ce qui a été fait, concrètement */
  done: string[];
  /** ce que ça change, les résultats mesurés ou vérifiés */
  results: string[];
  /** ce qui reste à faire, les limites connues */
  left: string[];
}

// ── Collecteur → Worker (POST /api/ingest, en-tête Authorization: Bearer <INGEST_TOKEN>) ──
export interface IngestPayload {
  source: { id: string; label: string };
  /** les salles modifiées depuis le dernier envoi (ou toutes, si full) */
  sessions: SessionSummary[];
  /** vrai = `sessions` est la liste complète de la source : les salles absentes disparaissent */
  full?: boolean;
  /** clés de salles à retirer */
  removed?: string[];
  /** nouveaux événements, dans l'ordre */
  events: RoomEvent[];
  /** le bandeau du jour (à chaque envoi complet) */
  day?: DayStats;
  /** le fil des réalisations de la source (liste complète, envoyée quand elle change) */
  feed?: FeedEntry[];
}

/** La réponse du Worker au collecteur. */
export interface IngestReply {
  ok: boolean;
  viewers: number;
  /** le Worker vient de (re)démarrer sans liste complète de cette source : l'envoyer tout de suite */
  cold?: boolean;
}

// ── Navigateur → Worker ──
export type LiveClientMsg =
  /** entrer dans une salle (null = revenir à l'étage) */
  | { t: 'watch'; key: string | null };

// ── Worker → navigateur ──
export type LiveServerMsg =
  | { t: 'hello'; sources: SourceInfo[]; sessions: SessionSummary[]; build?: string; day?: DayStats | null; feed?: FeedEntry[] }
  | { t: 'sessions'; sources: SourceInfo[]; sessions: SessionSummary[]; removed?: string[] }
  /** le bandeau et le fil, quand ils changent */
  | { t: 'day'; day: DayStats | null }
  | { t: 'feed'; feed: FeedEntry[] }
  /** à l'entrée dans une salle : son résumé et ses derniers événements (pour remettre le bureau dans l'état) */
  | { t: 'room'; session: SessionSummary; log: { at: number; ev: OfficeEvent }[] }
  /** la salle demandée n'est plus gardée par le Worker (plus de 3 jours) */
  | { t: 'gone'; key: string }
  | { t: 'ev'; key: string; at: number; ev: OfficeEvent };

/** Combien d'événements le Worker garde par salle (le reste est oublié). */
export const ROOM_LOG_MAX = 600;
/** Une salle terminée reste visible à l'étage pendant ce temps. */
export const DONE_VISIBLE_MS = 12 * 3600_000;

// ── Caviardage : appliqué par le collecteur à TOUT texte avant l'envoi ──
const URL_CREDENTIALS_RE = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^@\s/]+@/gi; // identifiants dans une URL (user:motdepasse@)
const KEY_VALUE_RE = /[A-Za-z0-9_-]*(?:api[_-]?key|key|token|secret|password|passwd|pwd|authorization|cookie|credential)s?["']?\s*[:=]\s*["']?[^\s"'&,;]{4,}/gi; // cle=valeur, y compris FOO_SECRET=…
const OPTION_RE = /--?(?:api-?key|key|token|secret|password|passwd|pwd|auth|header|cookie|user)\s+["']?[^\s"']+/gi; // options --password xxx
const URL_PARAM_RE = /([?&][^=&\s]+=)[^&\s"']+/g; // valeurs des paramètres d'URL
const HEX_RE = /\b[A-Fa-f0-9]{32,}\b/g; // longues chaînes hexadécimales
const B64_RE = /\b[A-Za-z0-9+/_-]{40,}={0,2}/g; // longues chaînes base64
const SECRET_PATTERNS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // e-mails
  /\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{12,}/g, // clés Stripe / Anthropic / OpenAI
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, // JWT
  /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, // en-têtes d'autorisation
  URL_CREDENTIALS_RE,
  KEY_VALUE_RE,
  OPTION_RE,
  URL_PARAM_RE,
  HEX_RE,
  B64_RE,
  /(?:\+\d{1,3}[ .-]?|\b0)[1-9](?:[ .-]?\d{2}){4}\b/g, // numéros de téléphone
];

/** Masque les motifs de secrets et de données personnelles. */
export function redact(text: string): string {
  let t = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    t = t.replace(re, (m, p1) => (typeof p1 === 'string' && m.startsWith(p1) ? p1 + '***' : '***'));
  }
  return t;
}

// Adresses de liens : les motifs « valeur de paramètre » et « longue chaîne » de redact() cassaient un slug d'article, un
// watch?v= ou un #r=<rapport>. redactUrl() garde les motifs précis (e-mails, clés, JWT, identifiants), masque toute valeur
// de paramètre hors SAFE_PARAM et tout morceau qui ressemble à un jeton tiré au hasard.
const URL_PATTERNS = [URL_CREDENTIALS_RE, ...SECRET_PATTERNS.filter((re) =>
  re !== URL_CREDENTIALS_RE && re !== URL_PARAM_RE && re !== HEX_RE && re !== B64_RE && re !== KEY_VALUE_RE && re !== OPTION_RE)];
const SECRET_NAME_IN_PATH = /(?:api[_-]?key|key|token|secret|password|passwd|pwd|authorization|cookie|credential)s?[:=]/i;
// Sites publics précis (pas tout gouv.fr) dont le chemin porte l'identifiant d'une page publique (annonce, texte de loi, question écrite) : un
// identifiant comme 26CBA4DTBPXK (SeLoger), un UUID (Orpi) ou JORFTEXT000047998521 (Légifrance) n'y est pas un jeton,
// le caviarder cassait le lien du rapport . Le chemin seul est gardé : paramètres et motifs précis restent caviardés.
const PUBLIC_ID_HOST = /^https?:\/\/(?:www\.)?(?:seloger\.com|orpi\.com|leboncoin\.fr|bienici\.com|pap\.fr|paruvendu\.fr|locservice\.fr|fr\.foncia\.com|legifrance\.gouv\.fr|loire-atlantique\.gouv\.fr|(?:questions\.)?assemblee-nationale\.fr|senat\.fr)\//i;
const SAFE_PARAM = /^(?:v|r|q|page|lang|hl|list|index|tab|sort|tag|category|section|year|utm_[a-z]+)$/i;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HOME_RE = /(?:^|\/)(?:Users|home)\//;

/** Part des changements de classe (minuscule, majuscule, chiffre) d'un caractère au suivant ; un séparateur remet à zéro. */
function turnRate(s: string): { n: number; rate: number } {
  const cls = (c: string) => (/[a-z]/.test(c) ? 1 : /[A-Z]/.test(c) ? 2 : /\d/.test(c) ? 3 : 0);
  let n = 0; let turns = 0; let prev = 0;
  for (const c of s) {
    const k = cls(c);
    if (k && prev && k !== prev) turns++;
    if (k) n++;
    prev = k;
  }
  return { n, rate: n ? turns / n : 0 };
}

/** Un morceau isolé (entre séparateurs) qui ressemble à un jeton : 40 caractères, 20 avec lettres et chiffres, ou 16 qui alternent. */
function randomPiece(p: string): boolean {
  if (p.length >= 40 || (p.length >= 20 && /\d/.test(p) && /[A-Za-z]/.test(p))) return true;
  const { n, rate } = turnRate(p);
  return n >= 16 && rate >= 0.35;
}

/**
 * Un segment d'adresse qui ressemble à un jeton plutôt qu'à un mot, un slug ou un nom de fichier. Un slug (au moins deux
 * mots de 3 lettres ou plus entre séparateurs) n'est jugé que morceau par morceau ; tout autre segment l'est en entier :
 * 12 caractères ou plus, lettres et chiffres mêlés, qui changent de classe au moins 0,25 fois par caractère (un mot en
 * camelCase comme « OAuth2Configuration » est vers 0,2, un jeton aléatoire vers 0,6), ou UUID, ou hexadécimal de 32.
 */
export function looksRandom(s: string): boolean {
  if (UUID_RE.test(s) || /[A-Fa-f0-9]{32,}/.test(s)) return true;
  const pieces = s.split(/[-_.~+:@]/);
  if (pieces.some(randomPiece)) return true;
  if (pieces.filter((p) => /^[A-Za-z]{3,}$/.test(p)).length >= 2) {   // slug : seul un morceau mêlé et alterné le trahit
    return pieces.some((p) => { const { n, rate } = turnRate(p); return n >= 10 && /\d/.test(p) && /[A-Za-z]/.test(p) && rate >= 0.35; });
  }
  const { n, rate } = turnRate(s);
  return n >= 12 && /\d/.test(s) && /[A-Za-z]/.test(s) && rate >= 0.25;
}

/** Caviarde l'adresse d'un lien sans casser ce qu'elle a de lisible (domaine, chemin, slug, v=, r=). */
export function redactUrl(url: string): string {
  let u = String(url ?? '').replace(/%40/gi, '@');   // un e-mail encodé reste un e-mail
  for (const re of URL_PATTERNS) {
    u = u.replace(re, (m, p1) => (typeof p1 === 'string' && m.startsWith(p1) ? p1 + '***' : '***'));
  }
  // paramètres ?a= &a= #a= : valeur jusqu'au prochain & ou # ; paramètres ;a= (matrice) : jusqu'au prochain / ; ? & #
  u = u.replace(/([?&#]([^=&#;?\s/]+)=)([^&#\s]*)|(;([^=&#;?\s/]+)=)([^&#;?/\s]*)/g,
    (_m, h1?: string, n1?: string, v1?: string, h2?: string, n2?: string, v2?: string) => {
      const name = n1 ?? n2 ?? ''; const v = v1 ?? v2 ?? '';
      let dec = v;
      try { dec = decodeURIComponent(v); } catch { /* valeur mal encodée : lue telle quelle */ }
      const keep = SAFE_PARAM.test(name) && !/[;?=]/.test(v) && !looksRandom(v) && !HOME_RE.test(dec);
      return (h1 ?? h2 ?? '') + (keep || !v ? v : '***');
    });
  // segments du chemin : un jeton, ou un « token=… » / « api_key:… » glissé dans le chemin ; un SHA de commit reste
  // lisible, seulement dans le chemin d'un hôte de code
  const cut = u.search(/[?#]/);
  const base = cut < 0 ? u : u.slice(0, cut);
  const codeHost = /^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\//i.test(base);
  const publicIds = PUBLIC_ID_HOST.test(base);
  const pass = (part: string, sha: boolean, ids = false) => {
    let prev = '';
    return part.replace(/[^/?&#;\s]+/g, (seg) => {
      const after = prev; prev = seg;
      if (seg === '***') return seg;
      if (sha && /^(?:commit|commits|tree|blob|compare)$/.test(after) && /^(?:[0-9a-f]{7,12}|[0-9a-f]{40})$/.test(seg)) return seg;
      if (SECRET_NAME_IN_PATH.test(seg)) return '***';
      if (ids && !/[A-Fa-f0-9]{32,}|[A-Za-z0-9+/=_]{32,}/.test(seg)) return seg;   // un long hex ou base64 reste suspect
      return seg.replace(/[^=]+/g, (p) => (looksRandom(p) ? '***' : p));
    });
  };
  return pass(base, codeHost, publicIds) + (cut < 0 ? '' : pass(u.slice(cut), false));
}

