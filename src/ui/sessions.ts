// Ce que les vues partagent sur les salles : les libellés des statuts, l'ordre de l'étage, l'heure qui avance.
import { useEffect, useState } from 'react';
import type { SessionStatus, SessionSummary } from '../../shared/live.ts';

export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: 'En cours', waiting: 'Attend ta réponse', blocked: 'Bloquée', done: 'Terminée',
};
export const STATUS_ORDER: Record<SessionStatus, number> = { waiting: 0, blocked: 1, working: 2, done: 3 };

// L'ordre d'arrivée de chaque salle, gardé pour toute la vie de l'onglet : une salle vue pour la première fois
// prend la place suivante, celles déjà là ne bougent plus (même si l'heure de début d'une autre arrive en retard).
const arrival = new Map<string, number>();
let nextSeat = 0;

/**
 * Les salles dans l'ordre de l'étage : par heure de début, de la plus ancienne à la plus récente, et figé.
 * Le statut ne change plus l'ordre (il est dans la pastille de couleur) ; une nouvelle salle s'ajoute à la fin.
 */
export function sortSessions(list: SessionSummary[]): SessionSummary[] {
  const fresh = list.filter((s) => !arrival.has(s.key)).sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
  for (const s of fresh) arrival.set(s.key, nextSeat++);
  return [...list].sort((a, b) => arrival.get(a.key)! - arrival.get(b.key)!);
}

/** La place d'arrivée d'une salle (pour ranger les machines entre elles sans les faire bouger). */
export const seatOf = (key: string) => arrival.get(key) ?? Number.MAX_SAFE_INTEGER;

/** L'heure, rafraîchie régulièrement (pour les « il y a 2 min »). */
export function useNow(every = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

/** Range chaque session lancée par une autre juste après sa session parente (si elle est dans la même liste). */
export function withChildren(list: SessionSummary[]): { s: SessionSummary; child: boolean }[] {
  const keys = new Set(list.map((s) => s.key));
  const kids = new Map<string, SessionSummary[]>();
  for (const s of list) {
    if (s.parentKey && s.parentKey !== s.key && keys.has(s.parentKey)) kids.set(s.parentKey, [...(kids.get(s.parentKey) ?? []), s]);
  }
  const out: { s: SessionSummary; child: boolean }[] = [];
  const placed = new Set<string>();
  const put = (s: SessionSummary, child: boolean) => {
    if (placed.has(s.key)) return;
    placed.add(s.key);
    out.push({ s, child });
    for (const k of kids.get(s.key) ?? []) put(k, true);
  };
  for (const s of list) if (!(s.parentKey && keys.has(s.parentKey))) put(s, false);
  for (const s of list) put(s, true); // une boucle parent/enfant : on n'oublie personne
  return out;
}

/** Le nom court d'une salle (pour les liens « lancée par »). */
export const roomName = (s: SessionSummary) => s.title || s.doing || s.project || "Session";
