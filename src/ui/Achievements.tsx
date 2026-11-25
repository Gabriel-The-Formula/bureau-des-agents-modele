// Le fil des réalisations (la 2e page de l'étage) : une carte par session terminée (ce qui a été fait, en français
// simple, les captures, les liens), rangée par jour. Une recherche, puis des filtres : grande catégorie, sous-catégorie,
// compte, jour. Au plus 5 sous-catégories par catégorie (shared/subgroups.ts) ; un groupe qui en mélange plusieurs se
// détaille en sous-sous-catégories (celles d'au moins deux réalisations). Les entrées « pas intéressantes » (maintenance, CI, relecture de PR…) restent masquées tant qu'on ne
// demande pas de tout afficher.
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CATEGORY_LABELS, type FeedCategory, type FeedEntry, type FeedMedia } from '../../shared/live.ts';
import { MAX_SUBGROUPS, subGrouper } from '../../shared/subgroups.ts';
import { sfx } from '../audio/sfx.ts';
import { useOffice } from '../state/store.ts';
import { COST_HINT, dayLabel, dayStart, fmtCost, fmtHour, plural, thumbUrl } from './format.ts';
import { ImagesOn } from './imagesOn.ts';
import { PixelIcon } from './PixelIcon.tsx';
import { TECH_FILE, Viewer, catOf } from './Sheets.tsx';
import { tidy } from './tidy.ts';

const CATS = Object.keys(CATEGORY_LABELS) as FeedCategory[];
/** cartes affichées d'un coup (et ajoutées à chaque fois qu'on approche du bas) : 400 cartes d'un bloc saccadent sur tablette */
const STEP = 30;

/** Seulement des images qu'on sait afficher sans risque. */
const safeImg = (u: string) => /^\/(?!\/)/.test(u) || /^https:\/\//i.test(u) || /^data:image\/(png|jpe?g|gif|webp);/i.test(u);
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function Achievements({ now }: { now: number }) {
  const entries = useOffice((s) => s.achievements);
  const feedLoaded = useOffice((s) => s.feedLoaded);
  const [cat, setCat] = useState<FeedCategory | 'all'>('all');
  const [sub, setSub] = useState<string | null>(null);
  const [sub2, setSub2] = useState<string | null>(null);
  const [day, setDay] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [viewer, setViewer] = useState<{ media: FeedMedia[]; i: number } | null>(null);
  const [limit, setLimit] = useState(STEP);
  const onMedia = useCallback((media: FeedMedia[], i: number) => setViewer({ media, i }), []);
  // un autre filtre : on repart des premières cartes
  useEffect(() => setLimit(STEP), [q, cat, sub, sub2, day, showAll]);

  const sorted = useMemo(() => [...entries].sort((a, b) => b.at - a.at), [entries]);
  // la recherche et « tout afficher » d'abord : les compteurs des filtres en tiennent compte
  const base = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    return sorted.filter((e) => {
      if (!showAll && !e.interesting) return false;
      if (!words.length) return true;
      const hay = fold([e.title, e.summary, e.sub ?? '', e.needsYou ?? '', CATEGORY_LABELS[catOf(e)], ...e.links.map((l) => l.label), ...(e.detail ? [...e.detail.done, ...e.detail.results, ...e.detail.left] : [])].join(' '));
      return words.every((w) => hay.includes(w));
    });
  }, [sorted, q, showAll]);
  const cats = useMemo(() => CATS.map((c) => ({ c, n: base.filter((e) => catOf(e) === c).length })).filter((x) => x.n > 0), [base]);
  const curCat = cat !== 'all' && cats.some((x) => x.c === cat) ? cat : 'all';
  const byCat = useMemo(() => (curCat === 'all' ? base : base.filter((e) => catOf(e) === curCat)), [base, curCat]);
  const groupOf = useMemo(() => (curCat === 'all' ? () => null : subGrouper(curCat, byCat)), [byCat, curCat]);
  const subs = useMemo(() => countSorted(byCat.map(groupOf)), [byCat, groupOf]);
  const curSub = sub && subs.some(([s]) => s === sub) ? sub : null;
  const byGroup = useMemo(() => (curSub ? byCat.filter((e) => groupOf(e) === curSub) : byCat), [byCat, curSub, groupOf]);
  // les sous-sous-catégories du groupe ouvert : ses sous-catégories d'origine d'au moins deux réalisations
  const subs2 = useMemo(() => {
    if (!curSub) return [];
    const all = countSorted(byGroup.map((e) => e.sub ?? null));
    const big = all.filter(([, n]) => n > 1).slice(0, MAX_SUBGROUPS);
    return all.length > 1 && big.length > 1 ? big : [];
  }, [byGroup, curSub]);
  const curSub2 = sub2 && subs2.some(([s]) => s === sub2) ? sub2 : null;
  const bySub = useMemo(() => (curSub2 ? byGroup.filter((e) => e.sub === curSub2) : byGroup), [byGroup, curSub2]);
  const days = useMemo(() => [...new Set(sorted.map((e) => dayStart(e.at)))], [sorted]);
  const curDay = day !== null && days.includes(day) ? day : null;
  const visible = useMemo(() => (curDay === null ? bySub : bySub.filter((e) => dayStart(e.at) === curDay)), [bySub, curDay]);
  const hidden = showAll ? 0 : sorted.filter((e) => !e.interesting).length;
  const groups = useMemo(() => {
    const out: { day: number; list: FeedEntry[] }[] = [];
    for (const e of visible) {
      const d = dayStart(e.at);
      const g = out[out.length - 1];
      if (g && g.day === d) g.list.push(e);
      else out.push({ day: d, list: [e] });
    }
    return out;
  }, [visible]);
  const filtered = q || curCat !== 'all' || curDay !== null;
  const rest = Math.max(0, visible.length - limit);
  // la suite arrive d'elle-même un peu avant le bas de la liste
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !rest || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((xs) => { if (xs.some((x) => x.isIntersecting)) setLimit((n) => n + STEP); }, { rootMargin: '0px 0px 800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [rest, limit]);
  let budget = limit;

  return (
    <section className="ach-feed" aria-label="Réalisations">
      <header className="ach-bar">
        <div className="ach-top">
          <h2>Réalisations</h2>
          <label className="ach-search">
            <PixelIcon name="search" size={12} />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher (messagerie, PR 2316, pubs…)" aria-label="Chercher dans les réalisations" />
          </label>
          <label className="ach-toggle">
            <input type="checkbox" checked={showAll} onChange={(e) => { sfx('click'); setShowAll(e.target.checked); }} />
            <span className="sw" aria-hidden="true"><i /></span>
            Tout afficher
            {hidden > 0 && <small>{plural(hidden, 'masquée', 'masquées')}</small>}
          </label>
        </div>
        {sorted.length > 0 && (
          <>
            <div className="ach-chips" role="tablist" aria-label="Catégories">
              <Chip on={curCat === 'all'} onClick={() => { setCat('all'); setSub(null); setSub2(null); }}>Toutes<small>{base.length}</small></Chip>
              {cats.map(({ c, n }) => <Chip key={c} on={curCat === c} cat={c} onClick={() => { setCat(c); setSub(null); setSub2(null); }}>{CATEGORY_LABELS[c]}<small>{n}</small></Chip>)}
            </div>
            {subs.length > 0 && (
              <div className="ach-chips subs" role="tablist" aria-label="Sous-catégories">
                <Chip on={curSub === null} onClick={() => { setSub(null); setSub2(null); }}>Tout {lowerFirst(CATEGORY_LABELS[curCat as FeedCategory])}</Chip>
                {subs.map(([s, n]) => <Chip key={s} on={curSub === s} onClick={() => { setSub(s); setSub2(null); }}>{tidy(s)}<small>{n}</small></Chip>)}
              </div>
            )}
            {curSub && subs2.length > 0 && (
              <div className="ach-chips subsubs" role="tablist" aria-label={`Détail de ${curSub}`}>
                <Chip on={curSub2 === null} onClick={() => setSub2(null)}>Tout {lowerFirst(curSub)}</Chip>
                {subs2.map(([s, n]) => <Chip key={s} on={curSub2 === s} onClick={() => setSub2(s)}>{tidy(s)}<small>{n}</small></Chip>)}
              </div>
            )}
            <div className="ach-filters">
              {days.length > 1 && (
                <div className="ach-chips days" role="tablist" aria-label="Jours">
                  <Chip on={curDay === null} onClick={() => setDay(null)}>Tous les jours</Chip>
                  {days.slice(0, 7).map((d) => <Chip key={d} on={curDay === d} onClick={() => setDay(d)}>{dayLabel(d, now, true)}</Chip>)}
                </div>
              )}
            </div>
          </>
        )}
      </header>

      {!sorted.length ? (
        feedLoaded ? <p className="ach-empty">Pas encore de réalisation.</p> : <FeedSkeleton />
      ) : !groups.length ? (
        <p className="ach-empty">
          {filtered ? 'Rien ne correspond à ces filtres.' : 'Rien à montrer ici.'}
          {filtered && <button className="ach-more" onClick={() => { setQ(''); setCat('all'); setSub(null); setSub2(null); setDay(null); }}>Tout effacer</button>}
        </p>
      ) : (
        <>
          {groups.map((g) => {
            if (budget <= 0) return null;
            const shown = g.list.slice(0, budget);
            budget -= shown.length;
            return (
              <div key={g.day} className="ach-day">
                <h3>{dayLabel(g.day, now)} <small>{plural(g.list.length, 'réalisation', 'réalisations')}</small></h3>
                <div className="ach-grid">
                  {shown.map((e) => <Entry key={e.key} e={e} onMedia={onMedia} />)}
                </div>
              </div>
            );
          })}
          {rest > 0 && (
            <div ref={sentinel} className="ach-next">
              <button className="ach-more" onClick={() => setLimit((n) => n + STEP)}>Afficher plus ({plural(rest, 'restante', 'restantes')})</button>
            </div>
          )}
        </>
      )}

      {viewer && <Viewer media={viewer.media} start={viewer.i} onClose={() => setViewer(null)} />}
    </section>
  );
}

/** Les valeurs non vides, de la plus fréquente à la plus rare. */
function countSorted(values: (string | null)[]): [string, number][] {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** « Page d'accueil » → « page d'accueil » (les sigles gardent leurs capitales). */
const lowerFirst = (s: string) => (/^.[a-zà-ÿ]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

function Chip({ on, cat, onClick, children }: { on: boolean; cat?: FeedCategory; onClick: () => void; children: React.ReactNode }) {
  return (
    <button role="tab" aria-selected={on} className={`ach-chip ${on ? 'on' : ''}`} onClick={() => { if (!on) { sfx('click'); onClick(); } }}>
      {cat && <i className={`cat-dot ${cat}`} />}{children}
    </button>
  );
}

/** Avant / après : deux captures légendées ainsi, montrées côte à côte. */
const isBefore = (m: FeedMedia) => /^avant\b/i.test(m.label ?? '');
const isAfter = (m: FeedMedia) => /^apr[eè]s\b/i.test(m.label ?? '');

/**
 * Une carte du fil : un clic l'ouvre en entier (fiche de la réalisation, lisible sans GitHub). « Lire la suite »
 * n'apparaît que si le résumé est vraiment coupé à l'écran, ou s'il y a un détail ou une décision à lire. Mémorisée :
 * l'horloge de l'étage ne la redessine pas.
 */
const Entry = memo(function Entry({ e, onMedia }: { e: FeedEntry; onMedia: (media: FeedMedia[], i: number) => void }) {
  const imagesOn = useContext(ImagesOn);
  const title = tidy(e.title || 'Session');
  const summary = tidy(e.summary || '');
  const media = e.media.filter((m) => safeImg(m.url));
  const files = e.files.filter((f) => !TECH_FILE.test(f.trim()));
  const c = catOf(e);
  const pair = media.length === 2 && media.some(isBefore) && media.some(isAfter);
  const ordered = pair ? [media.find(isBefore)!, media.find(isAfter)!] : media;
  const para = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  // le résumé dépasse-t-il les 3 lignes affichées ? (mesuré, et remesuré quand la carte change de largeur)
  useLayoutEffect(() => {
    const el = para.current;
    if (!el) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [summary]);
  const more = cut || !!e.detail || !!e.decision;
  const open = () => { sfx('open'); useOffice.setState({ sheet: { kind: 'entry', key: e.key } }); };
  return (
    <article
      className={`ach-card ${e.interesting ? '' : 'quiet'}`}
      role="button"
      tabIndex={0}
      aria-label={`${title} : voir le détail`}
      onClick={open}
      onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); open(); } }}
    >
      <header className="ach-head">
        <span className={`ach-cat ${c}`}><i className={`cat-dot ${c}`} />{CATEGORY_LABELS[c]}{e.sub && <em>{tidy(e.sub)}</em>}</span>
        <span className="ach-meta">
          <time dateTime={new Date(e.at).toISOString()}>{fmtHour(e.at)}</time>
        </span>
      </header>
      <b className="ach-title">{title}</b>
      {summary && (
        <div className="ach-summary">
          <p ref={para} className="clamp">{summary}</p>
          {more && <button className="ach-more" onClick={(ev) => { ev.stopPropagation(); open(); }}>Lire la suite</button>}
        </div>
      )}
      {!summary && more && <button className="ach-more" onClick={(ev) => { ev.stopPropagation(); open(); }}>Voir le détail</button>}
      {e.needsYou && <p className="ach-needs"><b>À toi de jouer :</b> {tidy(e.needsYou)}</p>}
      {ordered.length > 0 && (
        <div className={`ach-media ${pair ? 'pair' : ordered.length === 1 ? 'single' : ''}`}>
          {ordered.map((m, i) => (
            <button key={m.url + i} className="ach-thumb" onClick={(ev) => { ev.stopPropagation(); sfx('open'); onMedia(ordered, i); }} title={m.label ? `${m.label} : agrandir` : 'Agrandir'} aria-label={m.label ? `Agrandir ${m.label}` : 'Agrandir l’image'}>
              {imagesOn && <img src={thumbUrl(m.url)} alt={m.label ?? ''} loading="lazy" decoding="async" />}
              {m.label && !/^capture \d+$/i.test(m.label) && <span className={`ach-thumb-label ${isBefore(m) ? 'before' : isAfter(m) ? 'after' : ''}`}>{m.label}</span>}
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="ach-refs">
          {files.map((f) => <span key={f} className="ach-file" title={tidy(f)}><PixelIcon name="paper" size={10} />{tidy(f)}</span>)}
        </div>
      )}
      <footer className="ach-foot">
        {e.tasks > 0 && <span>{plural(e.tasks, 'tâche', 'tâches')}</span>}
        <span title={COST_HINT}>{fmtCost(e.cost)}</span>
      </footer>
    </article>
  );
});

/** Des cartes vides le temps que le fil arrive (au lieu de « pas encore de réalisation »). */
function FeedSkeleton() {
  return (
    <div className="ach-grid" aria-busy="true" aria-label="Chargement des réalisations">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="ach-card skel-card">
          <span className="skel-line w40" />
          <span className="skel-line" />
          <span className="skel-line" />
          <span className="skel-line w60" />
        </div>
      ))}
    </div>
  );
}
