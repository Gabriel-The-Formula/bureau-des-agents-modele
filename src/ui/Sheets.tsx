// Les fiches de l'étage, pour lire sans quitter le bureau :
//  - une décision qui t'attend : la question, le contexte, pourquoi c'est à toi, les choix et leurs conséquences ;
//  - une réalisation en entier : le résumé, ce qui a été fait, les résultats, ce qui reste, les captures.
// De là, on peut ouvrir la conversation de l'agent (sa salle) ; le lien GitHub n'est plus qu'une info en bas.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CATEGORY_LABELS, type Decision, type FeedCategory, type FeedEntry, type FeedMedia, type SessionSummary } from '../../shared/live.ts';
import { sfx } from '../audio/sfx.ts';
import { go } from '../net/link.ts';
import { useNeeds } from './needs.ts';
import { useOffice } from '../state/store.ts';
import { COST_HINT, ago, dayLabel, fmtCost, fmtHour, plural, thumbUrl } from './format.ts';
import { PixelIcon } from './PixelIcon.tsx';
import { STATUS_LABEL, useNow } from './sessions.ts';
import { tidy } from './tidy.ts';

/** Le Worker garde la conversation d'une session 3 jours après sa dernière activité. */
const ROOM_KEPT_MS = 3 * 24 * 3600_000;

const safeLink = (u: string) => /^https?:\/\//i.test(u);
const safeImg = (u: string) => /^\/(?!\/)/.test(u) || /^https:\/\//i.test(u) || /^data:image\/(png|jpe?g|gif|webp);/i.test(u);
/** Les fichiers qui ne disent rien au lecteur (README, journaux, configs, code) : pas affichés. */
export const TECH_FILE = /^(readme|changelog|license|agents|claude)(\.\w+)?$|\.(md|json|ya?ml|toml|lock|log|ts|tsx|js|mjs|vue|py|sh|sql|css|xs|txt)$/i;
export const catOf = (e: FeedEntry): FeedCategory => (CATEGORY_LABELS[e.category] ? e.category : 'autre');

const FROM_LABEL: Record<Decision['from'], string> = {
  question: 'Question posée par l’agent',
  plan: 'Plan à valider',
  'fin-de-tour': 'Question de fin de tour',
  resume: 'Tirée du compte rendu',
};

/** Les fiches ouvertes depuis l'étage (une à la fois). */
export function Sheets() {
  const sheet = useOffice((s) => s.sheet);
  const [viewer, setViewer] = useState<{ media: FeedMedia[]; i: number } | null>(null);
  if (!sheet) return null;
  return (
    <>
      {sheet.kind === 'decision' ? <DecisionSheet k={sheet.key} onMedia={(media, i) => setViewer({ media, i })} />
        : <EntrySheet k={sheet.key} onMedia={(media, i) => setViewer({ media, i })} />}
      {viewer && <Viewer media={viewer.media} start={viewer.i} onClose={() => setViewer(null)} />}
    </>
  );
}

const closeSheet = () => useOffice.setState({ sheet: null });

/** Passer d'une fiche à la voisine : boutons, flèches du clavier, ou glisser du doigt. */
interface Nav { pos: number; total: number; prev?: () => void; next?: () => void }

function Shell({ title, sub, cls = '', children, foot, nav }: { title: React.ReactNode; sub?: React.ReactNode; cls?: string; children: React.ReactNode; foot?: React.ReactNode; nav?: Nav }) {
  const touch = useRef<{ x: number; y: number } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.viewer-back')) return;
      if (e.key === 'Escape') closeSheet();
      else if (e.key === 'ArrowRight' && nav?.next) { e.preventDefault(); nav.next(); }
      else if (e.key === 'ArrowLeft' && nav?.prev) { e.preventDefault(); nav.prev(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav]);
  // une nouvelle fiche commence en haut
  useEffect(() => { body.current?.scrollTo({ top: 0 }); }, [title]);
  return (
    <div className="modal-back sheet-back" onClick={closeSheet}>
      <div
        className={`modal sheet ${cls}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        onTouchStart={(e) => { if (nav && !(e.target as HTMLElement).closest('.ach-thumb')) touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
        onTouchEnd={(e) => {
          const t = touch.current;
          touch.current = null;
          if (!t || !nav) return;
          const dx = e.changedTouches[0].clientX - t.x;
          const dy = e.changedTouches[0].clientY - t.y;
          // un vrai glissement horizontal (pas un défilement vertical)
          if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
          if (dx < 0) nav.next?.(); else nav.prev?.();
        }}
      >
        <div className="modal-head">
          <div className="room-title sheet-title"><b>{title}</b>{sub && <span>{sub}</span>}</div>
          {nav && nav.total > 1 && (
            <div className="sheet-nav">
              <button onClick={nav.prev} disabled={!nav.prev} aria-label="Fiche précédente"><PixelIcon name="prev" size={12} /></button>
              <span>{nav.pos} / {nav.total}</span>
              <button onClick={nav.next} disabled={!nav.next} aria-label="Fiche suivante"><PixelIcon name="next" size={12} /></button>
            </div>
          )}
          <button className="close" onClick={closeSheet} aria-label="Fermer">×</button>
        </div>
        <div className="modal-body sheet-body" ref={body} key={String(title)}>{children}</div>
        {foot && <div className="sheet-foot">{foot}</div>}
      </div>
    </div>
  );
}

/** Ouvre la salle (la conversation de l'agent) en fermant la fiche. */
function openRoom(key: string) {
  sfx('open');
  useOffice.setState({ sheet: null });
  go(key);
}

function RoomButton({ k, primary = true }: { k: string; primary?: boolean }) {
  return (
    <button className={`sheet-btn ${primary ? 'primary' : ''}`} onClick={() => openRoom(k)}>
      <PixelIcon name="eye" size={12} />Ouvrir la conversation
    </button>
  );
}

// ── Une décision ──

/** La navigation entre les fiches « À toi de jouer », dans l'ordre de la liste de l'étage. */
function useNeedNav(k: string): Nav {
  const needs = useNeeds();
  const i = needs.findIndex((x) => x.key === k);
  // la dernière place connue de la fiche : quand elle sort de la liste (validée, réponse arrivée), « suivante » mène à
  // celle qui a pris sa place, pas à la première
  const at = useRef(0);
  if (i >= 0) at.current = i;
  const go = (j: number) => { const n = needs[j]; if (n) { sfx('click'); useOffice.setState({ sheet: { kind: 'decision', key: n.key } }); } };
  if (i < 0) {
    const j = Math.min(at.current, needs.length - 1);
    return { pos: 0, total: needs.length, next: j >= 0 ? () => go(j) : undefined };
  }
  return { pos: i + 1, total: needs.length, prev: i > 0 ? () => go(i - 1) : undefined, next: i < needs.length - 1 ? () => go(i + 1) : undefined };
}

function DecisionSheet({ k, onMedia }: { k: string; onMedia: (media: FeedMedia[], i: number) => void }) {
  const session = useOffice((s) => s.sessions.find((x) => x.key === k));
  const entry = useOffice((s) => s.achievements.find((x) => x.key === k));
  const now = useNow(30_000);
  const nav = useNeedNav(k);
  const waiting = session && (session.status === 'waiting' || session.status === 'blocked');
  if (!waiting && !entry?.needsYou) {
    return (
      <Shell title="Plus rien à trancher ici" nav={nav}>
        <p className="sheet-p">Cette décision n’attend plus : la session a repris ou la réponse est arrivée.</p>
      </Shell>
    );
  }
  const decision = waiting ? session.decision : entry?.decision;
  const title = tidy((waiting ? session.doing || session.title : entry?.title) || 'Session');
  const at = waiting ? session.lastActivity : entry!.at;
  const label = waiting ? STATUS_LABEL[session.status] : 'Décision';
  const canOpen = !!session || now - at < ROOM_KEPT_MS;
  const media = ((waiting ? session.media : undefined) ?? entry?.media ?? []).filter((m) => safeImg(m.url));
  return (
    <Shell
      cls="decision"
      title={title}
      sub={<><em className="sheet-kind">{label}</em> · {ago(at, now)}</>}
      foot={canOpen ? <RoomButton k={k} /> : undefined}
      nav={nav}
    >
      {decision ? <DecisionBody d={decision} media={media} onMedia={onMedia} /> : waiting ? <WaitingFallback s={session} /> : (
        <section className="sheet-sec">
          <h4>La question</h4>
          <p className="sheet-q">{tidy(entry!.needsYou!)}</p>
          <p className="sheet-note">Le détail de cette décision n’a pas pu être préparé : ouvre la conversation pour le contexte complet.</p>
        </section>
      )}
      {entry && <WorkDone e={entry} short />}
      {waiting && session.request?.first && (
        <section className="sheet-sec">
          <h4>Ta demande de départ</h4>
          <p className="sheet-p">{tidy(session.request.first)}</p>
        </section>
      )}
    </Shell>
  );
}

/** Le cœur d'une décision : la question, le contexte, pourquoi c'est à toi, les choix et leurs conséquences. */
export function DecisionBody({ d, media = [], onMedia }: { d: Decision; media?: FeedMedia[]; onMedia?: (media: FeedMedia[], i: number) => void }) {
  return (
    <>
      <section className="sheet-sec">
        <h4>La question <small>{FROM_LABEL[d.from]}</small></h4>
        <p className="sheet-q">{tidy(d.question)}</p>
      </section>
      {d.context && (
        <section className="sheet-sec">
          <h4>{d.from === 'plan' ? 'Le plan proposé' : 'Le contexte'}</h4>
          <p className="sheet-p pre">{tidy(d.context)}</p>
        </section>
      )}
      {media.length > 0 && onMedia && <Captures media={media} onMedia={onMedia} title="Pour voir la différence" />}
      {d.why && (
        <section className="sheet-sec">
          <h4>Pourquoi c’est à toi</h4>
          <p className="sheet-p">{tidy(d.why)}</p>
        </section>
      )}
      {d.options.length > 0 && (
        <section className="sheet-sec">
          <h4>Les choix possibles</h4>
          <ol className="sheet-options">
            {d.options.map((o, i) => (
              <li key={i}>
                <b>{tidy(o.label)}</b>
                {o.effect && <span>{tidy(o.effect)}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
      {d.advice && <p className="sheet-advice"><b>Conseil de l’agent :</b> {tidy(d.advice)}</p>}
    </>
  );
}

/** Une session qui attend sans question lisible (bloquée, ou ancienne version du collecteur) : ce qu'on sait d'elle. */
function WaitingFallback({ s }: { s: SessionSummary }) {
  const done = s.plan.filter((p) => p.status === 'completed').length;
  return (
    <>
      <section className="sheet-sec">
        <h4>Ce qui se passe</h4>
        <p className="sheet-q">{tidy(s.statusText && s.statusText !== STATUS_LABEL[s.status] ? s.statusText : s.status === 'waiting' ? 'Une question t’attend dans la conversation.' : 'Une permission ou une commande la retient.')}</p>
        {s.lastAct && <p className="sheet-p">Dernière action : {tidy(s.lastAct)}</p>}
      </section>
      {s.plan.length > 0 && (
        <section className="sheet-sec">
          <h4>Le plan <small>{done}/{s.plan.length}</small></h4>
          <ul className="sheet-list plan">{s.plan.map((p, i) => <li key={i} className={p.status}>{tidy(p.text)}</li>)}</ul>
        </section>
      )}
    </>
  );
}

// ── Une réalisation ──

function EntrySheet({ k, onMedia }: { k: string; onMedia: (media: FeedMedia[], i: number) => void }) {
  const e = useOffice((s) => s.achievements.find((x) => x.key === k));
  const inFloor = useOffice((s) => s.sessions.some((x) => x.key === k));
  const now = useNow(30_000);
  if (!e) return <Shell title="Réalisation introuvable"><p className="sheet-p">Elle n’est plus dans le fil (gardé 30 jours).</p></Shell>;
  const c = catOf(e);
  const canOpen = inFloor || now - e.at < ROOM_KEPT_MS;
  const links = e.links.filter((l) => safeLink(l.url));
  const pr = links.filter((l) => /\/pull\/\d+/.test(l.url));
  const other = links.filter((l) => !/\/pull\/\d+/.test(l.url));
  return (
    <Shell
      cls="entry"
      title={tidy(e.title || 'Session')}
      sub={<><i className={`cat-dot ${c}`} /> {CATEGORY_LABELS[c]}{e.sub ? ` / ${tidy(e.sub)}` : ''} · {dayLabel(e.at, now, true)} à {fmtHour(e.at)}</>}
      foot={canOpen ? <RoomButton k={k} /> : <span className="sheet-note">Conversation plus gardée (plus de 3 jours).</span>}
    >
      <WorkDone e={e} onMedia={onMedia} />
      {e.needsYou && (
        <section className="sheet-sec needs">
          <h4>À toi de jouer</h4>
          {e.decision ? <DecisionBody d={e.decision} /> : <p className="sheet-q">{tidy(e.needsYou)}</p>}
        </section>
      )}
      <footer className="sheet-meta">
        {e.tasks > 0 && <span>{plural(e.tasks, 'tâche cochée', 'tâches cochées')}</span>}
        <span title={COST_HINT}>{fmtCost(e.cost)}</span>
        {other.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer"><PixelIcon name="link" size={10} />{tidy(l.label)}</a>)}
        {pr.map((l) => <a key={l.url} className="sheet-pr" href={l.url} target="_blank" rel="noopener noreferrer" title="Le détail technique, sur GitHub">{tidy(l.label)} sur GitHub</a>)}
      </footer>
    </Shell>
  );
}

/** Ce qui a été fait : le résumé, puis le détail (fait / résultats / reste), les captures et les fichiers livrés. */
function WorkDone({ e, short = false, onMedia }: { e: FeedEntry; short?: boolean; onMedia?: (media: FeedMedia[], i: number) => void }) {
  const media = useMemo(() => e.media.filter((m) => safeImg(m.url)), [e.media]);
  const files = e.files.filter((f) => !TECH_FILE.test(f.trim()));
  const d = e.detail;
  return (
    <>
      <section className="sheet-sec">
        <h4>{short ? 'Le travail fait' : 'En bref'}</h4>
        {e.summary ? <p className="sheet-p">{tidy(e.summary)}</p> : <p className="sheet-note">Pas de résumé pour cette session.</p>}
      </section>
      {d && d.done.length > 0 && (
        <section className="sheet-sec">
          <h4>Ce qui a été fait</h4>
          <ul className="sheet-list">{d.done.map((x, i) => <li key={i}>{tidy(x)}</li>)}</ul>
        </section>
      )}
      {d && d.results.length > 0 && (
        <section className="sheet-sec">
          <h4>Les résultats</h4>
          <ul className="sheet-list ok">{d.results.map((x, i) => <li key={i}>{tidy(x)}</li>)}</ul>
        </section>
      )}
      {d && d.left.length > 0 && !short && (
        <section className="sheet-sec">
          <h4>Ce qui reste</h4>
          <ul className="sheet-list left">{d.left.map((x, i) => <li key={i}>{tidy(x)}</li>)}</ul>
        </section>
      )}
      {!short && media.length > 0 && onMedia && <Captures media={media} onMedia={onMedia} />}
      {!short && files.length > 0 && (
        <section className="sheet-sec">
          <h4>Fichiers livrés</h4>
          <div className="ach-refs">{files.map((f) => <span key={f} className="ach-file" title={tidy(f)}><PixelIcon name="paper" size={10} />{tidy(f)}</span>)}</div>
        </section>
      )}
    </>
  );
}

/** Les captures (avant / après côte à côte), un toucher pour les voir en grand. */
function Captures({ media, onMedia, title = 'Captures' }: { media: FeedMedia[]; onMedia: (media: FeedMedia[], i: number) => void; title?: string }) {
  return (
    <section className="sheet-sec">
      <h4>{title} <small>{media.length > 1 ? `${media.length} images` : ''}</small></h4>
      <div className={`sheet-media ${media.length === 1 ? 'single' : ''}`}>
        {media.map((m, i) => (
          <button key={m.url + i} className="ach-thumb" onClick={() => { sfx('open'); onMedia(media, i); }} aria-label={m.label ? `Agrandir ${m.label}` : 'Agrandir l’image'}>
            <img src={thumbUrl(m.url)} alt={m.label ?? ''} loading="lazy" decoding="async" />
            {m.label && !/^capture \d+$/i.test(m.label) && <span className={`ach-thumb-label ${/^avant$/i.test(m.label) ? 'before' : /^apr[eè]s$/i.test(m.label) ? 'after' : ''}`}>{m.label}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * La visionneuse : une pop-up par-dessus la page (fond assombri, l'image à 80 % de l'écran au plus), pas un plein écran.
 * Fermer : la croix, un clic à côté, Échap, ou glisser l'image vers le bas au doigt. Suivante / précédente aux flèches
 * ou en glissant de côté.
 */
export function Viewer({ media, start, onClose }: { media: FeedMedia[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const n = media.length;
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [dy, setDy] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowRight' && n > 1) setI((x) => (x + 1) % n);
      else if (e.key === 'ArrowLeft' && n > 1) setI((x) => (x - 1 + n) % n);
    };
    // capture : Échap ferme la pop-up d'abord, pas la page (rapport, fiche) qui est dessous
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [n, onClose]);
  const m = media[i];
  if (!m) return null;
  // dans le body : une page de l'étage qui glisse (transform) piégerait sinon la pop-up dans son cadre (téléphone)
  return createPortal(
    <div className="modal-back viewer-back" onClick={onClose} style={dy ? { opacity: Math.max(0.35, 1 - dy / 400) } : undefined}>
      <div className="modal viewer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={m.label || 'Image'}
        style={dy ? { transform: `translateY(${dy}px)`, transition: 'none' } : undefined}>
        <div className="modal-head">
          <b>{m.label && !/^capture \d+$/i.test(m.label) ? m.label : 'Capture'}{n > 1 && <small> {i + 1} / {n}</small>}</b>
          <button className="close" onClick={onClose} aria-label="Fermer">×</button>
        </div>
        <div
          className="viewer-body"
          onTouchStart={(e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
          onTouchMove={(e) => {
            const t = touch.current;
            if (!t) return;
            const my = e.touches[0].clientY - t.y;
            const mx = e.touches[0].clientX - t.x;
            if (my > 0 && my > Math.abs(mx)) setDy(my);
          }}
          onTouchEnd={(e) => {
            const t = touch.current;
            touch.current = null;
            if (!t) return;
            const dx = e.changedTouches[0].clientX - t.x;
            const down = e.changedTouches[0].clientY - t.y;
            setDy(0);
            if (down > 90 && down > Math.abs(dx)) { onClose(); return; }
            if (n > 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(down)) setI((x) => (x + (dx < 0 ? 1 : -1) + n) % n);
          }}
          onTouchCancel={() => { touch.current = null; setDy(0); }}
        >
          <img src={m.url} alt={m.label ?? ''} />
          {n > 1 && (
            <>
              <button className="viewer-nav prev" onClick={() => setI((i - 1 + n) % n)} aria-label="Image précédente"><PixelIcon name="prev" size={14} /></button>
              <button className="viewer-nav next" onClick={() => setI((i + 1) % n)} aria-label="Image suivante"><PixelIcon name="next" size={14} /></button>
            </>
          )}
        </div>
      </div>
    </div>
  , document.body);
}
