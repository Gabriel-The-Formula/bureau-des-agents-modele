// La mémoire du bureau, côté navigateur : les salles de l'étage (les sessions Claude Code suivies), et pour la
// salle ouverte, l'équipe, le plan, ce que dit Max. Chaque événement de la salle est rangé ici, puis transmis au
// moteur du jeu (les robots). Version en ligne : lecture seule, on regarde, on ne pilote rien.
import { create } from 'zustand';
import { NAMES, countStats, emptyStats } from '../../shared/activity.ts';
import type { DayStats, FeedEntry, SessionSummary, SourceInfo } from '../../shared/live.ts';
import type { ActKind, FileInfo, MissionInfo, MissionStats, OfficeEvent, PlanItem, Role } from '../../shared/protocol.ts';
import { sfx } from '../audio/sfx.ts';
import { bus } from './bus.ts';

export interface ActView { id: string; kind: ActKind; label: string; detail: string; at: number; ok?: boolean }

export interface AgentView {
  id: string;
  role: Role;
  name: string;
  task: string;
  prompt: string;
  status: 'working' | 'reporting' | 'done' | 'failed';
  act: ActView | null;
  acts: ActView[];
  say: string;
  sayAt: number;
  report: string;
  hiredAt: number;
  leftAt?: number;
  tokens: number;
  tools: number;
}

export interface ChefView {
  say: string;
  sayAt: number;
  typing: string;
  thinkingAt: number;
  act: ActView | null;
  acts: ActView[];
}

export interface AskView { requestId: string; who: string; tool: string; label: string; detail: string; full: boolean; at: number }

/**
 * Une ligne du fil de la salle. kind dit ce que c'est : un message de Max (chef) ou d'un sous-agent (sub), un résumé de
 * réflexion (think, rare), une action (act, avec son détail et son résultat), l'arrivée ou le rapport d'un sous-agent…
 */
export interface FeedLine {
  id: number; at: number; who: string; text: string;
  kind: 'user' | 'chef' | 'sub' | 'think' | 'hire' | 'act' | 'report' | 'file' | 'ask' | 'end' | 'error';
  /** pour une action : le détail (fichier, recherche, commande résumée), l'id de l'appel et son résultat */
  detail?: string; actId?: string; ok?: boolean;
}

export interface Toast { id: number; kind: 'info' | 'error'; text: string }

export type Tod = 'auto' | 'day' | 'evening' | 'night';
/** Le thème de l'interface : `auto` suit le système (prefers-color-scheme). */
export type Theme = 'auto' | 'light' | 'dark';

/** Les fenêtres qu'on ouvre en cliquant sur le bureau (un robot, le tableau, l'horloge…). */
export type Modal =
  | { kind: 'agent'; id: string }
  | { kind: 'board' }
  | { kind: 'clock' }
  | { kind: 'machine' }
  | { kind: 'jukebox' }
  | { kind: 'team'; role?: Role }
  /** le fil complet de la salle (messages, réflexions, actions, sous-agents) */
  | { kind: 'log' };

/** Les fiches qu'on ouvre depuis l'étage : une décision qui t'attend, ou une réalisation en détail. */
export type Sheet = { kind: 'decision'; key: string } | { kind: 'entry'; key: string };

interface S {
  connection: 'connecting' | 'live' | 'offline';
  /** vrai dès que le Worker a envoyé l'étage (sinon : chargement, rien à conclure d'une liste vide) */
  loaded: boolean;
  /** vrai dès que le fil des réalisations est arrivé */
  feedLoaded: boolean;
  /** l'étage affiché vient du navigateur (gardé au dernier passage) en attendant le Worker */
  stale: boolean;
  /** la salle ouverte n'est plus à l'étage (ouverte depuis une réalisation ou une décision) : on y reste */
  roomPinned: boolean;
  /** la fiche ouverte sur l'étage */
  sheet: Sheet | null;
  /** les salles de l'étage (liste complète, remplacée à chaque envoi du Worker) */
  sessions: SessionSummary[];
  sources: SourceInfo[];
  /** le bandeau du jour (tâches, coût) ; null tant que rien n'est arrivé */
  day: DayStats | null;
  /** le fil des réalisations (une entrée par session terminée) */
  achievements: FeedEntry[];
  /** la clé de la salle ouverte (null = l'étage) */
  room: string | null;
  /** le résumé de la salle ouverte */
  roomInfo: SessionSummary | null;
  /** vrai quand le journal de la salle ouverte est arrivé */
  roomReady: boolean;
  view: 'floor' | 'room';
  /** la salle ouverte, vue comme une « mission » du bureau */
  mission: MissionInfo | null;
  /** vrai pendant une rediffusion (ou la démo) */
  replaying: boolean;
  chef: ChefView;
  agents: Record<string, AgentView>;
  order: string[];
  plan: PlanItem[];
  files: FileInfo[];
  asks: Record<string, AskView>;
  stats: MissionStats;
  feed: FeedLine[];
  final: { ok: boolean; text: string; ms: number; stopped?: boolean; at: number } | null;
  /** quand l'équipe s'est mise au travail (pour le chrono) ; null = au repos */
  busySince: number | null;
  workMs: number;
  // l'interface
  showFinal: boolean;
  modal: Modal | null;
  /** chaque version du plan, dans l'ordre (le tableau garde l'historique) */
  planHistory: { at: number; items: PlanItem[] }[];
  music: { playing: boolean; index: number; volume: number };
  /** en mode tournage, la caméra suit l'action toute seule */
  cameraAuto: boolean;
  /** écran en hauteur (tablette en portrait) : le panneau passe sous le bureau */
  portrait: boolean;
  filming: boolean;
  sound: boolean;
  tod: Tod;
  theme: Theme;
  toasts: Toast[];
  apply: (ev: OfficeEvent, at: number, live: boolean) => void;
  resetMission: (m: MissionInfo | null) => void;
  toast: (kind: Toast['kind'], text: string) => void;
}

const pref = <T,>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem('bureau:' + key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
};
export const savePref = (key: string, v: unknown) => { try { localStorage.setItem('bureau:' + key, JSON.stringify(v)); } catch { /* navigation privée */ } };

const emptyChef = (): ChefView => ({ say: '', sayAt: 0, typing: '', thinkingAt: 0, act: null, acts: [] });

let feedId = 0;
let toastId = 0;
let lastActSound = 0;
const MAX_ACTS = 80;
const MAX_FEED = 600;

export const useOffice = create<S>((set, get) => ({
  connection: 'connecting',
  loaded: false,
  feedLoaded: false,
  stale: false,
  roomPinned: false,
  sheet: null,
  sessions: [],
  sources: [],
  day: null,
  achievements: [],
  room: null,
  roomInfo: null,
  roomReady: false,
  view: 'floor',
  mission: null,
  replaying: false,
  chef: emptyChef(),
  agents: {},
  order: [],
  plan: [],
  files: [],
  asks: {},
  stats: emptyStats(),
  feed: [],
  final: null,
  busySince: null,
  workMs: 0,
  showFinal: false,
  modal: null,
  planHistory: [],
  music: { playing: false, index: 0, volume: 0.55 },
  cameraAuto: pref('cameraAuto', true),
  portrait: typeof window !== 'undefined' && window.innerWidth / Math.max(1, window.innerHeight) < 0.8,
  filming: false,
  // un écran de suivi : le son est coupé tant que tu ne l'allumes pas
  sound: pref('sound', false),
  tod: pref<Tod>('tod', 'auto'),
  theme: pref<Theme>('theme', 'light'),
  toasts: [],

  toast: (kind, text) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-4) }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 4500);
  },

  resetMission: (m) => {
    set({
      mission: m, chef: emptyChef(), agents: {}, order: [], plan: [], files: [], asks: {}, stats: emptyStats(),
      feed: [], final: null, busySince: null, workMs: 0, showFinal: false, planHistory: [],
    });
    bus.reset();
  },

  apply: (ev, at, live) => {
    const s = get();
    /** l'événement transmis au moteur (le même, sauf un prénom corrigé) */
    let out: OfficeEvent = ev;
    const feed = (who: string, text: string, kind: FeedLine['kind'], more?: Partial<FeedLine>) => {
      const line: FeedLine = { id: ++feedId, at, who, text, kind, ...more };
      return [...get().feed, line].slice(-MAX_FEED);
    };
    const agentName = (who: string) => (who === 'chef' ? 'Max' : s.agents[who]?.name ?? 'Un agent');
    switch (ev.k) {
      case 'start': {
        const first = s.feed.length === 0;
        set({
          chef: { ...s.chef, say: '', typing: '', thinkingAt: at }, final: null, showFinal: false,
          busySince: at, feed: ev.text ? feed('Toi', ev.text, 'user') : get().feed,
        });
        if (live && !first) sfx('send');
        break;
      }
      case 'init':
        break;
      case 'think':
        if (ev.who === 'chef') set({ chef: { ...s.chef, thinkingAt: at } });
        if (ev.text) set({ feed: feed(agentName(ev.who), ev.text, 'think') });
        break;
      case 'typing':
        if (ev.who === 'chef') set({ chef: { ...s.chef, typing: ev.text } });
        else if (s.agents[ev.who]) set({ agents: { ...s.agents, [ev.who]: { ...s.agents[ev.who], say: ev.text, sayAt: at } } });
        break;
      case 'say':
        if (ev.who === 'chef') set({ chef: { ...s.chef, say: ev.text, sayAt: at, typing: '' }, feed: feed('Max', ev.long || ev.text, 'chef') });
        else if (s.agents[ev.who]) set({ agents: { ...s.agents, [ev.who]: { ...s.agents[ev.who], say: ev.text, sayAt: at } }, feed: feed(agentName(ev.who), ev.long || ev.text, 'sub') });
        break;
      case 'plan':
        set({ plan: ev.items, planHistory: [...s.planHistory, { at, items: ev.items }].slice(-60) });
        if (live && s.plan.length !== ev.items.length) sfx('plan');
        else if (live && ev.items.filter((i) => i.status === 'completed').length > s.plan.filter((i) => i.status === 'completed').length) sfx('check');
        break;
      case 'hire': {
        // deux robots du même nom dans la salle, ça se confond : le second prend un prénom libre
        const taken = new Set(Object.values(s.agents).filter((x) => x.status === 'working' || x.status === 'reporting').map((x) => x.name));
        const name = !taken.has(ev.name) ? ev.name : (NAMES[ev.role] ?? NAMES.renfort).find((n) => !taken.has(n)) ?? `${ev.name} ${taken.size + 1}`;
        if (name !== ev.name) out = { ...ev, name };
        const a: AgentView = {
          id: ev.id, role: ev.role, name, task: ev.task, prompt: ev.prompt, status: 'working', act: null, acts: [],
          say: '', sayAt: 0, report: '', hiredAt: at, tokens: 0, tools: 0,
        };
        const stats = { ...s.stats };
        countStats(stats, ev);
        set({ agents: { ...s.agents, [ev.id]: a }, order: [...s.order, ev.id], stats, feed: feed('Max', `appelle ${name} : ${ev.task}`, 'hire') });
        if (live) sfx('spawn');
        break;
      }
      case 'act': {
        const act: ActView = { id: ev.id, kind: ev.kind, label: ev.label, detail: ev.detail, at };
        const stats = { ...s.stats };
        countStats(stats, ev);
        if (ev.who === 'chef') set({ chef: { ...s.chef, act, acts: [...s.chef.acts, act].slice(-MAX_ACTS) }, stats });
        else if (s.agents[ev.who]) {
          const a = s.agents[ev.who];
          set({ agents: { ...s.agents, [ev.who]: { ...a, act, acts: [...a.acts, act].slice(-MAX_ACTS) } }, stats });
        } else set({ stats });
        if (ev.kind !== 'plan') set({ feed: feed(agentName(ev.who), ev.label, 'act', { detail: ev.detail && ev.detail !== ev.label ? ev.detail : undefined, actId: ev.id }) });
        if (live && Date.now() - lastActSound > 220) { lastActSound = Date.now(); sfx(ev.kind === 'search' || ev.kind === 'web' ? 'search' : 'tick'); }
        break;
      }
      case 'act_done': {
        const mark = (acts: ActView[]) => acts.map((x) => (x.id === ev.id ? { ...x, ok: ev.ok } : x));
        if (ev.who === 'chef') set({ chef: { ...s.chef, acts: mark(s.chef.acts) } });
        else if (s.agents[ev.who]) set({ agents: { ...s.agents, [ev.who]: { ...s.agents[ev.who], acts: mark(s.agents[ev.who].acts) } } });
        // le résultat de l'action, sur sa ligne du fil (les plus récentes d'abord : c'est presque toujours la dernière)
        for (let i = s.feed.length - 1; i >= 0 && i >= s.feed.length - 80; i--) {
          if (s.feed[i].actId !== ev.id) continue;
          const lines = [...s.feed];
          lines[i] = { ...lines[i], ok: ev.ok };
          set({ feed: lines });
          break;
        }
        break;
      }
      case 'report': {
        const a = s.agents[ev.who];
        if (!a) break;
        set({ agents: { ...s.agents, [ev.who]: { ...a, report: ev.text, status: 'reporting' } }, feed: feed(a.name, ev.text && !/^Travail (rendu|interrompu)$/.test(ev.text) ? `rend son rapport à Max : ${ev.text}` : 'rend son rapport à Max', 'report') });
        if (live) sfx('paper');
        break;
      }
      case 'leave': {
        const a = s.agents[ev.who];
        if (!a) break;
        set({ agents: { ...s.agents, [ev.who]: { ...a, status: ev.ok ? 'done' : 'failed', leftAt: at, tokens: ev.tokens, tools: ev.tools } } });
        break;
      }
      case 'file': {
        const files = [...s.files.filter((f) => f.path !== ev.file.path), ev.file].sort((a, b) => a.at - b.at);
        set({ files, feed: ev.isNew ? feed(agentName(ev.file.by), `a rangé ${ev.file.name}`, 'file') : get().feed });
        if (live && ev.isNew) sfx('print');
        break;
      }
      case 'ask': {
        const ask: AskView = { requestId: ev.requestId, who: ev.who, tool: ev.tool, label: ev.label, detail: ev.detail, full: ev.full, at };
        set({ asks: { ...s.asks, [ev.requestId]: ask }, feed: feed(agentName(ev.who), ev.label, 'ask') });
        if (live) sfx('ask');
        break;
      }
      case 'ask_done': {
        const asks = { ...s.asks };
        delete asks[ev.requestId];
        set({ asks });
        break;
      }
      case 'end': {
        const workMs = s.workMs + (s.busySince ? Math.max(0, at - s.busySince) : 0);
        set({
          final: { ok: ev.ok, text: ev.text, ms: ev.ms, stopped: ev.stopped, at }, busySince: null, workMs, asks: {},
          showFinal: false, feed: feed('Max', ev.ok ? 'Tour terminé.' : ev.stopped ? 'Tour arrêté.' : 'Le tour s’est mal terminé.', 'end'),
        });
        if (live) sfx(ev.ok ? 'done' : 'error');
        break;
      }
      case 'error':
        set({ feed: feed('Max', ev.message, 'error') });
        if (live) get().toast('error', ev.message);
        break;
    }
    bus.emit(out, live);
  },
}));

/** Les membres de l'équipe, dans l'ordre où ils sont arrivés. */
export const teamList = (s: S) => s.order.map((id) => s.agents[id]).filter(Boolean);
