// Le fil d'une salle, ligne par ligne, avec ce que chaque ligne est : un message de Max ou d'un sous-agent, un résumé
// de réflexion (rare : la réflexion de Claude n'est presque jamais lisible dans les transcriptions), une action (outil,
// détail, réussie ou non), l'arrivée ou le rapport d'un sous-agent, ton message, la fin d'un tour.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeedLine } from '../state/store.ts';
import { useOffice } from '../state/store.ts';
import { sfx } from '../audio/sfx.ts';
import { PixelIcon, type IconName } from './PixelIcon.tsx';
import { tidy } from './tidy.ts';

const KIND: Record<FeedLine['kind'], { label: string; icon: IconName }> = {
  user: { label: 'Toi', icon: 'hand' },
  chef: { label: 'Message', icon: 'note' },
  sub: { label: 'Message', icon: 'note' },
  think: { label: 'Réflexion', icon: 'eye' },
  hire: { label: 'Arrivée', icon: 'robot' },
  act: { label: 'Action', icon: 'gear' },
  report: { label: 'Rapport', icon: 'paper' },
  file: { label: 'Fichier', icon: 'paper' },
  ask: { label: 'Question', icon: 'help' },
  end: { label: 'Fin du tour', icon: 'check' },
  error: { label: 'Erreur', icon: 'alert' },
};

export type TimelineFilter = 'all' | 'talk' | 'acts' | 'team';
const FILTERS: { id: TimelineFilter; label: string; kinds: FeedLine['kind'][] | null }[] = [
  { id: 'all', label: 'Tout', kinds: null },
  { id: 'talk', label: 'Messages et réflexions', kinds: ['user', 'chef', 'sub', 'think', 'ask', 'end', 'error'] },
  { id: 'acts', label: 'Actions', kinds: ['act', 'file', 'error'] },
  { id: 'team', label: 'Sous-agents', kinds: ['hire', 'report', 'sub'] },
];

const LONG = 240;

function Line({ l }: { l: FeedLine }) {
  const [open, setOpen] = useState(false);
  const k = KIND[l.kind];
  const text = tidy(l.text);
  const long = (l.kind === 'chef' || l.kind === 'sub' || l.kind === 'think' || l.kind === 'report') && text.length > LONG;
  const state = l.kind !== 'act' ? '' : l.ok === undefined ? 'pending' : l.ok ? 'ok' : 'fail';
  return (
    <li className={`tl-line ${l.kind} ${state}`}>
      <span className="tl-time">{new Date(l.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
      <span className="tl-icon" title={k.label}><PixelIcon name={k.icon} size={11} /></span>
      <div className="tl-body">
        <span className="tl-who"><b>{l.who}</b>{l.kind === 'think' && <em>réflexion</em>}{state === 'fail' && <em className="fail">échec</em>}</span>
        <p className={`tl-text ${long && !open ? 'clamp' : ''}`}>{text}</p>
        {l.detail && <span className="tl-detail">{tidy(l.detail)}</span>}
        {long && <button className="tl-more" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Replier' : 'Lire la suite'}</button>}
      </div>
    </li>
  );
}

/** Le fil : les dernières lignes (max) ; reste collé en bas tant qu'on n'est pas remonté le lire. */
export function Timeline({ max, filter = 'all' }: { max?: number; filter?: TimelineFilter }) {
  const feed = useOffice((s) => s.feed);
  const kinds = FILTERS.find((f) => f.id === filter)?.kinds;
  const lines = useMemo(() => {
    const list = kinds ? feed.filter((l) => kinds.includes(l.kind)) : feed;
    return max ? list.slice(-max) : list;
  }, [feed, kinds, max]);
  const box = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  // ce qui défile : la liste elle-même (panneau), ou la fenêtre qui la contient (fil en grand)
  const scroller = () => { const el = box.current; return el && el.scrollHeight > el.clientHeight + 1 ? el : el?.closest<HTMLElement>('.modal-body') ?? el; };
  useEffect(() => {
    const el = scroller();
    if (!el) return;
    const onScroll = () => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [lines.length > 0]);
  useEffect(() => { const el = scroller(); if (el && stick.current) el.scrollTop = el.scrollHeight; }, [lines]);
  if (!lines.length) return <p className="tl-empty">Rien pour l’instant.</p>;
  return (
    <ol className="tlog" ref={box}>
      {lines.map((l) => <Line key={l.id} l={l} />)}
    </ol>
  );
}

/** Le fil en grand (fenêtre de la salle), avec ses filtres. */
export function TimelineFull() {
  const [filter, setFilter] = useState<TimelineFilter>('all');
  return (
    <div className="tl-full">
      <div className="ach-chips" role="tablist" aria-label="Filtrer le fil">
        {FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={filter === f.id} className={`ach-chip ${filter === f.id ? 'on' : ''}`} onClick={() => { if (filter !== f.id) { sfx('click'); setFilter(f.id); } }}>{f.label}</button>
        ))}
      </div>
      <p className="tl-help">
        Ce qui est lisible dans la transcription : les messages de l’agent, ses actions et leur résultat, ses sous-agents.
        La réflexion interne de Claude n’y est presque jamais en clair (elle est chiffrée) ; quand il en écrit un résumé,
        il apparaît ici en « réflexion ».
      </p>
      <Timeline filter={filter} />
    </div>
  );
}
