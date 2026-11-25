// Le fil des événements entre la mémoire du bureau (React) et le moteur du jeu (les robots).
import type { OfficeEvent } from '../../shared/protocol.ts';

type Fn = (ev: OfficeEvent, live: boolean) => void;

const listeners = new Set<Fn>();
const resetters = new Set<() => void>();
// Le moteur se charge après le premier affichage : en attendant, les événements sont gardés puis rejoués
// au premier abonné, pour que le bureau en pixel art soit dans le même état que s'il avait tout vu.
let pending: [OfficeEvent, boolean][] | null = [];
const PENDING_MAX = 20000;

export const bus = {
  on(fn: Fn) {
    listeners.add(fn);
    if (pending) { const old = pending; pending = null; for (const [ev, live] of old) fn(ev, live); }
    return () => { listeners.delete(fn); };
  },
  emit(ev: OfficeEvent, live: boolean) {
    if (pending) { if (pending.length < PENDING_MAX) pending.push([ev, live]); return; }
    for (const fn of listeners) fn(ev, live);
  },
  /** nouvelle mission, rediffusion : le bureau se vide, Max revient à l'accueil */
  onReset(fn: () => void) { resetters.add(fn); return () => { resetters.delete(fn); }; },
  reset() { if (pending) pending.length = 0; for (const fn of resetters) fn(); },
};
