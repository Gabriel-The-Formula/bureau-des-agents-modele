import { createRoot } from 'react-dom/client';
import '@fontsource/pixelify-sans/500.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource-variable/plus-jakarta-sans';
import './styles.css';
import { App, loadRoom } from './App.tsx';
import { applySound } from './audio/sound.ts';
import { jukebox } from './audio/music.ts';
import { connect, go, playReplay } from './net/link.ts';
import { useOffice } from './state/store.ts';
import { applyTheme } from './ui/theme.ts';

applyTheme(useOffice.getState().theme);
applySound(useOffice.getState().sound);
// pour les tests et les captures : le store, le monde, et rejouer un journal depuis la console
const tools: Record<string, unknown> = { playReplay, go, useOffice, jukebox };
(window as unknown as { __bureau: unknown }).__bureau = tools;
connect();
createRoot(document.getElementById('root')!).render(<App />);
// le moteur du bureau en pixel art : après le premier affichage, quand le navigateur a le temps
const idle = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 300));
idle(() => { void loadRoom().then(({ world, perf, camera, party }) => Object.assign(tools, { world, perf, camera, party })); }, { timeout: 3000 });
