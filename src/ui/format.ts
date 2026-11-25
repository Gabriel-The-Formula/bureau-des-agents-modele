// Petits formats d'affichage, en français.
export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};

export const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const fmtSize = (n: number) => (n < 1024 ? `${n} o` : n < 1024 * 1024 ? `${Math.round(n / 1024)} Ko` : `${(n / 1024 / 1024).toFixed(1)} Mo`);

export const fmtDate = (t: number) => new Date(t).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Un chemin affichable à l'écran : le dossier personnel devient « ~ » (pas de nom d'utilisateur dans une vidéo). */
export const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~');

/** Il y a combien de temps (« à l’instant », « il y a 2 min », « il y a 3 h »). */
export const ago = (t: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'à l’instant';
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
};

const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
/** Un nombre court : 950, 12 k, 1,2 M. */
export const fmtCompact = (n: number) => compact.format(Math.max(0, Math.round(n || 0))).replace(/\u202f|\u00a0/g, ' ');

/** Ce que veut dire le prix affiché : une info-bulle, la même partout. */
export const COST_HINT = 'Équivalent tarif API (tu es sur abonnement)';

const money = (n: number) => {
  if (n <= 0) return '0 $';
  if (n < 0.01) return '< 0,01 $';
  if (n >= 10) return `${Math.round(n).toLocaleString('fr-FR').replace(/ | /g, ' ')} $`;
  return `${n.toFixed(2).replace('.', ',')} $`;
};

/** Un prix en dollars, à la française : « 1,24 $ », « < 0,01 $ », « 12 $ », « ≥ 1,24 $ » (minimum), « prix inconnu ». */
export const fmtCost = (cost: number | null | undefined, partial = false) => {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return 'prix inconnu';
  return partial ? `≥ ${money(cost).replace(/^< /, '')}` : money(cost);
};

/** La somme de plusieurs prix : un minimum (« ≥ ») dès qu'un prix manque ou est partiel ; null si rien n'est connu. */
export function sumCosts(list: { cost?: number | null; costPartial?: boolean }[]): { cost: number | null; partial: boolean } {
  let total = 0;
  let known = 0;
  let partial = false;
  for (const x of list) {
    if (typeof x.cost === 'number' && Number.isFinite(x.cost)) { total += x.cost; known++; if (x.costPartial) partial = true; }
    else partial = true;
  }
  return known ? { cost: total, partial } : { cost: null, partial: false };
}

/** Une heure à la française : « 18 h 40 ». */
export const fmtHour = (t: number) => {
  const d = new Date(t);
  return `${d.getHours()} h ${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Minuit du jour de `t` (heure locale). */
export const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Le nom d'un jour : « Aujourd'hui », « Hier », « Mercredi 22 octobre ». `short` : « Mer. 22 ». */
export function dayLabel(t: number, now = Date.now(), short = false) {
  const diff = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (diff === 0) return 'Aujourd’hui';
  if (diff === 1) return 'Hier';
  const d = new Date(t);
  if (short) return cap(`${d.toLocaleDateString('fr-FR', { weekday: 'short' })} ${d.getDate()}`);
  return cap(d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }));
}

/** Une échéance de moins d'une semaine, en court : « aujourd'hui 22 h », « demain 12 h », « lun. 14 h 30 ». */
export function fmtSoon(t: number, now = Date.now()) {
  const d = new Date(t);
  const diff = Math.round((dayStart(t) - dayStart(now)) / 86_400_000);
  const day = diff === 0 ? 'aujourd’hui' : diff === 1 ? 'demain' : d.toLocaleDateString('fr-FR', { weekday: 'short' });
  return `${day} ${d.getHours()} h${d.getMinutes() ? ` ${String(d.getMinutes()).padStart(2, '0')}` : ''}`;
}

/** Un pourcentage entier : « 73 % ». */
export const fmtPct = (x: number) => `${Math.round(x * 100)} %`;

/** Un nombre de jetons court : « 950 », « 12 k », « 3,4 M », « 12,3 G ». */
export function fmtTokens(n: number) {
  const v = Math.max(0, n || 0);
  const one = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, '').replace('.', ','));
  if (v >= 1e9) return `${one(v / 1e9)} G`;
  if (v >= 1e6) return `${one(v / 1e6)} M`;
  if (v >= 1e3) return `${one(v / 1e3)} k`;
  return String(Math.round(v));
}

/** Un nombre de jetons en toutes lettres : « 12,7 milliards de jetons », « 3,4 millions de jetons ». */
export function fmtTokensWords(n: number) {
  const v = Math.max(0, n || 0);
  const one = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, '').replace('.', ','));
  if (v >= 1e9) return `${one(v / 1e9)} milliard${v >= 2e9 ? 's' : ''} de jetons`;
  if (v >= 1e6) return `${one(v / 1e6)} million${v >= 2e6 ? 's' : ''} de jetons`;
  return `${Math.round(v).toLocaleString('fr-FR')} jetons`;
}

/** La vignette d'une capture servie par le Worker (/media/<id>?w=s, l'original tant qu'elle n'est pas faite) ; les autres adresses telles quelles. */
export const thumbUrl = (url: string) => (/^\/media\/[0-9a-f]{32}\.(?:jpg|png|webp)$/.test(url) ? `${url}?w=s` : url);
