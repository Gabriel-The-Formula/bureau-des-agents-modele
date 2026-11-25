// Le bouton du son coupe tout : les bruitages et la musique du jukebox.
import { jukebox } from './music.ts';
import { setMuted } from './sfx.ts';

export function applySound(on: boolean) {
  setMuted(!on);
  jukebox.setMuted(!on);
}
