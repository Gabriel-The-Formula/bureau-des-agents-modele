// Une salle de l'étage = une session Claude Code, montrée comme une mission du bureau. À l'entrée, on rejoue
// son journal (sans son ni mise en scène), puis on recoud ce que le journal a pu perdre : le Worker ne garde
// que les derniers événements, donc un sous-agent peut être là sans son arrivée, ou parti sans son départ.
import { NAMES, emptyStats, roleOfType } from '../../shared/activity.ts';
import type { SessionSummary } from '../../shared/live.ts';
import type { MissionInfo, OfficeEvent, Role } from '../../shared/protocol.ts';
import { bus } from './bus.ts';
import { useOffice } from './store.ts';

export function missionFrom(s: SessionSummary): MissionInfo {
  return {
    id: s.key,
    title: s.title || s.project || 'Session',
    prompt: '',
    folder: '',
    createdAt: s.startedAt,
    workMs: 0,
    status: s.status === 'done' ? 'done' : 'working',
    sessionId: s.sessionId,
    model: s.model,
    stats: emptyStats(),
    files: [],
  };
}

/** Un prénom de robot libre pour ce métier (jamais deux fois le même dans la salle). */
function freeName(role: Role): string {
  const used = new Set(Object.values(useOffice.getState().agents).filter((a) => a.status === 'working' || a.status === 'reporting').map((a) => a.name));
  const pool = NAMES[role] ?? NAMES.renfort;
  return pool.find((n) => !used.has(n)) ?? `${pool[0]} ${used.size + 1}`;
}

/** Entre dans une salle : le bureau se vide, puis le journal se rejoue d'un coup. */
export function loadRoom(session: SessionSummary, log: { at: number; ev: OfficeEvent }[]) {
  const st = useOffice.getState();
  st.resetMission(missionFrom(session));
  // les sous-agents dont l'arrivée est sortie du journal, mais qui y agissent encore : on les fait entrer d'abord
  const hired = new Set(log.flatMap((l) => (l.ev.k === 'hire' ? [l.ev.id] : [])));
  const seen = new Set(log.flatMap((l) => ('who' in l.ev ? [l.ev.who] : [])));
  for (const sa of session.subagents) {
    if (hired.has(sa.id) || (!seen.has(sa.id) && sa.status !== 'working')) continue;
    const role = roleOfType(sa.type);
    useOffice.getState().apply({ k: 'hire', id: sa.id, role, type: sa.type, name: freeName(role), task: sa.task, prompt: sa.task }, sa.startedAt, false);
  }
  for (const l of log) {
    try { useOffice.getState().apply(l.ev, l.at, false); } catch (e) { console.warn('événement ignoré', l.ev, e); }
  }
  useOffice.setState({ roomInfo: session, roomReady: true });
  reconcile(session, false);
}

/**
 * Met le bureau d'accord avec le résumé de la salle. `live` = des animations (mise à jour en direct),
 * sinon tout se range d'un coup (entrée dans la salle).
 */
export function reconcile(session: SessionSummary, live: boolean) {
  const get = useOffice.getState;
  const now = Date.now();
  const running = session.status !== 'done';

  // le chef : à son bureau tant qu'il travaille (même si le « start » est sorti du journal) ;
  // quand il attend ta réponse, il reste là où le journal l'a laissé
  const chefBusy = session.status === 'working' || session.status === 'blocked';
  if (chefBusy && get().busySince === null && !live) {
    useOffice.setState({ busySince: session.startedAt });
    bus.emit({ k: 'start', text: '' }, false);
  }

  // les sous-agents encore au travail mais arrivés avant le début du journal
  for (const sa of session.subagents) {
    const known = get().agents[sa.id];
    if (!known && sa.status === 'working' && running) {
      const role = roleOfType(sa.type);
      get().apply({ k: 'hire', id: sa.id, role, type: sa.type, name: freeName(role), task: sa.task, prompt: sa.task }, sa.startedAt, live);
    }
  }
  // ceux que le résumé dit partis, mais dont le départ n'est pas arrivé : pas de robot fantôme
  for (const sa of session.subagents) {
    const a = get().agents[sa.id];
    if (!a || (a.status !== 'working' && a.status !== 'reporting') || sa.status === 'working') continue;
    // en direct, on laisse quelques secondes au vrai « leave » pour arriver
    if (live && sa.endedAt && now - sa.endedAt < 6000) continue;
    get().apply({ k: 'leave', who: sa.id, ok: sa.status === 'done', tokens: sa.tokens, tools: sa.tools, ms: (sa.endedAt ?? now) - sa.startedAt }, sa.endedAt ?? now, live);
  }
  // le plan au tableau
  if (session.plan.length && JSON.stringify(session.plan) !== JSON.stringify(get().plan)) {
    get().apply({ k: 'plan', items: session.plan }, session.lastActivity, live);
  }
  // la session est finie, mais le journal ne le dit pas : tout le monde rentre
  if (!running && get().busySince !== null && !live) {
    get().apply({ k: 'end', ok: true, text: '', ms: 0 }, session.lastActivity, false);
  }
  const m = get().mission;
  if (m && m.id === session.key) useOffice.setState({ mission: { ...missionFrom(session), stats: m.stats } });
}
