// La connexion au Worker (version en ligne, lecture seule). Une seule WebSocket sur /ws, même origine : le cookie
// de session est déjà posé par la page de connexion du Worker. On reçoit la liste des salles (l'étage), et quand
// on entre dans une salle, son journal puis ses événements en direct.
import type { DayStats, FeedEntry, LiveClientMsg, LiveServerMsg, SessionSummary, SourceInfo } from '../../shared/live.ts';
import type { Logged, MissionInfo } from '../../shared/protocol.ts';
import { loadRoom, missionFrom, reconcile } from '../state/room.ts';
import { useOffice } from '../state/store.ts';

let ws: WebSocket | null = null;
let retry = 0;
/** fermetures avant même l'ouverture, d'affilée : souvent une session expirée (401) */
let failedOpens = 0;
let build = '';
let player: { stop: () => void } | null = null;

const RELOAD_KEY = 'bureau:reloadedAt';

// ── L'étage gardé dans le navigateur ──
// Au rechargement, la page affiche tout de suite le dernier étage connu (marqué « mise à jour… ») au lieu d'un écran
// vide, puis le remplace dès que le Worker répond. Effacé à la déconnexion (en-tête Clear-Site-Data de /logout).
const SNAP_KEY = 'bureau:snapshot';
/** au-delà, l'étage gardé est trop vieux pour être montré */
const SNAP_MAX_AGE = 3 * 24 * 3600_000;
const SNAP_FEED_MAX = 150;
interface Snapshot { at: number; sessions: SessionSummary[]; sources: SourceInfo[]; day: DayStats | null; feed: FeedEntry[] }

function restoreSnapshot() {
  let snap: Snapshot | null = null;
  try { snap = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null'); } catch { return; }
  if (!snap || !Array.isArray(snap.sessions) || Date.now() - (snap.at || 0) > SNAP_MAX_AGE) return;
  const st = useOffice.getState();
  if (st.loaded) return;
  useOffice.setState({ sessions: snap.sessions, sources: snap.sources ?? [], day: snap.day ?? null, achievements: snap.feed ?? [], stale: true });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveSnapshot() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const st = useOffice.getState();
    if (!st.loaded) return;
    const snap: Snapshot = { at: Date.now(), sessions: st.sessions, sources: st.sources, day: st.day, feed: st.achievements.slice(0, SNAP_FEED_MAX) };
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(snap)); } catch { /* plein ou navigation privée : tant pis */ }
  }, 2000);
}

function send(m: LiveClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

// ── La salle courante, gardée dans l'adresse (#s=<clé>) : un rechargement y revient ──
function hashKey(): string | null {
  const m = location.hash.match(/^#s=(.+)$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

/** Ouvre une salle (ou revient à l'étage avec null). Passe par l'adresse : le bouton « retour » du navigateur marche. */
export function go(key: string | null) {
  if (key) {
    const h = `#s=${encodeURIComponent(key)}`;
    if (location.hash !== h) location.hash = h;
    else openRoom(key);
  } else if (location.hash) {
    history.pushState(null, '', location.pathname + location.search);
    openRoom(null);
  } else openRoom(null);
}

function openRoom(key: string | null, force = false) {
  const st = useOffice.getState();
  if (!force && key === st.room && (key === null || st.view === 'room')) return;
  if (key === null) {
    useOffice.setState({ room: null, roomInfo: null, roomReady: false, view: 'floor', modal: null, roomPinned: false });
    st.resetMission(null);
    send({ t: 'watch', key: null });
    return;
  }
  const info = st.sessions.find((s) => s.key === key) ?? null;
  // tant que la liste n'est pas arrivée, on attend (le « hello » rappellera)
  if (!st.loaded || st.connection !== 'live') {
    // l'étage gardé dans le navigateur la connaît : on entre déjà (le journal arrivera avec la connexion)
    if (info) { useOffice.setState({ room: key, roomInfo: info, roomReady: false, view: 'room', modal: null }); st.resetMission(missionFrom(info)); }
    else useOffice.setState({ room: key });
    return;
  }
  // une salle qui n'est plus à l'étage (terminée depuis plus de 12 h) : le Worker la garde encore 3 jours ; il
  // répond par son journal (« room ») ou par « gone »
  useOffice.setState({ room: key, roomInfo: info, roomReady: false, view: 'room', modal: null, roomPinned: !info });
  st.resetMission(info ? missionFrom(info) : null);
  send({ t: 'watch', key });
}

window.addEventListener('hashchange', () => openRoom(hashKey()));
window.addEventListener('popstate', () => openRoom(hashKey()));

function onSessions(sessions: SessionSummary[], sources: SourceInfo[]) {
  useOffice.setState({ sessions, sources });
  const st = useOffice.getState();
  if (!st.room) return;
  const info = sessions.find((s) => s.key === st.room);
  if (!info) {
    // ouverte depuis une réalisation : elle n'est pas à l'étage, on y reste
    if (st.roomPinned) return;
    // la salle ouverte a disparu de la liste : retour à l'étage
    if (st.view === 'room') st.toast('info', 'Cette session n’est plus suivie : retour à l’étage.');
    go(null);
    return;
  }
  if (st.roomPinned) useOffice.setState({ roomPinned: false });
  if (st.view !== 'room') { openRoom(st.room); return; }
  useOffice.setState({ roomInfo: info });
  if (st.roomReady) reconcile(info, true);
}

function receive(m: LiveServerMsg) {
  switch (m.t) {
    case 'hello': {
      if (m.build && m.build !== 'dev') {
        // le bureau a été mis à jour depuis l'ouverture de l'onglet : on recharge la page
        if (build && build !== m.build) { location.reload(); return; }
        build = m.build;
      }
      const wanted = useOffice.getState().room ?? hashKey();
      useOffice.setState({ sessions: m.sessions, sources: m.sources, day: m.day ?? null, loaded: true, stale: false });
      // un Worker plus ancien envoie le fil dans le « hello »
      if (m.feed) useOffice.setState({ achievements: m.feed, feedLoaded: true });
      saveSnapshot();
      // première connexion ou reconnexion : on (re)demande le journal de la salle ouverte (le Worker répond « gone »
      // s'il ne la garde plus)
      if (wanted) openRoom(wanted, true);
      break;
    }
    case 'sessions':
      onSessions(m.sessions, m.sources);
      saveSnapshot();
      break;
    case 'day':
      useOffice.setState({ day: m.day });
      saveSnapshot();
      break;
    case 'feed':
      useOffice.setState({ achievements: m.feed, feedLoaded: true });
      saveSnapshot();
      break;
    case 'gone': {
      const st = useOffice.getState();
      if (st.room !== m.key) break;
      st.toast('info', 'Cette conversation n’est plus gardée (plus de 3 jours) : retour à l’étage.');
      go(null);
      break;
    }
    case 'room': {
      const st = useOffice.getState();
      if (st.room !== m.session.key) break;
      loadRoom(m.session, m.log ?? []);
      break;
    }
    case 'ev': {
      const st = useOffice.getState();
      if (st.room !== m.key || !st.roomReady || st.replaying) break;
      st.apply(m.ev, m.at, true);
      break;
    }
  }
}

let restored = false;

export function connect() {
  if (!restored) { restored = true; restoreSnapshot(); }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  ws = socket;
  let opened = false;
  socket.onopen = () => {
    opened = true;
    retry = 0;
    failedOpens = 0;
    useOffice.setState({ connection: 'live' });
  };
  socket.onmessage = (e) => {
    let m: LiveServerMsg;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    receive(m);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    useOffice.setState({ connection: opened ? 'connecting' : 'offline' });
    if (!opened) {
      failedOpens++;
      // refusée plusieurs fois avant ouverture : la session a sans doute expiré. On recharge la page, le Worker
      // renverra vers la connexion (au plus une fois par minute, pour ne pas boucler si le Worker est en panne).
      if (failedOpens >= 3) {
        let last = 0;
        try { last = Number(sessionStorage.getItem(RELOAD_KEY) || 0); } catch { /* navigation privée */ }
        if (Date.now() - last > 60_000) {
          try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* navigation privée */ }
          location.reload();
          return;
        }
      }
    }
    setTimeout(connect, Math.min(10_000, 600 * 2 ** retry++) + Math.random() * 400);
  };
}

/**
 * Rejoue un journal enregistré dans le bureau (outil de test, depuis la console : `__bureau.playReplay`).
 * Le rythme d'origine est gardé, les longues pauses raccourcies.
 */
export function playReplay(mission: MissionInfo, log: Logged[], speed = 1) {
  player?.stop();
  const st = useOffice.getState();
  useOffice.setState({ replaying: true, view: 'room' });
  st.resetMission({ ...mission, status: 'working' });
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const start = Date.now();
  let i = 0;
  let virt = 0;
  const step = () => {
    if (cancelled || i >= log.length) return;
    const l = log[i++];
    useOffice.getState().apply(l.ev, start + virt, true);
    if (i < log.length) {
      const gap = Math.min(2500, Math.max(0, log[i].at - l.at) / speed);
      virt += gap;
      timer = setTimeout(step, gap);
    }
  };
  timer = setTimeout(step, 600);
  player = { stop: () => { cancelled = true; if (timer) clearTimeout(timer); useOffice.setState({ replaying: false }); } };
  return player;
}
