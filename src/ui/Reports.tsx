// Les rapports longs (la 3e page de l'étage) : les études de fond sur tes grands sujets, écrites par tes agents dans le
// dossier des rapports (npm run local -- --rapports <dossier>) et envoyées par le collecteur. La liste est
// rangée par sujet ; un rapport s'ouvre en pleine page de lecture (sommaire, images en grand), à l'adresse #r=<id>.
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { FeedMedia, Report, ReportArchive, ReportIndex, ReportLevel, ReportMeta } from '../../shared/live.ts';
import { sfx } from '../audio/sfx.ts';
import { useOffice } from '../state/store.ts';
import { plural, thumbUrl } from './format.ts';
import type { Heading } from './md.ts';
import { ImagesOn } from './imagesOn.ts';
import { PixelIcon } from './PixelIcon.tsx';
import { ReportAudio } from './ReportAudio.tsx';
import { pdfName, reportPdf, saveFile, shareFile } from './reportPdf.ts';
import { Viewer } from './Sheets.tsx';
import './reports.css';

interface ReportsState {
  /** la liste (null tant qu'elle n'est pas arrivée) */
  list: ReportMeta[] | null;
  error: boolean;
  at: number;
  /** les rapports déjà lus, gardés tant que leur empreinte ne change pas */
  bodies: Record<string, Report>;
  /** les rapports archivés (id -> vrai), rangés dans la vue « Archivés » */
  archived: Record<string, boolean>;
  /** le dernier geste d'archivage n'a pas pu être enregistré */
  archiveError: string | null;
}

const useReports = create<ReportsState>(() => ({ list: null, error: false, at: 0, bodies: {}, archived: {}, archiveError: null }));

const archivedOf = (a: ReportArchive) => Object.fromEntries(Object.entries(a.items ?? {}).filter(([, v]) => v?.archived).map(([k]) => [k, true]));

/** la liste des archivés ; une erreur ici laisse tout visible plutôt que de cacher la liste */
const loadArchive = () => fetch('/reports-archive.json', { credentials: 'same-origin', cache: 'no-cache' })
  .then(async (r) => { if (r.ok) useReports.setState({ archived: archivedOf((await r.json()) as ReportArchive) }); })
  .catch(() => {});

/** Archive (ou remet dans la liste) un rapport : tout de suite à l'écran, annulé si le Bureau ne l'enregistre pas. */
export function setArchived(id: string, archived: boolean) {
  const before = useReports.getState().archived;
  const next = { ...before };
  if (archived) next[id] = true; else delete next[id];
  useReports.setState({ archived: next, archiveError: null });
  sfx('click');
  fetch('/reports-archive.json', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, archived }),
  })
    .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); useReports.setState({ archived: archivedOf((await r.json()) as ReportArchive) }); })
    .catch(() => useReports.setState({
      archived: before,
      archiveError: archived ? 'Le rapport n’a pas pu être archivé. Réessaie dans un instant.' : 'Le rapport n’a pas pu être remis dans la liste. Réessaie dans un instant.',
    }));
}

let pending: Promise<void> | null = null;

/** Charge la liste (au plus une fois par minute, sauf `force`). */
export function loadReports(force = false): Promise<void> {
  const st = useReports.getState();
  if (pending) return pending;
  if (!force && st.list && Date.now() - st.at < 60_000) return Promise.resolve();
  const archive = loadArchive();
  pending = fetch('/reports/index.json', { credentials: 'same-origin', cache: 'no-cache' })
    .then(async (r) => {
      await archive;
      // aucun rapport publié encore
      if (r.status === 404) { useReports.setState({ list: [], error: false, at: Date.now() }); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const idx = (await r.json()) as ReportIndex;
      useReports.setState({ list: Array.isArray(idx.reports) ? idx.reports : [], error: false, at: Date.now() });
    })
    .catch(() => useReports.setState({ error: true, at: Date.now() }))
    .finally(() => { pending = null; });
  return pending;
}

/** les rapports « À lire » encore dans la liste (le badge de l'onglet) */
export const useReportCount = () => useReports((s) => s.list?.filter((r) => !s.archived[r.id] && r.level === 'a-lire').length ?? 0);

// ── L'adresse #r=<id> : un rapport s'ouvre par un lien, et le bouton retour du téléphone le referme ──

const HASH = /^#r=([a-z0-9][a-z0-9-]{0,150})$/;
const hashReport = () => HASH.exec(location.hash)?.[1] ?? null;
const CHANGED = 'bureau:report';

// La mise en page du texte (marked) n'est chargée qu'avec le premier rapport ouvert .
let md: typeof import('./md.ts') | null = null;
const loadMd = () => import('./md.ts').then((m) => (md = m));

export function openReport(id: string) {
  void loadMd();
  sfx('open');
  history.pushState({ report: id }, '', `#r=${id}`);
  window.dispatchEvent(new Event(CHANGED));
}

export function closeReport() {
  if ((history.state as { report?: string } | null)?.report) history.back();
  else {
    history.replaceState(null, '', location.pathname + location.search);
    window.dispatchEvent(new Event(CHANGED));
  }
}

function useOpenReport() {
  const [id, setId] = useState(hashReport);
  useEffect(() => {
    const sync = () => setId(hashReport());
    const evs = ['hashchange', 'popstate', CHANGED];
    for (const e of evs) window.addEventListener(e, sync);
    return () => { for (const e of evs) window.removeEventListener(e, sync); };
  }, []);
  return id;
}

// ── Mise en forme ──

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
/** « 28 octobre » (l'année seulement si ce n'est pas celle-ci) */
function dateLabel(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const y = Number(m[1]);
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''}${y !== new Date().getFullYear() ? ` ${y}` : ''}`;
}
/** AAAA-MM-JJ à l'heure locale */
const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** temps de lecture : 220 mots par minute */
const readMin = (words: number) => Math.max(1, Math.round(words / 220));
/** texte sans gras ni code, espaces réduites, en minuscules : pour comparer un résumé et le début du rapport */
const plain = (s: string) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Les sujets, du plus récent au plus ancien, chacun avec ses rapports : d'abord la date du rapport (un clone git donne à
 * tous ses fichiers la même date de modification), puis la dernière mise à jour ; la synthèse du sujet en premier.
 */
function bySubject(list: ReportMeta[]) {
  const map = new Map<string, ReportMeta[]>();
  for (const r of [...list].sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))) {
    const k = r.subject || 'Autres';
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  // la synthèse vivante du sujet (missions/synthese-<sujet>-…) passe en tête de sa colonne, avant les détails
  return [...map.entries()].map(([subject, items]) => ({ subject, items: [...items.filter(isSynthesis), ...items.filter((r) => !isSynthesis(r))] }));
}

/** un rapport de synthèse par sujet : son dossier commence par « synthese- » */
const isSynthesis = (r: ReportMeta) => r.id.startsWith('synthese-');

// ── La liste ──

export function ReportsPage({ active }: { active: boolean }) {
  const list = useReports((s) => s.list);
  const error = useReports((s) => s.error);
  const archived = useReports((s) => s.archived);
  const archiveError = useReports((s) => s.archiveError);
  /** la vue « Archivés » : les rapports rangés, à remettre d'un geste ; la Trace y est repliée */
  const [showArchived, setShowArchived] = useState(false);
  const all = list ?? [];
  // la liste : les « À lire » et les « Référence » non archivés ; la Trace part toujours dans l'archive
  const inArchive = (r: ReportMeta) => !!archived[r.id] || levelOfMeta(r) === 'trace';
  const toRead = useMemo(() => all.filter((r) => !inArchive(r) && levelOfMeta(r) === 'a-lire'), [all, archived]); // eslint-disable-line react-hooks/exhaustive-deps
  const refs = useMemo(() => all.filter((r) => !inArchive(r) && levelOfMeta(r) === 'reference'), [all, archived]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = useMemo(() => all.filter((r) => !!archived[r.id] && levelOfMeta(r) !== 'trace'), [all, archived]);
  const traces = useMemo(() => all.filter((r) => levelOfMeta(r) === 'trace'), [all]);
  const archivedCount = done.length + traces.length;
  /** la recherche texte de la vue Archivés : titre et résumé, sans tenir compte des accents ni de la casse */
  const [query, setQuery] = useState('');
  const words = useMemo(() => fold(query).split(/\s+/).filter(Boolean), [query]);
  const match = (r: ReportMeta) => { const t = fold(`${r.title} ${r.summary}`); return words.every((w) => t.includes(w)); };
  const doneShown = useMemo(() => (words.length ? done.filter(match) : done), [done, words]); // eslint-disable-line react-hooks/exhaustive-deps
  const tracesShown = useMemo(() => (words.length ? traces.filter(match) : traces), [traces, words]); // eslint-disable-line react-hooks/exhaustive-deps
  // plus aucun archivé : retour à la liste
  useEffect(() => { if (showArchived && list && !archivedCount) setShowArchived(false); }, [showArchived, list, archivedCount]);

  useEffect(() => {
    if (!active) return;
    void loadReports();
    // la page reste ouverte : la liste se met à jour toute seule
    const t = setInterval(() => void loadReports(true), 5 * 60_000);
    return () => clearInterval(t);
  }, [active]);

  const toggleView = () => { sfx('click'); setShowArchived(!showArchived); };

  return (
    <section className="rp-page" aria-label="Rapports">
      <header className="ach-bar rp-head">
        <div className="ach-top">
          <h2>{showArchived ? 'Rapports archivés' : 'Rapports'}</h2>
          {list && list.length > 0 && (
            <span className="rp-count">
              {showArchived ? `${plural(done.length, 'archivé', 'archivés')}, ${traces.length} en trace` : `${toRead.length} à lire, ${refs.length} en référence`}
            </span>
          )}
          {archivedCount > 0 && (
            <button className="rp-arch-view" aria-pressed={showArchived} onClick={toggleView}>
              <PixelIcon name={showArchived ? 'back' : 'paper'} size={11} />
              {showArchived ? 'Retour aux rapports' : <>Archivés<small>{archivedCount}</small></>}
            </button>
          )}
        </div>
        {archiveError && <p className="rp-arch-error" role="alert">{archiveError}</p>}
      </header>

      {list === null ? (
        error ? <ReportsError /> : <ReportsSkeleton />
      ) : !list.length ? (
        <div className="rp-empty">
          <PixelIcon name="paper" size={28} />
          <p>Aucun rapport publié pour l’instant.</p>
        </div>
      ) : showArchived ? (
        <>
          <div className="rp-search">
            <PixelIcon name="search" size={12} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Chercher dans les archivés (titre, résumé)"
              aria-label="Chercher dans les rapports archivés" />
          </div>
          {words.length > 0 && !doneShown.length && !tracesShown.length ? (
            <p className="rp-level-empty">Aucun rapport archivé ne contient « {query.trim()} ».</p>
          ) : (
            <>
              <LevelSection level="done" title="Déjà lus" items={doneShown} open archived />
              {/* une recherche ouvre la Trace : sinon ses résultats resteraient cachés */}
              <LevelSection key={words.length ? 'q' : 'all'} level="trace" title="Trace" items={tracesShown} open={words.length > 0} archived />
            </>
          )}
        </>
      ) : (
        <>
          <LevelSection level="a-lire" title="À lire" items={toRead} open empty="Rien à lire pour l’instant. Les études restent dans Référence." />
          <LevelSection level="reference" title="Référence" items={refs} open={false} />
        </>
      )}
    </section>
  );
}

/** un texte comparable : minuscules, sans accents */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** le niveau d'un rapport (une liste publiée avant le champ n'en a pas : trace) */
const levelOfMeta = (r: ReportMeta): ReportLevel => r.level ?? 'trace';

/**
 * Une section de niveau, repliable (« À lire » seule ouverte par défaut) : ses rapports par sujet, en colonnes
 * comme un journal, avec le choix d'un sujet quand il y en a plusieurs ; « À lire » en simple grille, du plus récent au plus ancien.
 */
function LevelSection({ level, title, items, open, archived = false, empty }: {
  level: ReportLevel | 'done'; title: string; items: ReportMeta[]; open: boolean; archived?: boolean; empty?: string;
}) {
  const [subject, setSubject] = useState<string | null>(null);
  const groups = useMemo(() => bySubject(items), [items]);
  // un sujet choisi qui n'a plus de rapport : retour à tous les sujets
  const cur = subject && groups.length > 1 && groups.some((g) => g.subject === subject) ? subject : null;
  const shown = cur ? groups.filter((g) => g.subject === cur) : groups;
  if (!items.length && !empty) return null;
  const flat = level === 'a-lire' || !!cur;
  return (
    <details className={`rp-level rp-level-${level}`} open={open}>
      <summary>
        <span className="rp-level-title">{title}<small>{items.length}</small></span>
      </summary>
      <div className="rp-level-body">
        {!items.length ? (
          <p className="rp-level-empty">{empty}</p>
        ) : (
          <>
            {level !== 'a-lire' && groups.length > 1 && (
              <div className="ach-chips" role="tablist" aria-label={`Sujets, ${title}`}>
                <button role="tab" aria-selected={!cur} className={`ach-chip ${!cur ? 'on' : ''}`} onClick={() => { if (cur) { sfx('click'); setSubject(null); } }}>
                  Tous<small>{items.length}</small>
                </button>
                {groups.map((g) => (
                  <button key={g.subject} role="tab" aria-selected={cur === g.subject} className={`ach-chip ${cur === g.subject ? 'on' : ''}`}
                    onClick={() => { if (cur !== g.subject) { sfx('click'); setSubject(g.subject); } }}>
                    {g.subject}<small>{g.items.length}</small>
                  </button>
                ))}
              </div>
            )}
            {flat ? (
              <div className="rp-grid">
                {(level === 'a-lire' ? byDate(items) : shown[0]?.items ?? []).map((r) => <ReportCard key={r.id} r={r} archived={archived} noArchive={level === 'trace'} />)}
              </div>
            ) : (
              <div className="rp-groups">
                {shown.map((g) => (
                  <div key={g.subject} className="rp-group">
                    <h3>{g.subject} <small>{plural(g.items.length, 'rapport', 'rapports')}</small></h3>
                    {g.items.map((r) => <ReportCard key={r.id} r={r} archived={archived} noArchive={level === 'trace'} />)}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}

const byDate = (list: ReportMeta[]) => [...list].sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));

/** le cadre prend la forme de la couverture, du carré (captures en hauteur, montrées par le haut) au 2:1 ; 16:9 sans proportion connue. */
const coverFrame = (ratio?: number) => (ratio ? { aspectRatio: String(Math.min(2, Math.max(1, ratio))) } : undefined);

/** Archiver / Remettre : rangé à part, jamais supprimé */
function ArchiveButton({ id, archived, title }: { id: string; archived: boolean; title: string }) {
  return (
    <button className={`rp-arch${archived ? ' on' : ''}`} onClick={() => setArchived(id, !archived)}
      aria-label={archived ? `Remettre « ${title} » dans la liste` : `Archiver « ${title} »`}>
      <PixelIcon name={archived ? 'back' : 'paper'} size={10} />{archived ? 'Remettre' : 'Archiver'}
    </button>
  );
}

function ReportCard({ r, archived, noArchive = false }: { r: ReportMeta; archived: boolean; noArchive?: boolean }) {
  const imagesOn = useContext(ImagesOn);
  return (
    <div className="rp-card-box">
    <button className="rp-card" onClick={() => openReport(r.id)}>
      {/* sans image, la carte reste en texte : pas de cadre vide */}
      {r.cover && <span className={`rp-cover${r.coverRatio && r.coverRatio < 1 ? ' tall' : ''}`} style={coverFrame(r.coverRatio)}>{imagesOn && <img src={thumbUrl(r.cover)} alt="" loading="lazy" decoding="async" />}</span>}
      <span className="rp-card-body">
        <span className="rp-kicker">{r.subject} · {dateLabel(r.date)}</span>
        <b className="rp-card-title">{r.title}</b>
        {r.summary && <span className="rp-card-sum">{r.summary}</span>}
        <span className="rp-card-meta">
          <span><PixelIcon name="clock" size={10} />{readMin(r.words)} min de lecture</span>
          {r.images > 0 && <span><PixelIcon name="eye" size={10} />{plural(r.images, 'image', 'images')}</span>}
          {r.issue && <span title="Numéro de l’étude">#{r.issue}</span>}
        </span>
      </span>
    </button>
    {/* une Trace reste dans l'archive : rien à archiver ni à remettre */}
    {!noArchive && <ArchiveButton id={r.id} archived={archived} title={r.title} />}
    </div>
  );
}

function ReportsSkeleton() {
  return (
    <div className="rp-grid" aria-busy="true" aria-label="Chargement des rapports">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rp-card skel-card">
          <span className="rp-cover" />
          <span className="rp-card-body">
            <span className="skel-line w40" />
            <span className="skel-line" />
            <span className="skel-line w60" />
          </span>
        </div>
      ))}
    </div>
  );
}

function ReportsError() {
  return (
    <div className="rp-empty">
      <p>Les rapports n’ont pas pu être chargés.</p>
      <button className="ach-more" onClick={() => { sfx('click'); void loadReports(true); }}>Réessayer</button>
    </div>
  );
}

// ── La page de lecture ──

/** Le rapport ouvert (#r=<id>), par-dessus l'étage. */
export function ReportReader() {
  const id = useOpenReport();
  if (!id) return null;
  return <Reader key={id} id={id} />;
}

function Reader({ id }: { id: string }) {
  const meta = useReports((s) => s.list?.find((r) => r.id === id) ?? null);
  const listLoaded = useReports((s) => s.list !== null);
  const cached = useReports((s) => s.bodies[id] ?? null);
  /** le texte a été chargé par cette page : il est au moins aussi récent que la liste */
  const fresh = useRef(false);
  const fetched = cached && (fresh.current || !meta || cached.sig === meta.sig) ? cached : null;
  const [mdOk, setMdOk] = useState(!!md);
  useEffect(() => { if (!md) void loadMd().then(() => setMdOk(true)); }, []);
  const report = mdOk ? fetched : null;
  const [failed, setFailed] = useState(false);
  const [viewer, setViewer] = useState<{ media: FeedMedia[]; i: number } | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const progress = useRef<HTMLElement>(null);
  const article = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // la liste (pour les autres rapports du sujet), puis le texte s'il n'est pas déjà là
  useEffect(() => { void loadReports(); }, []);
  useEffect(() => {
    if (fetched) return;
    let gone = false;
    setFailed(false);
    fetch(`/reports/${id}.json`, { credentials: 'same-origin', cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<Report>; })
      .then((rep) => {
        if (gone) return;
        fresh.current = true;
        useReports.setState((s) => ({ bodies: { ...s.bodies, [id]: rep } }));
        // la liste est plus ancienne que ce rapport : on la recharge
        if (useReports.getState().list?.find((r) => r.id === id)?.sig !== rep.sig) void loadReports(true);
      })
      .catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, [id, fetched]);

  const list = useReports((s) => s.list);
  const doc = useMemo(() => (report && md ? md.reportToHtml(report.body) : { html: '', toc: [] as Heading[] }), [report]);
  const info = report ?? meta;
  // le résumé audio arrive après le texte (30 min au moins) : la liste, relue chaque minute, le montre sans recharger
  const audio = meta ? meta.audio : report?.audio;
  const heroInBody = !!info?.cover && !!report && report.body.includes(info.cover);
  // un résumé que le rapport reprend dès ses premières lignes (« **Verdict** : … ») n'est pas répété en chapeau
  const ledeInBody = !!info?.summary && !!report && plain(report.body.slice(0, 2000)).includes(plain(info.summary).replace(/ \(…\)$/, '').slice(0, 80));

  // Échap : ferme l'image en grand d'abord, puis le rapport
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !viewer && !useOffice.getState().sheet) { e.stopPropagation(); closeReport(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer]);

  useEffect(() => { scroller.current?.focus({ preventScroll: true }); }, []);

  // la barre de progression suit la lecture (sans nouveau rendu) ; le sommaire suit la partie à l'écran
  useEffect(() => {
    const el = scroller.current;
    if (!el || !report) return;
    let raf = 0;
    const heads = [...(article.current?.querySelectorAll<HTMLElement>('.rp-body h2') ?? [])];
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const max = el.scrollHeight - el.clientHeight;
        if (progress.current) progress.current.style.transform = `scaleX(${max > 0 ? Math.min(1, el.scrollTop / max) : 1})`;
        const top = el.getBoundingClientRect().top + 120;
        let cur: string | null = null;
        for (const h of heads) { if (h.getBoundingClientRect().top <= top) cur = h.id.slice(3); else break; }
        setCurrent(cur);
      });
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, [report]);

  const goTo = (h: string) => {
    const target = article.current?.querySelector<HTMLElement>(`#rp-${CSS.escape(h)}`);
    const el = scroller.current;
    if (!target || !el) return;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 72, behavior: reduced ? 'auto' : 'smooth' });
  };

  // une image du texte : en grand, avec les autres images du rapport
  const onBodyClick = (e: React.MouseEvent) => {
    const img = (e.target as HTMLElement).closest('img');
    if (!img || !article.current) return;
    const imgs = [...article.current.querySelectorAll<HTMLImageElement>('.rp-body img')];
    const i = imgs.indexOf(img as HTMLImageElement);
    if (i < 0) return;
    sfx('open');
    setViewer({ media: imgs.map((x) => ({ url: x.getAttribute('src') ?? '', kind: 'image', label: x.alt || undefined })), i });
  };

  const archived = useReports((s) => s.archived);
  const isArchived = !!archived[id];
  const subject = info?.subject;
  const others = useMemo(() => (subject ? (list ?? []).filter((r) => r.subject === subject && r.id !== id && !archived[r.id] && (r.level ?? 'trace') !== 'trace').slice(0, 3) : []), [list, subject, id, archived]);

  return (
    <div className="rp-reader" role="dialog" aria-modal="true" aria-label={info?.title ?? 'Rapport'}>
      <header className="rp-bar">
        <button className="rp-back" onClick={() => { sfx('click'); closeReport(); }}>
          <PixelIcon name="back" size={12} />Rapports
        </button>
        <span className="rp-bar-title">{info?.title ?? ''}</span>
        {info && <ArchiveButton id={id} archived={isArchived} title={info.title} />}
        {report && info && <PdfActions article={article} title={info.title} sig={report.sig} pdf={report.pdf} />}
        <i className="rp-progress" ref={progress} aria-hidden="true" />
      </header>
      <div className="rp-scroll" ref={scroller} tabIndex={-1}>
        <div className={`rp-layout ${doc.toc.length > 2 ? 'with-toc' : ''}`}>
          {doc.toc.length > 2 && (
            <nav className="rp-toc" aria-label="Sommaire">
              <b>Sommaire</b>
              <ol>
                {doc.toc.map((h) => (
                  <li key={h.id}><button className={current === h.id ? 'on' : ''} onClick={() => goTo(h.id)}>{h.text}</button></li>
                ))}
              </ol>
            </nav>
          )}
          <article className="rp-article" ref={article}>
            {info ? (
              <>
                <p className="rp-kicker">
                  {info.subject} · {dateLabel(info.date)} · {readMin(info.words)} min de lecture
                  {info.issue ? <span title="Numéro de l’étude"> · étude {info.issue}</span> : null}
                </p>
                <h1>{info.title}</h1>
                {info.summary && report && !ledeInBody && <p className="rp-lede">{info.summary}</p>}
                {/* le résumé audio de cette version du rapport */}
                {report && audio && <ReportAudio url={audio.url} seconds={audio.seconds} />}
                {info.cover && report && !heroInBody && (
                  <figure className="rp-hero"><img src={info.cover} alt="" decoding="async" /></figure>
                )}
              </>
            ) : null}

            {report ? (
              <>
                {doc.toc.length > 2 && (
                  <details className="rp-toc-mobile">
                    <summary>Sommaire <small>{plural(doc.toc.length, 'partie', 'parties')}</small></summary>
                    <ol>{doc.toc.map((h) => <li key={h.id}><button onClick={() => goTo(h.id)}>{h.text}</button></li>)}</ol>
                  </details>
                )}
                <div className="rp-body" ref={bodyRef} onClick={onBodyClick} dangerouslySetInnerHTML={{ __html: doc.html }} />
                <footer className="rp-end">
                  <p>Mis à jour le {dateLabel(localDay(report.updatedAt))}{report.issue ? ` · étude #${report.issue}` : ''}.</p>
                  {others.length > 0 && (
                    <div className="rp-others">
                      <b>Dans le même sujet</b>
                      {others.map((r) => (
                        <button key={r.id} className="rp-other" onClick={() => openReport(r.id)}>
                          <span>{r.title}</span><small>{readMin(r.words)} min</small>
                        </button>
                      ))}
                    </div>
                  )}
                  <button className="ach-more" onClick={() => { sfx('click'); closeReport(); }}>Retour aux rapports</button>
                </footer>
              </>
            ) : failed ? (
              <div className="rp-empty">
                <p>{listLoaded && !meta ? 'Ce rapport n’existe plus.' : 'Le rapport n’a pas pu être chargé.'}</p>
                <button className="ach-more" onClick={() => { sfx('click'); closeReport(); }}>Retour aux rapports</button>
              </div>
            ) : (
              <div className="rp-body-skel" aria-busy="true" aria-label="Chargement du rapport">
                {!info && <span className="skel-line w40" />}
                {[100, 92, 96, 60, 0, 100, 88, 94, 72].map((w, i) => (w ? <span key={i} className="skel-line" style={{ width: `${w}%` }} /> : <br key={i} />))}
              </div>
            )}
          </article>
        </div>
      </div>
      {viewer && <Viewer media={viewer.media} start={viewer.i} onClose={() => setViewer(null)} />}
    </div>
  );
}

// ── Le PDF : télécharger, ou envoyer (Mail, WhatsApp… par le partage du système) ──

/** le PDF fait par le collecteur (/media/<id>.pdf) ; null s'il ne se charge pas */
async function printedPdf(url: string): Promise<Blob | null> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/pdf')) return null;
    return await res.blob();
  } catch { return null; }
}

function PdfActions({ article, title, sig, pdf }: { article: React.RefObject<HTMLDivElement | null>; title: string; sig: string; pdf?: string }) {
  const [busy, setBusy] = useState<'pdf' | 'send' | null>(null);
  const [fallback, setFallback] = useState(false);
  /** le PDF déjà fait pour cette version du rapport */
  const made = useRef<{ sig: string; blob: Blob } | null>(null);
  const toast = useOffice((s) => s.toast);
  const name = pdfName(title);

  const build = async () => {
    // la clé compte aussi l'adresse du PDF : une photographie faite avant qu'il existe n'est plus resservie ensuite
    const key = `${sig}|${pdf ?? ''}`;
    if (made.current?.sig === key) return made.current.blob;
    // le PDF imprimé par le collecteur (texte net et sélectionnable) ; la photographie de la page en secours
    const blob = (pdf && (await printedPdf(pdf))) || (article.current ? await reportPdf(article.current) : null);
    if (!blob) throw new Error('rapport absent');
    made.current = { sig: key, blob };
    return blob;
  };

  const download = async () => {
    if (busy) return;
    sfx('click');
    setBusy('pdf');
    try { saveFile(await build(), name); }
    catch { toast('error', 'Le PDF n’a pas pu être créé. Réessaie.'); }
    finally { setBusy(null); }
  };

  const send = async () => {
    if (busy) return;
    sfx('click');
    const ready = made.current?.sig === `${sig}|${pdf ?? ''}`;
    setBusy('send');
    try {
      const blob = await build();
      const res = await shareFile(blob, name, title);
      if (res === false) setFallback(true);
    } catch (e) {
      // la fabrication a pris trop de temps : le navigateur refuse d'ouvrir le partage sans un nouveau geste
      if (!ready && (e as DOMException)?.name === 'NotAllowedError') toast('info', 'Le PDF est prêt : touche encore Envoyer.');
      else toast('error', 'L’envoi n’a pas pu s’ouvrir. Télécharge le PDF puis joins-le.');
    } finally { setBusy(null); }
  };

  // sans partage de fichier (ordinateur) : le PDF est téléchargé, puis on ouvre Mail ou WhatsApp pour le joindre
  const via = async (to: 'mail' | 'whatsapp') => {
    sfx('click');
    setFallback(false);
    try { saveFile(await build(), name); } catch { toast('error', 'Le PDF n’a pas pu être créé. Réessaie.'); return; }
    const text = `${title} (rapport en PDF joint)`;
    const url = to === 'mail'
      ? `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent('Bonjour,\n\nVoici le rapport en PDF, en pièce jointe.\n')}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener');
    toast('info', 'PDF téléchargé : joins-le au message.');
  };

  return (
    <div className="rp-actions">
      <button className="rp-act" onClick={() => void download()} disabled={!!busy} aria-busy={busy === 'pdf'}>
        <PixelIcon name={busy === 'pdf' ? 'hourglass' : 'download'} size={12} />
        <span>{busy === 'pdf' ? 'Création…' : 'PDF'}</span>
      </button>
      <button className="rp-act primary" onClick={() => void send()} disabled={!!busy} aria-busy={busy === 'send'}>
        <PixelIcon name={busy === 'send' ? 'hourglass' : 'send'} size={12} />
        <span>{busy === 'send' ? 'Création…' : 'Envoyer'}</span>
      </button>
      {fallback && (
        <div className="rp-send-menu" role="menu">
          <b>Envoyer le PDF par</b>
          <button role="menuitem" onClick={() => void via('mail')}>E-mail</button>
          <button role="menuitem" onClick={() => void via('whatsapp')}>WhatsApp</button>
          <button role="menuitem" onClick={() => { sfx('click'); setFallback(false); void download(); }}>Juste télécharger</button>
          <button className="rp-send-close" aria-label="Fermer" onClick={() => setFallback(false)}><PixelIcon name="cross" size={10} /></button>
        </div>
      )}
    </div>
  );
}
