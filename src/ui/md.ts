// Le markdown des rapports, affiché sans risque : pas de HTML brut, des liens web seulement (ouverts
// dans un nouvel onglet), pas d'images distantes.
import { Marked } from 'marked';

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const marked = new Marked({ breaks: true, gfm: true });
marked.use({
  renderer: {
    html: ({ text }) => escapeHtml(text ?? ''),
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!SAFE_URL.test(href ?? '')) return text;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image({ text }) { return escapeHtml(text ?? ''); },
  },
});

export function mdToHtml(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

// ── Les rapports longs (onglet « Rapports ») ──
// Mêmes garde-fous, plus : les images du R2 privé (/media/<id>) en figure avec leur légende, des titres ancrés pour le
// sommaire, les tableaux dans un cadre qui défile sur téléphone.

const MEDIA_URL = /^\/media\/[0-9a-f]{32}\.(?:jpg|png|webp)$/;
/** un extrait sonore du rapport (banc de voix) : lu sur place */
const CLIP_URL = /^\/media\/[0-9a-f]{32}\.mp3$/;
// Une vidéo du R2 privé : un lien [Titre](/video/<id>.mp4) seul dans son paragraphe devient un lecteur dans le rapport.
// L'identifiant s'écrit par tranches de 4 (/video/k13x/5Gwu/.mp4) : entier, le collecteur le caviarde comme un jeton.
const VIDEO_URL = /^\/video\/((?:[A-Za-z0-9]{1,4}\/){3,8}[A-Za-z0-9]{1,4})\.mp4$/;

export interface Heading { id: string; text: string }

const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!);
const slugify = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export function reportToHtml(text: string): { html: string; toc: Heading[] } {
  const toc: Heading[] = [];
  const used = new Map<string, number>();
  const md = new Marked({ gfm: true, breaks: false });
  md.use({
    renderer: {
      html: ({ text }) => escapeHtml(text ?? ''),
      link({ href, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const video = VIDEO_URL.exec(href ?? '');
        if (video) {
          const id = video[1].replace(/\//g, '');
          return `<figure class="rp-video"><video controls playsinline preload="none" poster="/video/${id}.jpg" src="/video/${id}.mp4"></video><figcaption>${inner}</figcaption></figure>`;
        }
        if (!SAFE_URL.test(href ?? '')) return inner;
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
      },
      image({ href, text }) {
        if (CLIP_URL.test(href ?? '')) {
          const label = escapeHtml(text ?? '');
          return `<figure class="rp-clip"><audio controls preload="none" src="${href}"${label ? ` aria-label="${label}"` : ''}></audio>${label ? `<figcaption>${label}</figcaption>` : ''}</figure>`;
        }
        if (!MEDIA_URL.test(href ?? '')) return text ? `<em>${escapeHtml(text)}</em>` : '';
        const alt = escapeHtml(text ?? '');
        return `<figure><img src="${href}" alt="${alt}" loading="lazy" decoding="async">${alt ? `<figcaption>${alt}</figcaption>` : ''}</figure>`;
      },
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const plain = unescape(inner.replace(/<[^>]+>/g, '')).trim();
        const base = slugify(plain) || 'partie';
        const n = (used.get(base) ?? 0) + 1;
        used.set(base, n);
        const id = n > 1 ? `${base}-${n}` : base;
        if (depth <= 2) toc.push({ id, text: plain });
        // un titre de premier niveau dans le texte devient un titre de partie (le titre du rapport est déjà en haut)
        const level = Math.min(4, Math.max(2, depth));
        return `<h${level} id="rp-${id}">${inner}</h${level}>`;
      },
    },
  });
  const html = (md.parse(text, { async: false }) as string)
    // une image seule sur sa ligne : la figure, sans le paragraphe autour
    .replace(/<p>\s*(<figure>[\s\S]*?<\/figure>)\s*<\/p>/g, '$1')
    .replace(/<p>\s*(<figure class="rp-(?:video|clip)">[\s\S]*?<\/figure>)\s*<\/p>/g, '$1')
    .replace(/<table>/g, '<div class="rp-table"><table>')
    .replace(/<\/table>/g, '</table></div>')
    // le détail replié (repères posés par le collecteur, toujours par paire)
    .replace(/<p>@@detail(?::([^@<]{1,80}))?@@<\/p>([\s\S]*?)<p>@@\/detail@@<\/p>/g, (_m, label: string | undefined, inner: string) =>
      `<details class="rp-more"><summary>${label || 'Voir le détail : preuve, pour qui, risque'}</summary>${inner}</details>`)
    .replace(/<p>@@\/?detail(?::[^@<]{1,80})?@@<\/p>/g, '');
  return { html, toc };
}
