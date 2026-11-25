// Les liens entre sessions : celle qui a lancé cette salle, et celles qu'elle a lancées. Un clic, on y passe.
import type { MouseEvent } from 'react';
import type { SessionSummary } from '../../shared/live.ts';
import { sfx } from '../audio/sfx.ts';
import { go } from '../net/link.ts';
import { useOffice } from '../state/store.ts';
import { PixelIcon } from './PixelIcon.tsx';
import { roomName } from './sessions.ts';
import { tidy } from './tidy.ts';

const open = (key: string) => (e: MouseEvent) => { e.stopPropagation(); sfx('open'); go(key); };

/** Sur une carte de l'étage : « lancée par X » et « 2 sessions lancées ». */
export function KinLine({ s }: { s: SessionSummary }) {
  const sessions = useOffice((st) => st.sessions);
  const parent = s.parentKey ? sessions.find((x) => x.key === s.parentKey) : undefined;
  const kids = (s.childKeys ?? []).filter((k) => k !== s.key);
  if (!s.parentKey && !kids.length) return null;
  const firstKid = kids.find((k) => sessions.some((x) => x.key === k));
  return (
    <span className="kin-line">
      {s.parentKey && (parent
        ? <button className="kin-link" onClick={open(parent.key)} title="Ouvrir la session parente"><PixelIcon name="link" size={10} />lancée par <b>{tidy(roomName(parent))}</b></button>
        : <span className="kin-link off"><PixelIcon name="link" size={10} />lancée par une autre session</span>)}
      {kids.length > 0 && (firstKid && kids.length === 1
        ? <button className="kin-link" onClick={open(firstKid)} title="Ouvrir la session lancée"><PixelIcon name="branch" size={10} />1 session lancée</button>
        : <span className="kin-link off"><PixelIcon name="branch" size={10} />{kids.length} sessions lancées</span>)}
    </span>
  );
}

/** Dans une salle : des pastilles vers la session parente et les sessions lancées. */
export function KinPills({ s }: { s: SessionSummary }) {
  const sessions = useOffice((st) => st.sessions);
  const parent = s.parentKey ? sessions.find((x) => x.key === s.parentKey) : undefined;
  const kids = (s.childKeys ?? []).map((k) => sessions.find((x) => x.key === k)).filter((x): x is SessionSummary => !!x && x.key !== s.key);
  if (!parent && !kids.length) return null;
  return (
    <div className="kin-pills">
      {parent && (
        <button className={`room-pill kin ${parent.status}`} onClick={open(parent.key)} title="Session parente">
          <PixelIcon name="back" size={10} /><span>{tidy(roomName(parent))}</span>
        </button>
      )}
      {kids.map((k) => (
        <button key={k.key} className={`room-pill kin ${k.status}`} onClick={open(k.key)} title="Session lancée par celle-ci">
          <i /><span>{tidy(roomName(k))}</span>
        </button>
      ))}
    </div>
  );
}
