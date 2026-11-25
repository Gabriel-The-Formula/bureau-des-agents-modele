// En bas de l'écran, comme dans un jeu de rôle : Max (l'agent principal de la session) parle, son texte s'écrit
// lettre par lettre. Version en ligne : lecture seule, on ne lui répond pas d'ici.
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ROLES } from '../../shared/activity.ts';
import { sfx } from '../audio/sfx.ts';
import { world } from '../engine/instance.ts';
import { robotSprite } from '../engine/robots.ts';
import { useOffice } from '../state/store.ts';
import { STATUS_LABEL } from './sessions.ts';
import { PixelIcon } from './PixelIcon.tsx';
import { tidy } from './tidy.ts';

const stripMd = (s: string) =>
  tidy(s).replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '').replace(/^\s*[-•]\s+/gm, '• ').replace(/\n{2,}/g, '\n').trim();

/** Le texte de Max, qui s'écrit lettre par lettre, avec un petit « bip » (comme dans les vieux jeux). */
function useTypewriter(text: string, cps = 55) {
  const [n, setN] = useState(0);
  const shown = useRef('');
  useEffect(() => {
    // si le nouveau texte prolonge celui qui s'affiche, on continue ; sinon on recommence
    if (!text.startsWith(shown.current)) setN(0);
  }, [text]);
  useEffect(() => {
    if (n >= text.length) return;
    const t = setTimeout(() => {
      const step = text.length - n > 260 ? 8 : 2;
      setN((x) => Math.min(text.length, x + step));
      if (n % 6 === 0) sfx('blip', 0.85 + Math.random() * 0.3);
    }, (1000 / cps) * 2);
    return () => clearTimeout(t);
  }, [n, text, cps]);
  const out = text.slice(0, Math.min(n, text.length));
  shown.current = out;
  return { out, done: n >= text.length };
}

/** Le visage de Max, en grand, qui cligne des yeux (et sourit quand c'est fini). */
function Portrait({ happy }: { happy: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = ref.current!.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    let blink = 0;
    const draw = () => {
      const chef = world.chef;
      const eyes = happy ? 'happy' : blink > 0 ? 'blink' : chef.eyes === 'blink' ? 'open' : chef.eyes === 'happy' ? 'happy' : chef.eyes;
      g.clearRect(0, 0, 64, 64);
      g.drawImage(robotSprite('chef', 'stand', 'down', 0, eyes), 2, 0, 16, 16, 0, 0, 64, 64);
      if (blink > 0) blink--;
      else if (Math.random() < 0.02) blink = 2;
    };
    draw();
    const t = setInterval(draw, 120);
    return () => clearInterval(t);
  }, [happy]);
  return <canvas ref={ref} width={64} height={64} className="portrait" />;
}

export function Dialog() {
  const connection = useOffice((s) => s.connection);
  const info = useOffice((s) => s.roomInfo);
  const ready = useOffice((s) => s.roomReady);
  const busy = useOffice((s) => s.busySince !== null);
  const replaying = useOffice((s) => s.replaying);
  const chef = useOffice((s) => s.chef);
  const final = useOffice((s) => s.final);

  const fallback = info ? (info.statusText || STATUS_LABEL[info.status]) : '';
  let text: string;
  if (connection === 'offline') text = 'Je ne capte plus le bureau. Je me reconnecte…';
  else if (!ready && !replaying) text = 'J’ouvre la salle…';
  else if (chef.typing) text = stripMd(chef.typing);
  else if (info?.status === 'waiting' || info?.status === 'blocked') text = stripMd(chef.say) || fallback;
  else if (final && !busy) text = stripMd(final.text) || fallback;
  else if (chef.say) text = stripMd(chef.say);
  else text = fallback;

  const { out } = useTypewriter(text);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [out]);

  return (
    <footer className="dialog">
      <div className="dialog-box">
        <div className="dialog-face"><Portrait happy={info?.status === 'done' || (!!final?.ok && !busy)} /></div>
        <div className="dialog-main">
          <div className="dialog-name">Max{info?.doing && <span title={tidy(info.doing)}>{tidy(info.doing)}</span>}{replaying && <em className="pill replay">Rediffusion</em>}</div>
          <div className="dialog-text" ref={box}>{out}<span className="caret" /></div>
        </div>
      </div>
    </footer>
  );
}

/** Une demande de permission en attente : on la montre, la réponse se donne dans Claude Code. */
export function AskBar() {
  const asks = useOffice(useShallow((s) => Object.values(s.asks)));
  const agents = useOffice((s) => s.agents);
  const a = asks[0];
  if (!a) return null;
  const who = a.who === 'chef' ? 'Max' : agents[a.who]?.name ?? 'Un agent';
  const role = a.who === 'chef' ? 'chef' : agents[a.who]?.role ?? 'renfort';
  return (
    <div className="askbar">
      <div className="askbar-head"><PixelIcon name="hand" size={14} /> <b style={{ color: ROLES[role].color }}>{who}</b> attend ta permission{asks.length > 1 ? ` (et ${asks.length - 1} autre${asks.length > 2 ? 's' : ''})` : ''}</div>
      <div className="askbar-label">{tidy(a.label)}</div>
      {!a.full && a.detail && <pre className="askbar-detail">{tidy(a.detail)}</pre>}
      <div className="small muted">Réponds dans Claude Code.</div>
    </div>
  );
}
