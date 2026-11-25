// Le panneau de la salle : ta demande (résumée), le plan (compact), l'équipe (Max puis chaque sous-agent : d'abord ce qu'il fait, puis
// le détail en plus discret : dernière action, jetons, prix) et le fil de ce qui se passe.
import { useEffect, useMemo, useRef } from 'react';
import { ROLES, roleOfType } from '../../shared/activity.ts';
import type { SubagentSummary } from '../../shared/live.ts';
import type { Role } from '../../shared/protocol.ts';
import { sfx } from '../audio/sfx.ts';
import { robotSprite } from '../engine/robots.ts';
import { useOffice } from '../state/store.ts';
import { COST_HINT, ago, fmtCompact, fmtCost, fmtDuration } from './format.ts';
import { STATUS_LABEL, useNow } from './sessions.ts';
import { tidy } from './tidy.ts';
import { Timeline } from './Timeline.tsx';

export function Avatar({ role, size = 32 }: { role: Role; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = ref.current!.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, 20, 24);
    g.drawImage(robotSprite(role, 'stand', 'down', 0, 'open'), 0, 0);
  }, [role]);
  return <canvas ref={ref} width={20} height={24} className="avatar" style={{ width: size * (20 / 24), height: size }} />;
}

const SUB_STATUS: Record<SubagentSummary['status'], string> = { working: 'Au travail', done: 'Fini', failed: 'Pas fini' };

export function Panel() {
  const ready = useOffice((s) => s.roomReady || s.replaying);
  return (
    <aside className="panel">
      {ready ? (
        <>
          <RequestSection />
          <PlanSection />
          <TeamSection />
          <FeedSection />
        </>
      ) : <PanelSkeleton />}
    </aside>
  );
}

function PanelSkeleton() {
  return (
    <>
      {[3, 4, 5].map((n, i) => (
        <section key={i} className="card skel">
          <span className="skel-line w40" />
          {Array.from({ length: n }, (_, j) => <span key={j} className="skel-line" />)}
        </section>
      ))}
    </>
  );
}

/** Ce que tu as demandé à la session : un résumé de ta demande de départ, et de ton dernier message s'il y en a eu d'autres. */
function RequestSection() {
  const req = useOffice((s) => s.roomInfo?.request);
  const now = useNow(30_000);
  if (!req?.first) return null;
  return (
    <section className="card req-card">
      <h3>Ta demande {req.count > 1 && <span className="count">{req.count} messages</span>}</h3>
      <p className="req-text">{tidy(req.first)}</p>
      {req.last && (
        <div className="req-last">
          <span className="req-when">Dernier message{req.lastAt ? ` · ${ago(req.lastAt, now)}` : ''}</span>
          <p className="req-text">{tidy(req.last)}</p>
        </div>
      )}
    </section>
  );
}

function PlanSection() {
  const plan = useOffice((s) => s.plan);
  const list = useRef<HTMLUListElement>(null);
  const cur = plan.findIndex((p) => p.status === 'in_progress');
  // la tâche en cours reste visible dans la liste
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('.in_progress');
    if (el && list.current) list.current.scrollTop = Math.max(0, el.offsetTop - list.current.offsetTop - 24);
  }, [cur]);
  if (!plan.length) return null;
  const done = plan.filter((p) => p.status === 'completed').length;
  return (
    <section className="card plan-card">
      <h3>Le plan <span className="count">{done}/{plan.length}</span></h3>
      <div className="progress"><i style={{ width: `${(done / plan.length) * 100}%` }} /></div>
      <ul className="plan compact" ref={list}>
        {plan.map((p, i) => <li key={i} className={p.status}><i />{tidy(p.text)}</li>)}
      </ul>
    </section>
  );
}

function TeamSection() {
  const info = useOffice((s) => s.roomInfo);
  const agents = useOffice((s) => s.agents);
  const chef = useOffice((s) => s.chef);
  const now = useNow(10_000);
  const subs = useMemo(() => {
    const list = [...(info?.subagents ?? [])];
    // au travail d'abord, puis les plus récents
    return list.sort((a, b) => Number(b.status === 'working') - Number(a.status === 'working') || b.startedAt - a.startedAt);
  }, [info?.subagents]);
  if (!info) return null;
  const subTokens = subs.reduce((n, a) => n + (a.tokens || 0), 0);
  // le prix de Max seul, quand tout est connu : celui de la salle moins celui des sous-agents
  const subCosts = subs.map((a) => a.cost);
  const chefCost = info.cost !== null && !info.costPartial && subCosts.every((c) => typeof c === 'number')
    ? Math.max(0, info.cost - (subCosts as number[]).reduce((n, c) => n + c, 0)) : undefined;
  const chefNow = chef.act && now - chef.act.at < 120_000 ? chef.act.label : info.lastAct;
  return (
    <section className="card">
      <h3>L’équipe <span className="count">{info.activeSubagents ? `${info.activeSubagents} au travail` : `${subs.length} sous-agent${subs.length > 1 ? 's' : ''}`}</span></h3>
      <div className="team">
        <div className={`agent chef ${info.status}`} style={{ ['--c' as string]: ROLES.chef.color }}>
          <button className="agent-head" onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'board' } }); }}>
            <Avatar role="chef" size={30} />
            <div className="agent-id">
              <b className="agent-doing">{tidy(info.doing || info.title || 'Session')}</b>
              <span className="agent-who" title={info.model || undefined}>Max · {STATUS_LABEL[info.status]}</span>
              {chefNow && <span className="agent-now">{tidy(chefNow)}</span>}
            </div>
            <span className="agent-nums">
              <span title="Jetons de Max">{fmtCompact(Math.max(0, info.tokens - subTokens))}</span>
              {chefCost !== undefined && <span className="cost" title={COST_HINT}>{fmtCost(chefCost)}</span>}
            </span>
          </button>
        </div>
        {subs.map((sa) => <SubCard key={sa.id} sa={sa} name={agents[sa.id]?.name} role={agents[sa.id]?.role ?? roleOfType(sa.type)} act={agents[sa.id]?.act?.label} now={now} />)}
      </div>
    </section>
  );
}

function SubCard({ sa, name, role, act, now }: { sa: SubagentSummary; name?: string; role: Role; act?: string; now: number }) {
  const r = ROLES[role];
  const working = sa.status === 'working';
  const last = (working ? act : undefined) ?? sa.lastAct;
  const known = !!useOffice((s) => s.agents[sa.id]);
  const state = working ? (last ? tidy(last) : 'S’installe…') : `${SUB_STATUS[sa.status]}${sa.endedAt ? ` · ${fmtDuration(sa.endedAt - sa.startedAt)} · ${ago(sa.endedAt, now)}` : ''}`;
  return (
    <div className={`agent ${sa.status}`} style={{ ['--c' as string]: r.color }}>
      <button className="agent-head" disabled={!known} onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'agent', id: sa.id } }); }}>
        <Avatar role={role} size={30} />
        <div className="agent-id">
          <b className="agent-doing" title={tidy(sa.task)}>{tidy(sa.task || sa.type)}</b>
          <span className="agent-who" title={sa.type}>{name ?? 'Sous-agent'}{sa.background && <em className="bg-tag">en fond</em>}</span>
          <span className="agent-now">{state}</span>
        </div>
        <span className="agent-nums">
          <span title="Jetons de ce sous-agent">{fmtCompact(sa.tokens)}</span>
          {sa.cost !== undefined && <span className="cost" title={COST_HINT}>{fmtCost(sa.cost)}</span>}
        </span>
        <span className={`agent-status ${sa.status}`} />
      </button>
    </div>
  );
}

function FeedSection() {
  const n = useOffice((s) => s.feed.length);
  if (!n) return null;
  return (
    <section className="card">
      <h3>
        En direct
        <button className="count tl-open" onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'log' } }); }} title="Tout le fil : messages, réflexions, actions, sous-agents">Tout le fil</button>
      </h3>
      <Timeline max={40} />
    </section>
  );
}
