// Le PDF d'un rapport, fait par le collecteur avec Chromium (impression) : texte vectoriel et sélectionnable
// (police embarquée), images à leur définition, coupures de page entre les blocs. Le bouton PDF du Bureau télécharge ce
// fichier ; la photographie de la page (src/ui/reportPdf.ts, html2canvas) ne sert plus que de secours.
// Même mise en forme que la page de lecture : le HTML vient de reportToHtml (src/ui/md.ts), la feuille de reports.css,
// en clair (.rp-pdf). Une image plus haute qu'une page est coupée en tranches de la largeur du texte (jamais réduite).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Report } from '../shared/live.ts';
import { reportToHtml } from '../src/ui/md.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** largeur du texte : A4 moins deux marges de 14 mm */
const TEXT_MM = 182;
/** au-delà de cette hauteur (mm), une image est coupée en tranches */
const SLICE_MM = 235;

export interface PdfImage { src: string; width: number; height: number }

type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
type Page = {
  goto(url: string, o: object): Promise<unknown>;
  evaluate(expr: string): Promise<unknown>;
  pdf(o: object): Promise<Buffer>;
  close(): Promise<void>;
};

let browser: Promise<Browser> | null = null;
let seq = 0;

/** Chromium (playwright-core), lancé au premier PDF puis gardé jusqu'à closePdfBrowser(). */
async function getBrowser(): Promise<Browser> {
  browser ??= import('playwright-core').then(({ chromium }) => chromium.launch({ headless: true, args: ['--allow-file-access-from-files'] }) as Promise<Browser>);
  try { return await browser; } catch (e) { browser = null; throw e; }
}

export async function closePdfBrowser() {
  const b = browser;
  browser = null;
  // jamais bloquant : la publication des rapports attend cette fermeture (une publication figée les gèle tous)
  if (b) await Promise.race([b.then((x) => x.close()).catch(() => undefined), new Promise((ok) => { setTimeout(ok, 10_000).unref(); })]);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const plain = (s: string) => s.replace(/[*_`#>[\]()!]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const dateLabel = (d: string) => { const [y, m, j] = d.split('-').map(Number); return m ? `${j} ${MONTHS[m - 1]} ${y}` : d; };

/**
 * Une figure : l'image entière, ou, si elle dépasse une page, une figure à découper (SLICE_SCRIPT) en tranches de la
 * largeur du texte (jamais réduite).
 */
function figure(img: PdfImage | undefined, alt: string, src: string): string {
  const cap = alt ? `<figcaption>${alt}</figcaption>` : '';
  if (!img) return alt ? `<p><em>${alt}</em></p>` : '';
  if ((TEXT_MM * img.height) / img.width <= SLICE_MM) return `<figure><img src="${esc(src)}" alt="${alt}">${cap}</figure>`;
  return `<figure class="pdf-tall" data-src="${esc(src)}" data-w="${img.width}" data-h="${img.height}">${cap}</figure>`;
}

/**
 * Exécuté dans la page avant l'impression : coupe chaque image haute dans une bande vide (une rangée de pixels d'une
 * seule couleur) au milieu de la plus large bande vide (6 rangées au moins) des 40 % du bas de la page, jamais dans un texte ;
 * sans bande vide dans les 40 % du bas de la page, coupe nette à la hauteur de la page.
 */
const SLICE_SCRIPT = `(async () => {
  const TEXT_MM = ${TEXT_MM}, SLICE_MM = ${SLICE_MM};
  const load = (src) => new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error('image illisible')); i.src = src; });
  let failed = 0;
  for (const fig of document.querySelectorAll('figure.pdf-tall')) {
    const W = +fig.dataset.w, H = +fig.dataset.h, src = fig.dataset.src, k = TEXT_MM / W;
    let img;
    try { img = await load(src); } catch { failed++; continue; }
    const maxPx = Math.floor(SLICE_MM / k);
    // une seule bande (les 40 % du bas de la page) dessinée à la fois, en largeur réduite : peu de mémoire
    const sw = Math.min(W, 720), sx = W / sw, band = Math.ceil(maxPx * 0.4);
    const c = document.createElement('canvas'); c.width = sw; c.height = band;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const blank = (row, d) => { const o = row * sw * 4; for (let x = 4; x < sw * 4; x += 8) { if (Math.abs(d[o + x] - d[o]) + Math.abs(d[o + x + 1] - d[o + 1]) + Math.abs(d[o + x + 2] - d[o + 2]) > 18) return false; } return true; };
    const cuts = [0]; let y = 0;
    while (H - y > maxPx) {
      const hi = y + maxPx, lo = hi - band;
      let cut = hi;
      try {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sw, band);
        ctx.drawImage(img, 0, lo, W, band, 0, 0, sw, band);
        const d = ctx.getImageData(0, 0, sw, band).data;
        // la plus large bande vide (entre deux groupes plutôt qu'entre une étiquette et sa barre), la plus basse à égalité
        let run = 0, best = 0;
        for (let r = band - 1; r >= -1; r--) {
          if (r >= 0 && blank(r, d)) { run++; continue; }
          if (run >= 6 && run > best) { best = run; cut = lo + r + 1 + Math.floor(run / 2); }
          run = 0;
        }
      } catch { /* coupe nette */ }
      cuts.push(cut); y = cut;
    }
    cuts.push(H);
    c.width = c.height = 0;
    const parts = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const s = document.createElement('div'); s.className = 'pdf-slice'; s.style.height = ((cuts[i + 1] - cuts[i]) * k).toFixed(2) + 'mm';
      const im = document.createElement('img'); im.src = src; im.alt = ''; im.style.marginTop = '-' + (cuts[i] * k).toFixed(2) + 'mm';
      s.appendChild(im); parts.push(s);
    }
    fig.prepend(...parts);
  }
  // toutes les images de la page chargées avant l'impression ; une image manquante fait échouer le PDF (jamais incomplet)
  const imgs = [...document.images];
  await Promise.all(imgs.map((i) => i.complete ? 0 : new Promise((ok) => { i.onload = i.onerror = ok; })));
  return failed + imgs.filter((i) => !i.naturalWidth).length;
})()`;

/** Le document HTML imprimé : en-tête du rapport (comme la page de lecture), puis le texte. */
export function reportPdfHtml(r: Report, images: Map<string, PdfImage>): string {
  // le PDF garde tout : les détails repliés y sont ouverts
  const html = reportToHtml(r.body).html.replace(/<details class="rp-more">/g, '<details class="rp-more" open>');
  const body = html
    .replace(/<figure><img src="([^"]+)" alt="([^"]*)"[^>]*>(?:<figcaption>[\s\S]*?<\/figcaption>)?<\/figure>/g,
      (_m, src: string, alt: string) => { const img = images.get(src); return figure(img, alt, img?.src ?? ''); });
  const ledeInBody = !!r.summary && plain(r.body.slice(0, 2000)).includes(plain(r.summary).replace(/ \(…\)$/, '').slice(0, 80));
  const cover = r.cover && !r.body.includes(r.cover) ? images.get(r.cover) : undefined;
  const minutes = Math.max(1, Math.round(r.words / 220));
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/reports.css'), 'utf8');
  const font = pathToFileURL(path.join(ROOT, 'node_modules/@fontsource-variable/plus-jakarta-sans/files')).href;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>
@font-face { font-family: 'Plus Jakarta Sans Variable'; font-style: normal; font-weight: 200 800; src: url('${font}/plus-jakarta-sans-latin-wght-normal.woff2') format('woff2-variations'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: 'Plus Jakarta Sans Variable'; font-style: normal; font-weight: 200 800; src: url('${font}/plus-jakarta-sans-latin-ext-wght-normal.woff2') format('woff2-variations'); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
@font-face { font-family: 'Plus Jakarta Sans Variable'; font-style: italic; font-weight: 200 800; src: url('${font}/plus-jakarta-sans-latin-wght-italic.woff2') format('woff2-variations'); }
:root { --font: 'Plus Jakarta Sans Variable', system-ui, sans-serif; --pixel: var(--font); --on-accent: #ffffff; --px-shadow: transparent; --px-inner: transparent; --green: #2f7d4a; --red: #b3412e; }
${css}
@page { size: A4; margin: 14mm 14mm 16mm; }
html, body { margin: 0; background: #ffffff; }
.rp-pdf { position: static; left: auto; width: ${TEXT_MM}mm; }
.rp-pdf .rp-body figure, .rp-pdf .rp-hero { break-inside: avoid; }
.rp-pdf .rp-body figure img, .rp-pdf .rp-hero img { display: block; width: 100%; height: auto; max-height: ${SLICE_MM}mm; object-fit: contain; }
.rp-pdf .rp-body figure.pdf-tall { break-inside: auto; }
.rp-pdf .pdf-slice { overflow: hidden; break-inside: avoid; }
.rp-pdf .pdf-slice img { max-height: none !important; border: 0 !important; }
.rp-pdf .pdf-slice + .pdf-slice { break-before: page; }
.rp-pdf .rp-body h2, .rp-pdf .rp-body h3, .rp-pdf .rp-body h4 { break-after: avoid; }
.rp-pdf .rp-body tr, .rp-pdf .rp-body blockquote, .rp-pdf .rp-body pre { break-inside: avoid; }
.rp-pdf .rp-body pre { white-space: pre-wrap; }
.rp-pdf .rp-body a { color: var(--orange2); }
</style></head><body><div class="rp-pdf"><article class="rp-article">
<p class="rp-kicker">${esc(r.subject)} · ${esc(dateLabel(r.date))} · ${minutes} min de lecture</p>
<h1>${esc(r.title)}</h1>
${r.summary && !ledeInBody ? `<p class="rp-lede">${esc(r.summary)}</p>` : ''}
${cover ? `<figure class="rp-hero"><img src="${esc(cover.src)}" alt=""></figure>` : ''}
<div class="rp-body">${body}</div>
</article></div></body></html>`;
}

/**
 * Imprime le rapport en PDF. `images` : adresse /media/<id> du texte -> l'image (adresse file:) et sa taille en pixels.
 * Lève une erreur si Chromium manque ou échoue (le Bureau garde alors la photographie de la page).
 */
export async function renderReportPdf(r: Report, images: Map<string, PdfImage>, workDir: string): Promise<Buffer> {
  await fsp.mkdir(workDir, { recursive: true, mode: 0o700 });
  const file = path.join(workDir, `report-pdf-${process.pid}-${++seq}.html`);
  await fsp.writeFile(file, reportPdfHtml(r, images), { mode: 0o600 });
  let page: Page | null = null;
  try {
    page = await (await getBrowser()).newPage();
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 60_000 });
    await page.evaluate('document.fonts.ready.then(() => 1)');
    const missing = Number(await Promise.race([page.evaluate(SLICE_SCRIPT), new Promise((_ok, ko) => { setTimeout(() => ko(new Error('découpe des images : plus de 60 s')), 60_000).unref(); })]));
    if (missing) throw new Error(`${missing} image(s) non chargée(s)`);
    return await page.pdf({
      format: 'A4', printBackground: true, preferCSSPageSize: true, timeout: 90_000,
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;text-align:center;font:8px system-ui,sans-serif;color:#969696"><span class="pageNumber"></span></div>',
    });
  } finally {
    await page?.close().catch(() => undefined);
    await fsp.rm(file, { force: true });
  }
}
