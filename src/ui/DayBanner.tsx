// Le bandeau du haut de l'étage, en 3 cases : ce qui a été fini aujourd'hui (tâches du plan cochées, sessions
// terminées), le coût du jour en équivalent API, et le cumul des jetons depuis le début du suivi.
import type { TokenTotal } from '../../shared/live.ts';
import { useOffice } from '../state/store.ts';
import { COST_HINT, fmtCost, fmtTokensWords, plural } from './format.ts';
import { PixelIcon } from './PixelIcon.tsx';

export function DayBanner(_props: { now: number }) {
  const day = useOffice((s) => s.day);
  if (!day) return null;
  return (
    <section className="day-banner" aria-label="Ta journée">
      <div className="db-box">
        <span className="db-k"><PixelIcon name="check" size={12} />Aujourd’hui</span>
        <b className="db-big">{plural(day.tasksDone, 'tâche finie', 'tâches finies')}</b>
        {day.sessionsDone > 0 && <small>{plural(day.sessionsDone, 'session terminée', 'sessions terminées')}</small>}
      </div>
      <div className="db-box db-cost" title={COST_HINT}>
        <span className="db-k"><PixelIcon name="coin" size={12} />Coût du jour</span>
        <b className="db-big">{fmtCost(day.cost, day.costPartial)}</b>
        <small>si c’était payé au tarif de l’API</small>
      </div>
      {day.total && <Total t={day.total} />}
    </section>
  );
}

/** « 11,1 milliards », « 948 millions » : sans les jetons (le contexte le dit). */
const words = (n: number) => fmtTokensWords(n).replace(/ de jetons$| jetons$/, '');

/** Le cumul depuis le début du suivi : les jetons en toutes lettres, le coût, puis le détail. */
function Total({ t }: { t: TokenTotal }) {
  const tokens = t.input + t.output + t.cacheWrite + t.cacheRead;
  const since = new Date(t.since).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  const notes = [
    t.sources < t.expectedSources && `${plural(t.sources, 'machine comptée', 'machines comptées')} sur ${t.expectedSources}`,
    t.partial && 'calcul en cours',
  ].filter(Boolean) as string[];
  return (
    <div className="db-box db-total">
      <span className="db-k"><PixelIcon name="star" size={12} />Depuis le {since}</span>
      <b className="db-big" title={`${tokens.toLocaleString('fr-FR')} jetons`}>{fmtTokensWords(tokens)}</b>
      <span className="db-sub" title={COST_HINT}>{t.unknown > 0 ? 'au moins' : 'environ'} {fmtCost(t.cost)} au tarif de l’API</span>
      <small className="db-detail">
        Dont {words(t.cacheRead)} relus du cache (presque gratuits), {words(t.cacheWrite)} mis en cache, {words(t.input)} lus et {words(t.output)} écrits par Claude.
      </small>
      {notes.length > 0 && <small className="db-note">{notes.join(' · ')}</small>}
    </div>
  );
}
