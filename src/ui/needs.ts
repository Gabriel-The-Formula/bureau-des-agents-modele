// Ce qui t'attend (« À toi de jouer »), dans un seul ordre partagé par la liste de l'étage et la fiche (où l'on passe
// d'une carte à la suivante en glissant) : les sessions qui attendent ta réponse ou sont bloquées.
import { useMemo } from 'react';
import type { SessionSummary } from '../../shared/live.ts';
import { useOffice } from '../state/store.ts';
import { STATUS_LABEL } from './sessions.ts';

export interface NeedItem {
  /** clé de la fiche : la clé de la salle */
  key: string;
  kind: 'waiting' | 'blocked';
  title: string;
  what: string;
  choices: number;
  at: number;
  session: SessionSummary;
}

export function needsOf(sessions: SessionSummary[]): NeedItem[] {
  const out: NeedItem[] = [];
  for (const s of sessions) {
    if (s.status !== 'waiting' && s.status !== 'blocked') continue;
    // « Attend ta réponse : « On ouvre ? » » : l'étiquette est déjà affichée, on garde la question
    const text = s.decision?.question || (s.statusText || '').replace(/^(attend ta réponse|bloquée)\s*:?\s*/i, '').trim();
    const what = text && text !== STATUS_LABEL[s.status] ? text : s.status === 'waiting' ? 'Une question t’attend dans la salle.' : 'Une permission ou une commande la retient.';
    out.push({ key: s.key, kind: s.status, title: s.doing || s.title, what, choices: s.decision?.options.length ?? 0, at: s.lastActivity, session: s });
  }
  return out.sort((a, b) => b.at - a.at);
}

export function useNeeds(): NeedItem[] {
  const sessions = useOffice((s) => s.sessions);
  return useMemo(() => needsOf(sessions), [sessions]);
}
