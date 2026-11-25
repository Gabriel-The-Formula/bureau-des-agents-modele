// L'étage : la vue d'ensemble, en trois pages qu'on fait glisser du doigt (comme l'écran d'accueil d'un iPad) ou
// qu'on choisit dans les onglets du haut :
//  1. « Bureau » : le bandeau du jour, ce qui t'attend (« À toi de jouer »), puis une salle par session Claude Code
//     suivie, rangée par machine et par heure de début (l'ordre ne bouge plus) ; les terminées se replient en bas.
//  2. « Réalisations » : le fil de ce qui a été fini.
//  3. « Rapports » : les études longues, rangées par sujet (Reports.tsx).
// Chaque carte dit d'abord ce que la session fait (`doing`), puis le titre.
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionStatus, SessionSummary, SourceInfo } from '../../shared/live.ts';
import { DayBanner } from './DayBanner.tsx';
import { ImagesOn } from './imagesOn.ts';
import { sfx } from '../audio/sfx.ts';
import { go } from '../net/link.ts';
import { useOffice } from '../state/store.ts';
import { COST_HINT, ago, fmtCompact, fmtCost, plural, sumCosts } from './format.ts';
import { Avatar } from './Panel.tsx';
import { PixelIcon } from './PixelIcon.tsx';
import { STATUS_LABEL, seatOf, sortSessions, useNow, withChildren } from './sessions.ts';
import { ReportsPage, loadReports, useReportCount } from './Reports.tsx';
import { useNeeds, type NeedItem } from './needs.ts';
import { tidy } from './tidy.ts';
import { Logo, SoundButton, ThemeButton } from './TopBar.tsx';

/** Une salle qui disparaît de la liste reste un instant à l'écran, le temps de sortir en douceur. */
function usePresence(list: SessionSummary[], ms = 220) {
  const [shown, setShown] = useState<{ s: SessionSummary; leaving: boolean }[]>(() => list.map((s) => ({ s, leaving: false })));
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const keys = new Set(list.map((s) => s.key));
    setShown((prev) => {
      const next = list.map((s) => ({ s, leaving: false }));
      prev.forEach((p, i) => {
        if (keys.has(p.s.key)) return;
        // on la garde à sa place, le temps de la sortie
        next.splice(Math.min(i, next.length), 0, { s: p.s, leaving: true });
        if (!timers.current.has(p.s.key)) {
          timers.current.set(p.s.key, setTimeout(() => {
            timers.current.delete(p.s.key);
            setShown((cur) => cur.filter((x) => !(x.leaving && x.s.key === p.s.key)));
          }, ms));
        }
      });
      return next;
    });
  }, [list, ms]);
  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);
  return shown;
}

const NONE: SessionSummary[] = [];

// le fil de l'Avancement (le plus gros écran de l'étage) est chargé à part, après l'accueil
const Achievements = lazy(() => import('./Achievements.tsx').then((m) => ({ default: m.Achievements })));

const PAGES = [{ id: 'bureau', label: 'Bureau' }, { id: 'realisations', label: 'Réalisations' }, { id: 'rapports', label: 'Rapports' }] as const;
const PAGE_KEY = 'bureau:page';

/** La page affichée (0, 1 ou 2) : suit le défilement horizontal, se pilote par les onglets, et s'en souvient. */
function usePages() {
  const box = useRef<HTMLDivElement>(null);
  /** l'indicateur des onglets suit le doigt pendant le glissement */
  const bar = useRef<HTMLElement>(null);
  const [page, setPage] = useState(() => {
    // un lien vers une page (#rapports, #realisations) l'ouvre directement
    const fromHash = PAGES.findIndex((p) => `#${p.id}` === location.hash);
    if (fromHash > 0) {
      history.replaceState(history.state, '', location.pathname + location.search);
      try { localStorage.setItem(PAGE_KEY, PAGES[fromHash].id); } catch { /* navigation privée */ }
      return fromHash;
    }
    try { return Math.max(0, PAGES.findIndex((p) => p.id === localStorage.getItem(PAGE_KEY))); } catch { return 0; }
  });
  // au chargement : directement sur la page mémorisée, sans animation
  useLayoutEffect(() => {
    const el = box.current;
    if (el && page) el.scrollLeft = page * el.clientWidth;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const f = el.scrollLeft / Math.max(1, el.clientWidth);
        if (bar.current) bar.current.style.transform = `translateX(${Math.min(PAGES.length - 1, Math.max(0, f)) * 100}%)`;
        const i = Math.round(f);
        setPage((cur) => {
          if (cur === i) return cur;
          try { localStorage.setItem(PAGE_KEY, PAGES[i]?.id ?? 'bureau'); } catch { /* navigation privée */ }
          return i;
        });
      });
    };
    // une fenêtre redimensionnée (iPad tourné) : on reste sur la même page
    const onResize = () => { el.scrollLeft = Math.round(el.scrollLeft / Math.max(1, el.clientWidth)) * el.clientWidth; };
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => { el.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onResize); cancelAnimationFrame(raf); };
  }, []);
  const goPage = (i: number) => {
    const el = box.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: reduced() ? 'auto' : 'smooth' });
  };
  return { box, bar, page, goPage };
}

export function Floor() {
  const sessions = useOffice((s) => s.sessions);
  const sources = useOffice((s) => s.sources);
  const connection = useOffice((s) => s.connection);
  const loaded = useOffice((s) => s.loaded);
  const stale = useOffice((s) => s.stale);
  const now = useNow();

  const day = useOffice((s) => s.day);
  const groups = useMemo(() => {
    const sorted = sortSessions(sessions);
    const ids = [...new Set(sorted.map((s) => s.sourceId))];
    // l'ordre des machines, figé lui aussi : celle de la plus ancienne salle d'abord
    const rank = (id: string) => Math.min(...sorted.filter((s) => s.sourceId === id).map((s) => seatOf(s.key)));
    ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return ids.map((id) => ({ id, source: sources.find((x) => x.id === id), list: sorted.filter((s) => s.sourceId === id) }));
  }, [sessions, sources]);
  const total = useMemo(() => sumCosts(sessions), [sessions]);

  const count = (st: SessionStatus) => sessions.filter((s) => s.status === st).length;
  const working = count('working');
  const parts = [
    working && plural(working, 'en cours', 'en cours'),
    count('waiting') && `${count('waiting')} en attente d’une réponse`,
    count('blocked') && plural(count('blocked'), 'bloquée', 'bloquées'),
    count('done') && plural(count('done'), 'terminée', 'terminées'),
  ].filter(Boolean) as string[];

  const { box, bar, page, goPage } = usePages();
  // les autres pages se montent une fois l'étage affiché : le premier chargement ne dessine que la page ouverte
  const [warm, setWarm] = useState(false);
  useEffect(() => { const t = setTimeout(() => setWarm(true), 1200); return () => clearTimeout(t); }, []);
  const mounted = (i: number) => warm || page === i;
  // et leurs images ne se téléchargent qu'à la première visite de la page
  const [seen, setSeen] = useState(() => new Set([page]));
  useEffect(() => { setSeen((s) => (s.has(page) ? s : new Set(s).add(page))); }, [page]);
  const reportCount = useReportCount();
  // le nombre de rapports dans l'onglet, dès l'arrivée sur l'étage
  useEffect(() => { void loadReports(); }, []);

  return (
    <div className="floor">
      <header className="floor-head">
        <div className="brand">
          <Logo />
          <b>Le Bureau des agents</b>
        </div>
        <nav className="floor-tabs" role="tablist" aria-label="Pages">
          {PAGES.map((p, i) => (
            <button key={p.id} role="tab" aria-selected={page === i} className={page === i ? 'on' : ''} onClick={() => { if (page !== i) { sfx('click'); goPage(i); } }}>
              {p.label}
              {i === 2 && reportCount > 0 && <small>{reportCount}</small>}
            </button>
          ))}
          <i className="floor-tabs-bar" ref={bar} style={{ transform: `translateX(${page * 100}%)` }} aria-hidden="true" />
        </nav>
        <p className="floor-summary">
          {!sessions.length ? (loaded ? 'Aucune session.' : 'Chargement…') : `Sessions : ${parts.join(', ')}.`}
        </p>
        {/* sans bandeau du jour, le total des salles visibles reste en tête */}
        {!day && sessions.length > 0 && (
          <span className="cost-total" title={COST_HINT}>
            <PixelIcon name="coin" size={12} /><b>{fmtCost(total.cost, total.partial)}</b><small>équiv. API</small>
          </span>
        )}
        <div className="tools">
          {/* l'étage gardé dans le navigateur reste affiché pendant la (re)connexion : on le dit, sans le vider */}
          <span className={`conn ${loaded && connection === 'live' ? 'live' : 'connecting'}`} title={stale ? 'Dernier état connu, en attente du direct' : loaded && connection === 'live' ? 'En direct' : 'Connexion…'}>
            <i />{loaded && connection === 'live' ? 'En direct' : stale ? 'Mise à jour…' : loaded ? 'Reconnexion…' : 'Connexion…'}
          </span>
          <ThemeButton />
          <SoundButton />
        </div>
      </header>
      <div className="floor-pages" ref={box}>
      <main className="floor-body floor-page" aria-label="Bureau" aria-hidden={page !== 0}>
        <DayBanner now={now} />
        <Attention now={now} />
        {/* « aucune session » seulement une fois l'étage reçu : avant, ce serait faux */}
        {!sessions.length && loaded && (
          <div className="floor-empty">
            <Avatar role="chef" size={64} />
            <p>Aucune session en cours.</p>
          </div>
        )}
        {!sessions.length && !loaded && <FloorSkeleton />}
        {groups.length > 0 && (
          <div className={`floor-sources ${groups.length > 1 ? 'multi' : ''}`}>
            {groups.map((g) => <SourceColumn key={g.id} source={g.source} list={g.list} now={now} showHead={groups.length > 1} />)}
          </div>
        )}
      </main>
      <main className="floor-body floor-page" aria-label="Réalisations" aria-hidden={page !== 1}>
        {mounted(1) && (
          <ImagesOn.Provider value={seen.has(1)}>
            <Suspense fallback={null}><Achievements now={now} /></Suspense>
          </ImagesOn.Provider>
        )}
      </main>
      <main className="floor-body floor-page" aria-label="Rapports" aria-hidden={page !== 2}>
        {mounted(2) && <ImagesOn.Provider value={seen.has(2)}><ReportsPage active={page === 2} /></ImagesOn.Provider>}
      </main>
      </div>
      <div className="floor-dots" aria-hidden="true">
        {PAGES.map((p, i) => <button key={p.id} tabIndex={-1} className={page === i ? 'on' : ''} onClick={() => goPage(i)} />)}
      </div>
    </div>
  );
}

/** Des salles vides le temps que l'étage arrive. */
function FloorSkeleton() {
  return (
    <div className="rooms-grid" aria-busy="true" aria-label="Chargement des sessions">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="room-card skel-card">
          <span className="skel-line w40" />
          <span className="skel-line" />
          <span className="skel-line w60" />
        </div>
      ))}
    </div>
  );
}

/** « À toi de jouer » se traite par lots de 9 : les suivantes apparaissent avec « Afficher plus ». */
const BATCH = 9;

/**
 * « À toi de jouer » : ce qui t'attend (needs.ts). Chaque carte s'ouvre sur une fiche complète (contexte, choix,
 * conséquences, captures, accès à la conversation) où l'on passe à la suivante en glissant ; on répond dans la session.
 */
function Attention({ now }: { now: number }) {
  const items = useNeeds();
  const [shown, setShown] = useState(BATCH);
  if (!items.length) return null;
  const open = (key: string) => { sfx('open'); useOffice.setState({ sheet: { kind: 'decision', key } }); };
  const rest = items.length - shown;
  return (
    <section className="attention" aria-label="À toi de jouer">
      <header className="att-head">
        <h2>À toi de jouer <small>{items.length}</small></h2>
      </header>
      <ul className="att-list">
        {items.slice(0, shown).map((x) => (
          <li key={x.key}>
            <button className={`att-item ${x.kind}`} onClick={() => open(x.key)} title="Voir le contexte et les choix">
              <span className="att-text">
                <b className="att-title">{tidy(x.title || 'Session')}</b>
                <span className="att-what"><em>{KIND_LABEL[x.kind]}</em>{tidy(x.what)}</span>
                <span className="att-more">{x.choices > 1 ? `${x.choices} choix possibles · ` : ''}{ago(x.at, now)} · Voir le contexte</span>
              </span>
              <PixelIcon name="next" size={12} className="att-chev" />
            </button>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <button className="att-show-more" onClick={() => { sfx('click'); setShown(shown + BATCH); }}>
          Afficher plus ({Math.min(BATCH, rest)} sur {rest} restante{rest > 1 ? 's' : ''})
        </button>
      )}
    </section>
  );
}

const KIND_LABEL: Record<NeedItem['kind'], string> = { waiting: 'Attend ta réponse', blocked: 'Bloquée' };

function SourceColumn({ source, list, now, showHead }: { source?: SourceInfo; list: SessionSummary[]; now: number; showHead: boolean }) {
  const [openDone, setOpenDone] = useState(false);
  const active = useMemo(() => list.filter((s) => s.status !== 'done'), [list]);
  const done = useMemo(() => list.filter((s) => s.status === 'done'), [list]);
  const shownActive = usePresence(active);
  const shownDone = usePresence(openDone ? done : NONE);
  // un collecteur qui n'a rien envoyé depuis 3 minutes : la machine est peut-être éteinte
  const silent = source && now - source.seenAt > 180_000;
  return (
    <section className="source">
      {showHead && (
        <h2 className="source-head">
          <PixelIcon name="bash" size={14} />
          <span>{source?.label ?? 'Machine inconnue'}</span>
          {silent && <em title="Rien reçu de cette machine depuis un moment">silencieuse {ago(source.seenAt, now)}</em>}
        </h2>
      )}
      {!showHead && silent && <p className="small muted source-silent">{source?.label} : rien reçu {ago(source!.seenAt, now)}.</p>}
      <Cards shown={shownActive} now={now} />
      {done.length > 0 && (
        <>
          <button className={`done-toggle ${openDone ? 'open' : ''}`} onClick={() => { sfx('click'); setOpenDone(!openDone); }} aria-expanded={openDone}>
            <PixelIcon name="play" size={10} className="chev" /> Terminées ({done.length})
          </button>
          {shownDone.length > 0 && <Cards shown={shownDone} now={now} />}
        </>
      )}
    </section>
  );
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Quand une carte part (ou arrive), les autres glissent jusqu'à leur nouvelle place au lieu de sauter :
 * on note la position de chaque carte, et après le rendu on anime l'écart (technique « FLIP »).
 */
function useGlide(grid: React.RefObject<HTMLDivElement | null>, dep: unknown) {
  const last = useRef(new Map<string, { x: number; y: number }>());
  const lastH = useRef(0);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    // la grille elle-même se referme (ou s'ouvre) en douceur : ce qui est dessous ne saute pas
    if (lastH.current && Math.abs(lastH.current - box.height) > 1 && !reduced() && typeof el.animate === 'function') {
      el.animate([{ height: `${lastH.current}px` }, { height: `${box.height}px` }], { duration: 240, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    }
    lastH.current = box.height;
    const next = new Map<string, { x: number; y: number }>();
    const skip = reduced();
    for (const c of el.querySelectorAll<HTMLElement>('[data-key]')) {
      const r = c.getBoundingClientRect();
      const p = { x: r.left - box.left, y: r.top - box.top };
      next.set(c.dataset.key!, p);
      const was = last.current.get(c.dataset.key!);
      if (skip || !was || typeof c.animate !== 'function') continue;
      const dx = was.x - p.x;
      const dy = was.y - p.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    }
    last.current = next;
  }, [grid, dep]);
}

/** Une grille de cartes : chaque session lancée par une autre vient juste après sa parente. */
function Cards({ shown, now }: { shown: { s: SessionSummary; leaving: boolean }[]; now: number }) {
  const ordered = useMemo(() => {
    const leaving = new Set(shown.filter((x) => x.leaving).map((x) => x.s.key));
    return withChildren(shown.map((x) => x.s)).map(({ s, child }) => ({ s, child, leaving: leaving.has(s.key) }));
  }, [shown]);
  const grid = useRef<HTMLDivElement>(null);
  const layout = ordered.map((x) => x.s.key).join('|');
  useGlide(grid, layout);
  return (
    <div className="rooms-grid" ref={grid}>
      {ordered.map(({ s, child, leaving }) => <RoomCard key={s.key} s={s} now={now} leaving={leaving} child={child} />)}
    </div>
  );
}


function RoomCard({ s, now, leaving, child }: { s: SessionSummary; now: number; leaving: boolean; child: boolean }) {
  const doing = tidy(s.doing || s.title || 'Session sans titre');
  const title = tidy(s.title || '');
  const alert = (s.status === 'waiting' || s.status === 'blocked') && s.statusText && s.statusText !== STATUS_LABEL[s.status];
  const open = () => { if (leaving) return; sfx('open'); go(s.key); };
  return (
    <div
      role="button"
      data-key={s.key}
      tabIndex={leaving ? -1 : 0}
      aria-disabled={leaving || undefined}
      className={`room-card ${s.status} ${leaving ? 'leaving' : ''} ${child ? 'child' : ''}`}
      onClick={open}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } }}
    >
      {/* le statut et la dernière activité tiennent dans la pastille de couleur (détail au survol) */}
      <span className={`rc-dot ${s.status}`} title={`${alert ? tidy(s.statusText) : STATUS_LABEL[s.status]} · ${ago(s.lastActivity, now)}`} aria-label={STATUS_LABEL[s.status]} />
      <div className="rc-tags">
        {s.status !== 'working' && <span className={`rc-state ${s.status}`}>{STATUS_LABEL[s.status]}</span>}
        {child && <span className="rc-child" title="Lancée par la session juste avant">sous-session</span>}
      </div>
      <b className="rc-doing" title={doing}>{doing}</b>
      {title && title !== doing && <span className="rc-title" title={title}>{title}</span>}
      {alert && <span className="rc-statustext">{tidy(s.statusText)}</span>}
      <div className="rc-nums">
        <span title="Sous-agents au travail / appelés"><PixelIcon name="robot" size={12} />{s.activeSubagents > 0 ? `${s.activeSubagents}/${s.subagents.length}` : s.subagents.length}</span>
        <span title="Jetons consommés (lectures de cache non comptées)"><PixelIcon name="coin" size={12} />{fmtCompact(s.tokens)} jetons</span>
        <em className="cost" title={COST_HINT}>{fmtCost(s.cost, s.costPartial)}</em>
      </div>
    </div>
  );
}
