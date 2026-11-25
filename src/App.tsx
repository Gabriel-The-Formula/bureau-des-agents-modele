// L'écran du bureau. Par défaut, l'étage : une salle par session Claude Code suivie. Dans une salle : la barre
// du haut, le bureau en pixel art (avec le panneau de l'équipe à droite, ou dessous sur une tablette en hauteur)
// et Max en bas. Version en ligne : on regarde, on ne pilote rien.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { jukebox } from './audio/music.ts';
import { sfx } from './audio/sfx.ts';
import { applySound } from './audio/sound.ts';
import { go } from './net/link.ts';
import { savePref, useOffice, type Tod } from './state/store.ts';
import { Floor } from './ui/Floor.tsx';
import { Toasts } from './ui/Modals.tsx';
import { ReportReader } from './ui/Reports.tsx';
import { Sheets } from './ui/Sheets.tsx';

// Le bureau en pixel art (moteur, salles, Max) vit dans son propre fichier, chargé après le premier affichage de
// l'étage : l'étage s'ouvre sans attendre le moteur.
export const loadRoom = () => import('./ui/RoomView.tsx');
const RoomView = lazy(() => loadRoom().then((m) => ({ default: m.RoomView })));
const Rooms = lazy(() => loadRoom().then((m) => ({ default: m.Rooms })));

const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];

const TOD_NEXT: Record<Tod, Tod> = { auto: 'day', day: 'evening', evening: 'night', night: 'auto' };

/** En plein cadre : de quoi en sortir, qui n'apparaît que quand la souris bouge (l'image reste propre). */
function ExitFilming() {
  const [shown, setShown] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraAuto = useOffice((s) => s.cameraAuto);
  useEffect(() => {
    const wake = () => {
      setShown(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setShown(false), 2500);
    };
    wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    return () => { window.removeEventListener('pointermove', wake); window.removeEventListener('pointerdown', wake); if (timer.current) clearTimeout(timer.current); };
  }, []);
  return (
    <div className={`exit-filming ${shown ? 'shown' : ''}`}>
      <button onClick={() => { useOffice.setState({ cameraAuto: !cameraAuto }); savePref('cameraAuto', !cameraAuto); }}>{cameraAuto ? 'Caméra auto : oui' : 'Caméra auto : non'}</button>
      <button className="quit" onClick={() => useOffice.setState({ filming: false })}>Quitter le plein cadre (F ou Échap)</button>
    </div>
  );
}

export function App() {
  const view = useOffice((s) => s.view);
  const portrait = useOffice((s) => s.portrait);
  const filming = useOffice((s) => s.filming && s.view === 'room');

  // un écran en hauteur (tablette en portrait) : le panneau passe sous le bureau
  useEffect(() => {
    const onResize = () => useOffice.setState({ portrait: window.innerWidth / Math.max(1, window.innerHeight) < 0.8 });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    let combo: string[] = [];
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useOffice.getState();
      const k = e.key.toLowerCase();
      if (k === 'm') { useOffice.setState({ sound: !s.sound }); savePref('sound', !s.sound); applySound(!s.sound); return; }
      if (s.view !== 'room') return;
      // le code secret (↑ ↑ ↓ ↓ ← → ← → B A) : le mode soirée
      combo = [...combo, k].slice(-KONAMI.length);
      if (combo.join() === KONAMI.join()) { combo = []; void loadRoom().then((m) => m.party()); return; }
      if (k === 'escape') {
        if (s.sheet) return; // la fiche se ferme toute seule (Sheets.tsx)
        if (s.modal) { useOffice.setState({ modal: null }); return; }
        if (s.filming) { useOffice.setState({ filming: false }); return; }
        go(null);
        return;
      }
      if (k === 'c') { useOffice.setState({ cameraAuto: !s.cameraAuto }); savePref('cameraAuto', !s.cameraAuto); sfx('click'); return; }
      if (k === 'j') { jukebox.toggle(); return; }
      if (k === 'f') { useOffice.setState({ filming: !s.filming }); sfx('click'); }
      else if (k === 'n') { const n = TOD_NEXT[s.tod]; useOffice.setState({ tod: n }); savePref('tod', n); sfx('click'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app ${portrait ? 'vertical' : ''} ${filming ? 'filming' : ''}`}>
      {view === 'floor' ? <div className="frame floor-frame view-in" key="floor"><Floor /></div> : <Suspense fallback={null}><RoomView /></Suspense>}
      {filming && <ExitFilming />}
      {view === 'room' && <Suspense fallback={null}><Rooms /></Suspense>}
      <ReportReader />
      <Sheets />
      <Toasts />
    </div>
  );
}
