// Secours : le PDF net est imprimé par le collecteur (collector/reportPdf.ts, Chromium) ; ce module ne sert
// que si ce fichier manque ou ne se charge pas.
// Un rapport en PDF (A4, clair, quel que soit le thème) : le texte est mis en page hors de l'écran avec la feuille
// `.rp-pdf`, photographié par html2canvas-pro, puis découpé en pages entre deux blocs (jamais au milieu d'une ligne).
// Les deux bibliothèques ne se chargent qu'au premier clic.

const PAGE_W = 210; // mm
const PAGE_H = 297;
const MARGIN = 14;
/** largeur de mise en page en pixels CSS (≈ la largeur utile d'une page A4) */
const WIDTH = 720;
/** hauteur d'une photographie en pixels CSS (x2 : 16 000 px, sous la limite des canevas des navigateurs) */
const CHUNK = 8000;

/** Nom de fichier sûr : « Rapport - <titre>.pdf », sans caractères refusés par les systèmes de fichiers. */
export function pdfName(title: string) {
  const t = title.replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  return `${t || 'Rapport'}.pdf`;
}

/** Attend que les images du bloc soient chargées (ou en échec), 15 s au plus. */
function imagesReady(root: HTMLElement) {
  const imgs = [...root.querySelectorAll('img')];
  const each = imgs.map((img) => {
    img.loading = 'eager';
    return img.complete ? Promise.resolve() : new Promise<void>((ok) => { img.onload = img.onerror = () => ok(); });
  });
  return Promise.race([Promise.all(each), new Promise((ok) => setTimeout(ok, 15_000))]);
}

/**
 * Construit le PDF à partir de l'article affiché (`.rp-article`). Les boutons, le sommaire replié et les autres rapports
 * du sujet ne sont pas repris.
 */
export async function reportPdf(article: HTMLElement): Promise<Blob> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas-pro'), import('jspdf')]);

  const host = document.createElement('div');
  host.className = 'rp-pdf';
  host.style.width = `${WIDTH}px`;
  // l'article est photographié par tranches : le cadre (host) montre une tranche, l'intérieur glisse dessous
  const inner = document.createElement('div');
  inner.style.display = 'flow-root';
  const clone = article.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.rp-toc-mobile, .rp-others, button').forEach((el) => el.remove());
  inner.appendChild(clone);
  host.appendChild(inner);
  document.body.appendChild(host);

  try {
    await imagesReady(host);
    await document.fonts?.ready;

    // les coupures possibles : le bas de chaque bloc du texte (titres, paragraphes, images, tableaux, lignes de liste)
    const top = inner.getBoundingClientRect().top;
    const blocks = host.querySelectorAll<HTMLElement>(
      '.rp-article > :not(.rp-body), .rp-body > *, .rp-body li, .rp-body tr, .rp-body pre, .rp-body blockquote > *',
    );
    const cuts = [...new Set([...blocks].map((el) => Math.round(el.getBoundingClientRect().bottom - top)))].sort((a, b) => a - b);

    const usableW = PAGE_W - MARGIN * 2;
    const usableH = PAGE_H - MARGIN * 2;
    const pxPerMm = WIDTH / usableW;
    const pageH = Math.floor(usableH * pxPerMm); // hauteur d'une page en pixels CSS
    const total = Math.ceil(inner.getBoundingClientRect().height);

    // les pages [début, fin[ en pixels CSS
    const pages: [number, number][] = [];
    for (let y = 0; y < total - 2; ) {
      let end = Math.min(total, y + pageH);
      if (end < total) {
        // la dernière coupure qui tient dans la page (si elle laisse au moins un tiers de page, sinon coupe nette)
        const fit = cuts.filter((c) => c > y + pageH / 3 && c <= end).pop();
        if (fit) end = fit;
      }
      pages.push([y, end]);
      y = end;
    }

    // un seul canevas pour un long rapport (80 pages : ~130 000 px de haut) dépasse la limite du navigateur et
    // sort blanc : une photographie par groupe de pages, CHUNK pixels CSS au plus
    const scale = 2;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    host.style.overflow = 'hidden';
    let n = 0;
    for (let i = 0; i < pages.length; ) {
      const from = pages[i][0];
      let j = i + 1;
      while (j < pages.length && pages[j][1] - from <= CHUNK) j++;
      const to = pages[j - 1][1];
      host.style.height = `${to - from}px`;
      inner.style.marginTop = `${-from}px`;
      const canvas = await html2canvas(host, { scale, backgroundColor: '#ffffff', useCORS: true, logging: false, windowWidth: WIDTH });
      for (const [y, end] of pages.slice(i, j)) {
        const h = end - y;
        const slice = document.createElement('canvas');
        slice.width = canvas.width;
        slice.height = Math.round(h * scale);
        const ctx = slice.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, Math.round((y - from) * scale), canvas.width, slice.height, 0, 0, slice.width, slice.height);
        if (n > 0) pdf.addPage();
        pdf.addImage(slice.toDataURL('image/jpeg', 0.9), 'JPEG', MARGIN, MARGIN, usableW, h / pxPerMm, undefined, 'FAST');
        n++;
        pdf.setFontSize(8);
        pdf.setTextColor(150);
        pdf.text(String(n), PAGE_W / 2, PAGE_H - 6, { align: 'center' });
      }
      i = j;
    }
    return pdf.output('blob');
  } finally {
    host.remove();
  }
}

/** Fait télécharger le fichier. */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Ouvre le partage du système (Mail, WhatsApp, Messages…) avec le PDF joint. Renvoie `false` si le navigateur ne sait
 * pas partager un fichier, `'cancel'` si on a fermé la fenêtre de partage.
 */
export async function shareFile(blob: Blob, name: string, title: string): Promise<boolean | 'cancel'> {
  const file = new File([blob], name, { type: 'application/pdf' });
  const data: ShareData = { files: [file], title };
  if (typeof navigator.share !== 'function' || !navigator.canShare?.(data)) return false;
  try {
    await navigator.share(data);
    return true;
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return 'cancel';
    throw e;
  }
}
