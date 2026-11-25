// « Écouter » : le résumé audio d'un rapport (voix de synthèse, fait par le collecteur), sous le titre de la page
// de lecture. Lecture, pause, avance, vitesse 1x, 1,5x ou 2x (retenue d'un rapport à l'autre).
import { useEffect, useRef, useState } from 'react';
import { sfx } from '../audio/sfx.ts';
import { useOffice } from '../state/store.ts';
import { PixelIcon } from './PixelIcon.tsx';

const RATES = [1, 1.5, 2] as const;
const RATE_KEY = 'bureau.audioRate';
const rateLabel = (v: number) => `${String(v).replace('.', ',')}x`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function savedRate(): number {
  try { const v = Number(localStorage.getItem(RATE_KEY)); return (RATES as readonly number[]).includes(v) ? v : 1; } catch { return 1; }
}

export function ReportAudio({ url, seconds }: { url: string; seconds: number }) {
  const el = useRef<HTMLAudioElement | null>(null);
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(seconds);
  const [rate, setRate] = useState(savedRate);
  const toast = useOffice((s) => s.toast);

  // un autre rapport (ou une nouvelle version du son) : on repart du début
  useEffect(() => { setStarted(false); setPlaying(false); setPos(0); setDur(seconds); }, [url, seconds]);
  useEffect(() => { if (el.current) el.current.playbackRate = rate; }, [rate, url]);

  const toggle = () => {
    const a = el.current;
    if (!a) return;
    sfx('click');
    if (a.paused) {
      a.playbackRate = rate;
      setStarted(true);
      a.play().catch((e: unknown) => {
        setPlaying(false);
        // une pause pendant le chargement interrompt play() : ce n'est pas une panne
        if ((e as { name?: string } | null)?.name !== 'AbortError') toast('error', 'Le résumé audio ne se charge pas. Réessaie.');
      });
    } else a.pause();
  };
  const pick = (v: number) => {
    sfx('click');
    setRate(v);
    try { localStorage.setItem(RATE_KEY, String(v)); } catch { /* navigation privée */ }
  };
  const seek = (v: number) => { if (el.current) { el.current.currentTime = v; setPos(v); } };

  return (
    <div className="rp-audio" data-html2canvas-ignore="true">
      <button className="rp-act primary" onClick={toggle} aria-label={playing ? 'Mettre le résumé audio en pause' : 'Écouter le résumé audio'}>
        <PixelIcon name={playing ? 'pause' : 'play'} size={12} />
        <span>{playing ? 'Pause' : started ? 'Reprendre' : 'Écouter'}</span>
      </button>
      {started ? (
        <>
          <input className="rp-audio-seek" type="range" min={0} max={Math.max(1, Math.round(dur))} step={1} value={Math.min(pos, dur)}
            onChange={(e) => seek(Number(e.target.value))} aria-label="Avancer dans le résumé audio" />
          <span className="rp-audio-time">{clock(pos)} / {clock(dur)}</span>
        </>
      ) : (
        <span className="rp-audio-info">Résumé audio · {Math.max(1, Math.round(dur / rate / 60))} min</span>
      )}
      <div className="rp-audio-rates" role="group" aria-label="Vitesse de lecture">
        {RATES.map((v) => (
          <button key={v} className={rate === v ? 'on' : ''} aria-pressed={rate === v} onClick={() => pick(v)}>{rateLabel(v)}</button>
        ))}
      </div>
      <audio ref={el} src={url} preload="none"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => setPlaying(false)} onEnded={() => { setPlaying(false); setStarted(false); setPos(0); }}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDur(d); e.currentTarget.playbackRate = rate; }} />
    </div>
  );
}
