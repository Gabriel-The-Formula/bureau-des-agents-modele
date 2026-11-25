// La barre du haut d'une salle : le retour à l'étage, ce que fait la session (puis titre, statut, projet), ses
// compteurs et son prix, les liens vers les sessions parente et lancées, les réglages d'affichage, et une rangée
// de pastilles pour passer d'une salle à l'autre en un clic.
import { useEffect, useMemo, useRef } from 'react';
import { sfx } from '../audio/sfx.ts';
import { applySound } from '../audio/sound.ts';
import { go } from '../net/link.ts';
import { savePref, useOffice, type Tod } from '../state/store.ts';
import { COST_HINT, ago, fmtCompact, fmtCost } from './format.ts';
import { KinPills } from './Kin.tsx';
import { PixelIcon, type IconName } from './PixelIcon.tsx';
import { STATUS_LABEL, sortSessions, useNow } from './sessions.ts';
import { tidy } from './tidy.ts';
import { toggleTheme, useEffectiveTheme } from './theme.ts';

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }} aria-hidden="true">
      <span className="logo-visor"><i /><i /></span>
    </span>
  );
}

const TOD_NEXT: Record<Tod, Tod> = { auto: 'day', day: 'evening', evening: 'night', night: 'auto' };
const TOD_ICON: Record<Tod, IconName> = { auto: 'clock', day: 'sun', evening: 'sunset', night: 'moon' };
const TOD_LABEL: Record<Tod, string> = { auto: 'Selon l’heure', day: 'Jour', evening: 'Soir', night: 'Nuit' };

export function SoundButton() {
  const sound = useOffice((s) => s.sound);
  return (
    <button
      className={`icon-btn ${sound ? 'on' : ''}`}
      title={sound ? 'Couper le son (M)' : 'Allumer le son (M)'}
      aria-label={sound ? 'Couper le son' : 'Allumer le son'}
      onClick={() => { const v = !sound; useOffice.setState({ sound: v }); savePref('sound', v); applySound(v); sfx('click'); }}
    >
      <PixelIcon name={sound ? 'soundOn' : 'soundOff'} size={16} />
    </button>
  );
}

/** La bascule clair / sombre (elle s'en souvient). */
export function ThemeButton() {
  const theme = useEffectiveTheme();
  const label = theme === 'dark' ? 'Passer en clair' : 'Passer en sombre';
  return (
    <button className="icon-btn" title={label} aria-label={label} onClick={() => { sfx('click'); toggleTheme(theme); }}>
      <PixelIcon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
    </button>
  );
}

export function TopBar() {
  const info = useOffice((s) => s.roomInfo);
  const filming = useOffice((s) => s.filming);
  const tod = useOffice((s) => s.tod);
  const musicOn = useOffice((s) => s.music.playing);
  const replaying = useOffice((s) => s.replaying);
  const now = useNow(10_000);
  const where = info ? [info.project, info.worktree, info.branch && info.branch !== info.worktree ? info.branch : ''].filter(Boolean).join(' · ') : '';

  return (
    <header className="topbar">
      <button className="back-btn" onClick={() => { sfx('click'); go(null); }} title="Revenir à l’étage (Échap)">
        <PixelIcon name="back" size={14} /> L’étage
      </button>

      <div className="mission-head">
        {info ? (
          <>
            <span className={`dot ${info.status}`} title={`${info.statusText && info.statusText !== STATUS_LABEL[info.status] ? tidy(info.statusText) : STATUS_LABEL[info.status]} · ${ago(info.lastActivity, now)}${where ? ` · ${where}` : ''}`} />
            <div className="mh-text">
              <span className="mission-doing" title={tidy(info.doing || info.title)}>{tidy(info.doing || info.title || 'Session')}</span>
              {info.title && info.title !== info.doing && <span className="mh-sub" title={tidy(info.title)}>{tidy(info.title)}</span>}
            </div>
          </>
        ) : <span className="muted">{replaying ? 'Rediffusion' : 'Salle'}</span>}
      </div>

      {info && <KinPills s={info} />}

      {info && (
        <div className="stats">
          <span title="Sous-agents au travail / appelés"><PixelIcon name="robot" size={12} />{info.activeSubagents}/{info.subagents.length}</span>
          <span title="Jetons consommés"><PixelIcon name="coin" size={12} />{fmtCompact(info.tokens)}</span>
          <span className="cost" title={COST_HINT}>{fmtCost(info.cost, info.costPartial)}</span>
        </div>
      )}

      <div className="tools">
        <button className="icon-btn" title="L’équipe" aria-label="L’équipe" onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'team' } }); }}><PixelIcon name="team" size={16} /></button>
        <button className={`icon-btn ${musicOn ? 'on' : ''}`} title="Le jukebox (J)" aria-label="Le jukebox" onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'jukebox' } }); }}><PixelIcon name="note" size={16} /></button>
        <button className="icon-btn" title={`L’heure du bureau : ${TOD_LABEL[tod]} (N)`} aria-label="L’heure du bureau" onClick={() => { sfx('click'); const n = TOD_NEXT[tod]; useOffice.setState({ tod: n }); savePref('tod', n); }}><PixelIcon name={TOD_ICON[tod]} size={16} /></button>
        <ThemeButton />
        <SoundButton />
        <button className={`icon-btn ${filming ? 'on' : ''}`} title="Plein cadre (F)" aria-label="Mode plein cadre" onClick={() => { sfx('click'); useOffice.setState({ filming: !filming }); }}><PixelIcon name="film" size={16} /></button>
      </div>
    </header>
  );
}

/** La rangée des autres salles : une pastille par session, un clic pour y passer. */
export function RoomStrip() {
  const sessions = useOffice((s) => s.sessions);
  const room = useOffice((s) => s.room);
  const list = useMemo(() => sortSessions(sessions).filter((s) => s.status !== 'done' || s.key === room), [sessions, room]);
  const doneCount = sessions.filter((s) => s.status === 'done' && s.key !== room).length;
  const nav = useRef<HTMLElement>(null);
  // la salle ouverte reste visible dans la rangée
  useEffect(() => { nav.current?.querySelector('.here')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [room]);
  if (list.length <= 1 && !doneCount) return null;
  return (
    <nav className="room-strip" aria-label="Les autres salles" ref={nav}>
      {list.map((s) => (
        <button key={s.key} className={`room-pill ${s.status} ${s.key === room ? 'here' : ''}`} onClick={() => { if (s.key !== room) { sfx('click'); go(s.key); } }} title={`${STATUS_LABEL[s.status]} · ${s.project}`} aria-current={s.key === room ? 'page' : undefined}>
          <i />{tidy(s.title || s.project)}
        </button>
      ))}
      {doneCount > 0 && <button className="room-pill more" onClick={() => { sfx('click'); go(null); }}>+ {doneCount} terminée{doneCount > 1 ? 's' : ''}</button>}
    </nav>
  );
}
