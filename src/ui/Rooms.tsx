// Les fenêtres qu'on ouvre en cliquant dans le bureau. Tout y vient de la session Claude Code suivie :
// la fiche d'un sous-agent (sa tâche, ses actions, son rapport), le plan de Max et son historique,
// l'équipe et les métiers, la machine (la session), l'horloge et le jukebox.
import { useEffect, useMemo, useState } from 'react';
import { ROLE_TOOLS, ROLES, TOOL_INFO } from '../../shared/activity.ts';
import type { PlanItem, Role } from '../../shared/protocol.ts';
import { jukebox, TRACKS } from '../audio/music.ts';
import { sfx } from '../audio/sfx.ts';
import { world } from '../engine/instance.ts';
import { savePref, teamList, useOffice, type ActView, type Tod } from '../state/store.ts';
import { useShallow } from 'zustand/react/shallow';
import { ago, fmtClock, fmtCompact, fmtDate, fmtDuration, plural } from './format.ts';
import { party } from './interact.ts';
import { mdToHtml } from './md.ts';
import { Avatar } from './Panel.tsx';
import { ACT_ICON, PixelIcon } from './PixelIcon.tsx';
import { tidy } from './tidy.ts';
import { TimelineFull } from './Timeline.tsx';

function Shell({ title, sub, wide, children, onClose }: { title: React.ReactNode; sub?: React.ReactNode; wide?: boolean; children: React.ReactNode; onClose?: () => void }) {
  const close = onClose ?? (() => useOffice.setState({ modal: null }));
  return (
    <div className="modal-back" onClick={close}>
      <div className={`modal room ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="room-title"><b>{title}</b>{sub && <span>{sub}</span>}</div>
          <button className="close" onClick={close} aria-label="Fermer">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Les fenêtres du bureau (une seule ouverte à la fois). */
export function Rooms() {
  const modal = useOffice((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'agent': return <AgentRoom id={modal.id} />;
    case 'board': return <BoardRoom />;
    case 'clock': return <ClockRoom />;
    case 'machine': return <MachineRoom />;
    case 'jukebox': return <JukeboxRoom />;
    case 'team': return <TeamRoom role={modal.role} />;
    case 'log': return <Shell title="Le fil de la session" sub="Messages, réflexions, actions et sous-agents, du plus ancien au plus récent" wide><TimelineFull /></Shell>;
  }
}

// ── La fiche d'un agent ──
function AgentRoom({ id }: { id: string }) {
  const a = useOffice((s) => s.agents[id]);
  const live = world.actors.get(id);
  const html = useMemo(() => (a?.report ? mdToHtml(tidy(a.report)) : ''), [a?.report]);
  if (!a) return <Shell title="Cet agent n’est plus là">Il a quitté le bureau.</Shell>;
  const role = ROLES[a.role];
  const working = a.status === 'working' || a.status === 'reporting';
  return (
    <Shell title={<>{a.name}</>} sub={`${role.label} · ${a.task}`}>
      <div className="agent-hero" style={{ ['--c' as string]: role.color }}>
        <Avatar role={a.role} size={72} />
        <div>
          <span className={`pill-status ${a.status}`}>{working ? (live?.seated ? 'Au travail' : 'En chemin') : a.status === 'done' ? 'A rendu son travail' : 'N’a pas pu finir'}</span>
          <p className="now">{working && a.act ? <><i><PixelIcon name={ACT_ICON[a.act.kind]} size={14} /></i>{tidy(a.act.label)}</> : a.status === 'done' ? 'Son rapport est sur le bureau de Max.' : working ? 'Il s’installe à son poste…' : ''}</p>
          <p className="small muted">Un vrai sous-agent Claude Code, appelé par l’agent principal de la session.</p>
        </div>
      </div>
      <section className="room-sec">
        <h4>Sa tâche, donnée par Max</h4>
        <p className="brief">{tidy(a.prompt)}</p>
      </section>
      {a.acts.length > 0 && (
        <section className="room-sec">
          <h4>Ce qu’il a fait <span className="count">{plural(a.acts.length, 'action', 'actions')}</span></h4>
          <ActList acts={a.acts} />
        </section>
      )}
      {html && (
        <section className="room-sec">
          <h4>Son rapport</h4>
          <div className="md report" dangerouslySetInnerHTML={{ __html: html }} />
        </section>
      )}
      {a.leftAt && (
        <p className="small muted">{fmtDuration(a.leftAt - a.hiredAt)} de travail{a.tools ? ` · ${plural(a.tools, 'outil utilisé', 'outils utilisés')}` : ''}{a.tokens ? ` · ${a.tokens.toLocaleString('fr-FR')} jetons` : ''}</p>
      )}
    </Shell>
  );
}

function ActList({ acts }: { acts: ActView[] }) {
  return (
    <ul className="act-list">
      {acts.slice(-40).map((x) => (
        <li key={x.id} className={x.ok === false ? 'fail' : ''}>
          <i><PixelIcon name={ACT_ICON[x.kind]} size={12} /></i>
          <div>
            <span>{tidy(x.label)}</span>
            {x.detail && x.detail !== x.label && <code>{(() => { const d = tidy(x.detail); return d.length > 160 ? d.slice(0, 159) + '…' : d; })()}</code>}
          </div>
          <time>{new Date(x.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
        </li>
      ))}
    </ul>
  );
}

// ── Le tableau : le plan, qui fait quoi, et l'historique du plan ──
function planChanges(prev: PlanItem[] | null, next: PlanItem[]): string[] {
  if (!prev) return [`Max écrit le plan : ${plural(next.length, 'étape', 'étapes')}`];
  const out: string[] = [];
  for (const it of next) {
    const before = prev.find((p) => p.text === it.text);
    if (!before) out.push(`+ ${it.text}`);
    else if (before.status !== it.status && it.status === 'completed') out.push(`Fait : ${it.text}`);
    else if (before.status !== it.status && it.status === 'in_progress') out.push(`En cours : ${it.text}`);
  }
  return out;
}

function BoardRoom() {
  const plan = useOffice((s) => s.plan);
  const history = useOffice((s) => s.planHistory);
  const team = useOffice(useShallow(teamList));
  const done = plan.filter((p) => p.status === 'completed').length;
  const steps = useMemo(() => history.map((h, i) => ({ at: h.at, lines: planChanges(i ? history[i - 1].items : null, h.items) })).filter((x) => x.lines.length), [history]);
  return (
    <Shell title="Le tableau de Max" sub={plan.length ? `${done} étape${done > 1 ? 's' : ''} faite${done > 1 ? 's' : ''} sur ${plan.length}` : 'Le plan de la mission, et qui fait quoi'}>
      {plan.length > 0 ? (
        <>
          <div className="progress"><i style={{ width: `${(done / plan.length) * 100}%` }} /></div>
          <ul className="plan big">{plan.map((p, i) => <li key={i} className={p.status}><i />{p.text}</li>)}</ul>
        </>
      ) : <p className="muted">Pas encore de plan dans cette session.</p>}
      <section className="room-sec">
        <h4>Qui fait quoi <span className="count">{plural(team.length, 'agent', 'agents')}</span></h4>
        {team.length ? (
          <div className="who">
            {team.map((a) => (
              <button key={a.id} className={`who-row ${a.status}`} style={{ ['--c' as string]: ROLES[a.role].color }} onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'agent', id: a.id } }); }}>
                <Avatar role={a.role} size={26} />
                <b>{a.name}</b>
                <span className="who-task">{a.task}</span>
                <span className="who-state">{a.status === 'done' ? 'Rapport rendu' : a.status === 'failed' ? 'Pas fini' : a.status === 'reporting' ? 'Rend son rapport' : 'Au travail'}</span>
              </button>
            ))}
          </div>
        ) : <p className="muted small">Personne pour l’instant.</p>}
      </section>
      {steps.length > 0 && (
        <section className="room-sec">
          <h4>L’historique du plan</h4>
          <ol className="timeline">
            {steps.map((s, i) => (
              <li key={i}>
                <time>{new Date(s.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                <div>{s.lines.map((l, j) => <span key={j}>{l}</span>)}</div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </Shell>
  );
}

// ── L'horloge ──
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return now;
}

const TODS: [Tod, string][] = [['auto', 'Selon l’heure'], ['day', 'Jour'], ['evening', 'Soir'], ['night', 'Nuit']];

function ClockRoom() {
  const now = useClock();
  const tod = useOffice((s) => s.tod);
  const info = useOffice((s) => s.roomInfo);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return (
    <Shell title="L’horloge du bureau" sub={now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}>
      <div className="big-clock"><span>{hh}</span><i>:</i><span>{mm}</span><small>{ss}</small></div>
      {info && <p className="center">Session ouverte depuis <b>{fmtClock(now.getTime() - info.startedAt)}</b> · dernière activité {ago(info.lastActivity, now.getTime())}</p>}
      <p className="center muted small">Ton équipe ne dort jamais : elle travaille à 3 h du matin comme à midi.</p>
      <div className="seg">
        {TODS.map(([v, l]) => (
          <button key={v} className={tod === v ? 'on' : ''} onClick={() => { sfx('click'); useOffice.setState({ tod: v }); savePref('tod', v); }}>{l}</button>
        ))}
      </div>
    </Shell>
  );
}

// ── La machine (le serveur) : la session Claude Code suivie ──
function MachineRoom() {
  const info = useOffice((s) => s.roomInfo);
  const sources = useOffice((s) => s.sources);
  if (!info) return <Shell title="La machine">Aucune session ouverte.</Shell>;
  const src = sources.find((x) => x.id === info.sourceId);
  const rows: [string, React.ReactNode][] = [
    ['Machine', src?.label ?? 'inconnue'],
    ['Projet', info.project || '-'],
    ['Worktree', info.worktree || 'aucun'],
    ['Branche', info.branch || '-'],
    ['Lancée depuis', info.entrypoint || '-'],
    ['Modèle', info.model || '-'],
    ['Ouverte', `${fmtDate(info.startedAt)} (${ago(info.startedAt)})`],
    ['Jetons', fmtCompact(info.tokens)],
    ['Outils utilisés', String(info.tools)],
  ];
  return (
    <Shell title="La machine" sub="La session Claude Code de cette salle">
      <dl className="kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <p className="small muted">Le bureau ne reçoit que des résumés : le nom de chaque outil, la tâche de chaque sous-agent, l’avancement du plan. Jamais la conversation complète, et les secrets sont masqués avant l’envoi.</p>
    </Shell>
  );
}

// ── Le jukebox ──
function JukeboxRoom() {
  const music = useOffice((s) => s.music);
  const tr = TRACKS[music.index];
  return (
    <Shell title="Le jukebox" sub="De la house pour bosser (ou pour l’afterwork)">
      <div className="now-playing">
        <div className={`vinyl ${music.playing ? 'spin' : ''}`}><i /></div>
        <div>
          <b>{tr.title}</b>
          <span>{tr.mood}</span>
          <div className="row">
            <button className="btn small" onClick={() => jukebox.prev()} aria-label="Morceau précédent"><PixelIcon name="prev" size={12} /></button>
            <button className="btn primary small" onClick={() => jukebox.toggle()}><PixelIcon name={music.playing ? 'pause' : 'play'} size={12} /> {music.playing ? 'Pause' : 'Lecture'}</button>
            <button className="btn small" onClick={() => jukebox.next()} aria-label="Morceau suivant"><PixelIcon name="next" size={12} /></button>
          </div>
        </div>
      </div>
      <label className="field volume">
        <span>Volume</span>
        <input type="range" min={0} max={1} step={0.01} value={music.volume} onChange={(e) => jukebox.setVolume(Number(e.target.value))} />
      </label>
      <ul className="tracks">
        {TRACKS.map((t, i) => (
          <li key={t.id}>
            <button className={i === music.index ? 'on' : ''} onClick={() => jukebox.play(i)}>
              <span>{i === music.index && music.playing ? <PixelIcon name="note" size={11} /> : i + 1}</span>
              <b>{t.title}</b>
              <em>{t.mood}</em>
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="btn" onClick={() => { useOffice.setState({ modal: null }); party(); }}><PixelIcon name="disco" size={12} /> Mode soirée</button>
        <span className="small muted">Morceaux originaux, composés pour le bureau avec ElevenLabs Music et Google Lyria.</span>
      </div>
    </Shell>
  );
}

// ── Toute l'équipe : la session en cours et les métiers ──
function TeamRoom({ role }: { role?: Role }) {
  const [tab, setTab] = useState<'roles' | 'now'>(role ? 'roles' : 'now');
  const team = useOffice(useShallow(teamList));
  const working = (r: Role) => [...world.actors.values()].filter((a) => a.role === r && a.seated).length;
  const roles: Role[] = ['chef', 'recherche', 'code', 'design', 'redaction', 'analyse', 'renfort'];
  return (
    <Shell title="Toute l’équipe" sub="De vrais sous-agents Claude Code, chacun avec sa tâche" wide>
      <div className="seg tabs">
        <button className={tab === 'now' ? 'on' : ''} onClick={() => setTab('now')}>Cette session</button>
        <button className={tab === 'roles' ? 'on' : ''} onClick={() => setTab('roles')}>Les métiers</button>
      </div>
      {tab === 'now' && (team.length ? (
        <div className="who">
          {team.map((a) => (
            <button key={a.id} className={`who-row ${a.status}`} style={{ ['--c' as string]: ROLES[a.role].color }} onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'agent', id: a.id } }); }}>
              <Avatar role={a.role} size={26} />
              <b>{a.name}</b>
              <span className="who-task">{a.task}</span>
              <span className="who-state">{a.status === 'done' ? 'Rapport rendu' : a.status === 'failed' ? 'Pas fini' : a.act ? tidy(a.act.label) : 'Au travail'}</span>
            </button>
          ))}
        </div>
      ) : <p className="muted">Pas de sous-agent dans cette session pour l’instant.</p>)}
      {tab === 'roles' && (
        <div className="roles">
          {roles.map((r) => (
            <div key={r} className={`role-card ${role === r ? 'focus' : ''}`} style={{ ['--c' as string]: ROLES[r].color }}>
              <div className="role-head"><Avatar role={r} size={34} /><div><b>{ROLES[r].label}</b><span>{r === 'chef' ? 'Max, l’agent principal' : ROLES[r].type ? `agent « ${ROLES[r].type} »` : 'tous les autres types d’agents'}</span></div>{working(r) > 0 && <em>{working(r)} au travail</em>}</div>
              <p>{ROLES[r].what}</p>
              {ROLE_TOOLS[r].length > 0 && <div className="tools">{ROLE_TOOLS[r].map((t) => <span key={t} title={TOOL_INFO[t] ?? t}>{t}<small>{TOOL_INFO[t] ?? ''}</small></span>)}</div>}
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
