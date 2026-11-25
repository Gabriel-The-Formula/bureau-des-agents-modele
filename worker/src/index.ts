// Le Worker du Bureau des agents en ligne.
//   POST /api/ingest   le collecteur (jeton INGEST_TOKEN) pousse les résumés de sessions
//   GET  /ws           le navigateur connecté reçoit l'état en direct (WebSocket, via le Durable Object)
//   PUT/DELETE /api/reports/<nom>.json  le collecteur (même jeton) range les rapports longs dans le R2 privé
//   GET  /reports/<nom>.json  l'onglet « Rapports » lit la liste (index) et chaque rapport, une fois connecté
//   GET/POST /reports-archive.json  les rapports archivés (connecté ; POST {id, archived}) ;
//            /api/reports-archive.json  la même chose pour un agent (jeton du collecteur)
//   /login, /logout    la connexion par mot de passe (cookie HttpOnly signé)
//   le reste           les fichiers du bureau compilé (dist/), seulement une fois connecté
import { Hub } from './hub.ts';
import type { ReportArchive } from '../../shared/live.ts';
import { checkPassword, clearCookie, loginCookie, loginPage, sessionRole } from './auth.ts';

export { Hub };

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  ASSETS: Fetcher;
  MEDIA: R2Bucket;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  INGEST_TOKEN: string;
  ACCESS_PASSWORD: string;
  SESSION_SECRET: string;
  /** « 1 » seulement dans worker/.dev.vars du mode local (npm run local) : cookie sans Secure (http://127.0.0.1) et
   * connexion par lien /login?cle=<ACCESS_PASSWORD>, ouvert par npm run local. Jamais en ligne. */
  LOCAL_MODE?: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
};

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "media-src 'self' blob: data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
  "frame-ancestors 'none'", "form-action 'self'",
].join('; ');

function withHeaders(res: Response, html = false): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  if (html || (r.headers.get('content-type') ?? '').includes('text/html')) {
    r.headers.set('Content-Security-Policy', CSP);
    r.headers.set('Cache-Control', 'no-store');
  }
  return r;
}

function hub(env: Env) {
  return env.HUB.get(env.HUB.idFromName('bureau'));
}

const ARCHIVE_KEY = 'reports-archive.json';
const ARCHIVE_ID = /^[a-z0-9][a-z0-9-]{0,150}$/;
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', ...SECURITY_HEADERS };

async function readArchiveObj(env: Env): Promise<{ archive: ReportArchive; etag: string | null }> {
  const obj = await env.MEDIA.get(ARCHIVE_KEY);
  if (!obj) return { archive: { at: 0, items: {} }, etag: null };
  try {
    const a = (await obj.json()) as ReportArchive;
    return { archive: a && typeof a.items === 'object' && a.items ? a : { at: 0, items: {} }, etag: obj.etag };
  } catch { return { archive: { at: 0, items: {} }, etag: obj.etag }; }
}

async function readArchive(env: Env): Promise<ReportArchive> {
  return (await readArchiveObj(env)).archive;
}

/** GET : la liste ; POST {id, archived} ou {ids: [...], archived} : archive ou remet un ou plusieurs rapports. */
async function archiveRoute(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') return new Response(JSON.stringify(await readArchive(env)), { headers: jsonHeaders });
  if (request.method !== 'POST') return new Response('Méthode refusée', { status: 405 });
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return new Response('Type refusé', { status: 415 });
  const text = await request.text();
  if (text.length > 100_000) return new Response('Trop gros', { status: 413 });
  let body: { id?: unknown; ids?: unknown; archived?: unknown };
  try { body = JSON.parse(text); } catch { return new Response('JSON invalide', { status: 400 }); }
  const ids = Array.isArray(body.ids) ? body.ids : [body.id];
  if (!ids.length || ids.length > 500 || !ids.every((x) => typeof x === 'string' && ARCHIVE_ID.test(x)) || typeof body.archived !== 'boolean') {
    return new Response('Demande invalide', { status: 400 });
  }
  // lecture puis écriture conditionnelle (etag) : deux archivages simultanés (un agent et toi) ne s'écrasent pas,
  // le second relit et rejoue
  for (let attempt = 0; attempt < 5; attempt++) {
    const { archive, etag } = await readArchiveObj(env);
    const at = Date.now();
    for (const id of ids as string[]) archive.items[id] = { archived: body.archived, at };
    archive.at = at;
    const written = await env.MEDIA.put(ARCHIVE_KEY, JSON.stringify(archive), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      ...(etag ? { onlyIf: { etagMatches: etag } } : {}),
    });
    if (written) return new Response(JSON.stringify(archive), { headers: jsonHeaders });
  }
  return new Response('Archive occupée, réessayer', { status: 409 });
}

/** Comparaison à temps constant (le jeton du collecteur). */
function sameSecret(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (!ea.length || ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

/** Une redirection 303 qui pose plusieurs cookies. */
function redirectWith(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location, ...SECURITY_HEADERS });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers });
}

/** Une capture, une image ou un PDF du R2 (déjà autorisé par l'appelant). */
async function serveMedia(env: Env, url: URL, name: string, request: Request): Promise<Response> {
  // le résumé audio d'un rapport : mêmes droits que ses images, lu par morceaux ; le nom est l'empreinte du son
  if (name.endsWith('.mp3')) return serveRanged(request, env, name, 'audio/mpeg', 'private, max-age=31536000, immutable');
  // ?w=s : la vignette si le collecteur l'a faite, sinon l'original. Le nom est l'empreinte du contenu : jamais modifié.
  const small = url.searchParams.get('w') === 's' ? await env.MEDIA.get(`t/${name}`) : null;
  const obj = small ?? (await env.MEDIA.get(name));
  if (!obj) return new Response('Introuvable', { status: 404 });
  // vignette demandée mais pas encore faite : l'original, gardé une heure seulement (la vignette viendra)
  const cache = url.searchParams.get('w') === 's' && !small ? 'private, max-age=3600' : 'private, max-age=31536000, immutable';
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'image/jpeg', 'Cache-Control': cache,
      'Content-Security-Policy': "default-src 'none'; sandbox", ...SECURITY_HEADERS,
    },
  });
}

// Un fichier du R2 lu par morceaux (Range) : les vidéos des rapports et , leurs résumés audio. Le lecteur du
// navigateur demande des morceaux : Safari refuse un son ou une vidéo sans réponse 206.
async function serveRanged(request: Request, env: Env, key: string, type: string, cache: string): Promise<Response> {
  const headers = new Headers({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache, ...SECURITY_HEADERS });
  let obj: R2Object | R2ObjectBody | null;
  try {
    obj = await env.MEDIA.get(key, { range: request.headers });
  } catch (e) {
    // R2 en ligne lève une erreur (et non un objet) pour un morceau impossible : 416, jamais une erreur 500
    if (!request.headers.has('range')) throw e;
    const head = await env.MEDIA.head(key);
    if (!head) return new Response('Introuvable', { status: 404 });
    headers.set('Content-Range', `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (!obj) return new Response('Introuvable', { status: 404 });
  const range = obj.range as { offset?: number; length?: number } | undefined;
  if (!request.headers.has('range') || !range) {
    headers.set('Content-Length', String(obj.size));
    return new Response((obj as R2ObjectBody).body, { headers });
  }
  // un début demandé après la fin du fichier : 416, et non le fichier entier présenté comme un morceau
  const from = /^bytes=(\d+)-/.exec(request.headers.get('range') ?? '');
  if (from && Number(from[1]) >= obj.size) {
    await (obj as R2ObjectBody).body.cancel();
    headers.set('Content-Range', `bytes */${obj.size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range.offset ?? 0;
  const length = range.length ?? obj.size - start;
  headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${obj.size}`);
  headers.set('Content-Length', String(length));
  return new Response((obj as R2ObjectBody).body, { status: 206, headers });
}

// Les vidéos des rapports : R2 privé, servies seulement une fois connecté.
const serveVideo = (request: Request, env: Env, name: string) =>
  serveRanged(request, env, `v/${name}`, name.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4', 'private, max-age=86400');

/** Envoi d'une vidéo par morceaux de moins de 100 Mo (limite d'une requête Worker), avec le jeton du collecteur. */
async function uploadVideo(request: Request, env: Env, url: URL, name: string): Promise<Response> {
  const key = `v/${name}`;
  const type = name.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4';
  const id = url.searchParams.get('uploadId');
  if (request.method === 'POST' && !id) {
    const up = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: type } });
    return Response.json({ uploadId: up.uploadId });
  }
  if (request.method === 'PUT' && id) {
    const n = Number(url.searchParams.get('part'));
    if (!Number.isInteger(n) || n < 1) return new Response('Morceau invalide', { status: 400 });
    const part = await env.MEDIA.resumeMultipartUpload(key, id).uploadPart(n, await request.arrayBuffer());
    return Response.json(part);
  }
  if (request.method === 'POST' && id) {
    await env.MEDIA.resumeMultipartUpload(key, id).complete((await request.json()) as R2UploadedPart[]);
    return Response.json({ ok: true });
  }
  if (request.method === 'PUT') {
    await env.MEDIA.put(key, await request.arrayBuffer(), { httpMetadata: { contentType: type } });
    return Response.json({ ok: true });
  }
  return new Response('Méthode refusée', { status: 405 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/ingest') {
      if (request.method !== 'POST') return new Response('Méthode refusée', { status: 405 });
      const auth = request.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!env.INGEST_TOKEN || !sameSecret(token, env.INGEST_TOKEN)) return new Response('Jeton refusé', { status: 401 });
      if (Number(request.headers.get('content-length') ?? 0) > 4_000_000) return new Response('Trop gros', { status: 413 });
      return hub(env).fetch(new Request('https://hub/ingest', { method: 'POST', body: request.body, headers: { 'content-type': 'application/json' } }));
    }

    // une capture du fil des réalisations, envoyée par le collecteur (même jeton), rangée dans le R2 privé
    // la liste des captures sans vignette (rattrapage du collecteur, --thumbs)
    if (path === '/api/media') {
      const auth = request.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!env.INGEST_TOKEN || !sameSecret(token, env.INGEST_TOKEN)) return new Response('Jeton refusé', { status: 401 });
      const all: string[] = []; const thumbs = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await env.MEDIA.list({ cursor, limit: 1000 });
        for (const o of page.objects) { if (o.key.startsWith('v/')) continue; if (o.key.startsWith('t/')) thumbs.add(o.key.slice(2)); else all.push(o.key); }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return Response.json({ missing: all.filter((k) => !thumbs.has(k) && !/\.(pdf|mp3)$/.test(k)) });
    }
    const videoUp = /^\/api\/video\/([A-Za-z0-9]{10,32}\.(?:mp4|jpg))$/.exec(path);
    if (videoUp) {
      const auth = request.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!env.INGEST_TOKEN || !sameSecret(token, env.INGEST_TOKEN)) return new Response('Jeton refusé', { status: 401 });
      return uploadVideo(request, env, url, videoUp[1]);
    }
    // aussi le PDF d'un rapport (.pdf, imprimé par le collecteur)
    const up = /^\/api\/media\/([0-9a-f]{32}\.(?:jpg|png|webp|pdf|mp3))$/.exec(path);
    if (up) {
      const auth = request.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!env.INGEST_TOKEN || !sameSecret(token, env.INGEST_TOKEN)) return new Response('Jeton refusé', { status: 401 });
      // l'original, relu par le collecteur pour en tirer la vignette
      if (request.method === 'GET') {
        const obj = await env.MEDIA.get(up[1]);
        return obj ? new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType ?? 'image/jpeg' } }) : new Response('Introuvable', { status: 404 });
      }
      if (request.method !== 'PUT') return new Response('Méthode refusée', { status: 405 });
      // ?thumb=1 : la vignette (JPEG réduit) de la capture du même nom, servie par /media/<id>?w=s
      const thumb = url.searchParams.get('thumb') === '1';
      const type = request.headers.get('content-type') ?? '';
      const isPdf = up[1].endsWith('.pdf');
      // le résumé audio d'un rapport (.mp3, 12 Mo au plus : 6 minutes en font 3)
      const isMp3 = up[1].endsWith('.mp3');
      const wanted = isPdf ? 'application/pdf' : isMp3 ? 'audio/mpeg' : null;
      if (wanted ? thumb || type !== wanted : !/^image\/(jpeg|png|webp)$/.test(type)) return new Response('Type refusé', { status: 415 });
      const body = await request.arrayBuffer();
      if (body.byteLength > (isPdf ? 30_000_000 : isMp3 ? 12_000_000 : 3_000_000)) return new Response('Trop gros', { status: 413 });
      await env.MEDIA.put(thumb ? `t/${up[1]}` : up[1], body, { httpMetadata: { contentType: type } });
      return Response.json({ ok: true });
    }

    // les rapports archivés, pour un agent (jeton du collecteur)
    if (path === '/api/reports-archive.json') {
      const auth = request.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!env.INGEST_TOKEN || !sameSecret(token, env.INGEST_TOKEN)) return new Response('Jeton refusé', { status: 401 });
      return archiveRoute(request, env);
    }

    // les rapports longs (onglet « Rapports ») : la liste (index.json) et un fichier par rapport, envoyés par le collecteur
    const rep = /^\/api\/reports\/(index|[a-z0-9][a-z0-9-]{0,150})\.json$/.exec(path);
    if (rep) {
      if (request.method !== 'PUT' && request.method !== 'DELETE') return new Response('Méthode refusée', { status: 405 });
      const auth = request.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!env.INGEST_TOKEN || !sameSecret(token, env.INGEST_TOKEN)) return new Response('Jeton refusé', { status: 401 });
      const key = `reports/${rep[1]}.json`;
      if (request.method === 'DELETE') { await env.MEDIA.delete(key); return Response.json({ ok: true }); }
      if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return new Response('Type refusé', { status: 415 });
      const body = await request.text();
      if (body.length > 2_000_000) return new Response('Trop gros', { status: 413 });
      try { JSON.parse(body); } catch { return new Response('JSON invalide', { status: 400 }); }
      await env.MEDIA.put(key, body, { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
      return Response.json({ ok: true });
    }

    if (path === '/login') {
      // mode local : npm run local ouvre /login?cle=<mot de passe local>, on connecte puis on retire la clé de l'adresse
      const cle = env.LOCAL_MODE === '1' && request.method === 'GET' ? url.searchParams.get('cle') : null;
      const cleRole = cle ? await checkPassword(cle, env) : null;
      if (cleRole) return redirectWith('/', await loginCookie(env, cleRole));
      if (request.method === 'POST') {
        const form = await request.formData().catch(() => null);
        const pwd = String(form?.get('password') ?? '');
        const role = await checkPassword(pwd, env);
        if (role) return redirectWith('/', await loginCookie(env, role));
        // un peu d'attente : décourage les essais à la chaîne
        await new Promise((r) => setTimeout(r, 1200));
        return withHeaders(loginPage('Mot de passe incorrect.', 401), true);
      }
      if (await sessionRole(request, env)) return Response.redirect(new URL('/', url).toString(), 303);
      return withHeaders(loginPage(), true);
    }

    if (path === '/logout') {
      // la déconnexion efface aussi l'étage gardé dans le navigateur (affiché au rechargement, avant la connexion en direct)
      const res = redirectWith('/login', clearCookie(env));
      res.headers.set('Clear-Site-Data', '"storage"');
      return res;
    }

    const logged = (await sessionRole(request, env)) === 'owner';

    if (path === '/ws') {
      if (!logged) return new Response('Connexion requise', { status: 401 });
      if (request.headers.get('upgrade') !== 'websocket') return new Response('WebSocket attendue', { status: 426 });
      // même origine seulement : un autre site ne peut pas ouvrir la connexion avec ton cookie
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return new Response('Origine refusée', { status: 403 });
      return hub(env).fetch(new Request('https://hub/ws', request));
    }

    if (path === '/favicon.svg') return withHeaders(await env.ASSETS.fetch(request));

    // les captures : seulement une fois connecté, jamais mises en cache par un intermédiaire
    const media = /^\/media\/([0-9a-f]{32}\.(?:jpg|png|webp|pdf|mp3))$/.exec(path);
    if (media) {
      if (!logged) return new Response('Connexion requise', { status: 401 });
      return serveMedia(env, url, media[1], request);
    }
    const video = /^\/video\/([A-Za-z0-9]{10,32}\.(?:mp4|jpg))$/.exec(path);
    if (video) {
      if (!logged) return new Response('Connexion requise', { status: 401 });
      return serveVideo(request, env, video[1]);
    }
    if (path === '/reports-archive.json') {
      if (!logged) return new Response('Connexion requise', { status: 401 });
      // un autre site ne peut pas archiver avec ton cookie
      const origin = request.headers.get('origin');
      if (request.method !== 'GET' && origin !== url.origin) return new Response('Origine refusée', { status: 403 });
      return archiveRoute(request, env);
    }
    const report = /^\/reports\/(index|[a-z0-9][a-z0-9-]{0,150})\.json$/.exec(path);
    if (report) {
      if (!logged) return new Response('Connexion requise', { status: 401 });
      const obj = await env.MEDIA.get(`reports/${report[1]}.json`, { onlyIf: request.headers });
      if (!obj) return new Response('Introuvable', { status: 404 });
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', ETag: obj.httpEtag, ...SECURITY_HEADERS };
      // le navigateur a déjà cette version : rien à renvoyer
      if (!('body' in obj)) return new Response(null, { status: 304, headers });
      return new Response(obj.body, { headers });
    }
    if (!logged) {
      if (path.startsWith('/assets/') || path.startsWith('/api/')) return new Response('Connexion requise', { status: 401 });
      return Response.redirect(new URL('/login', url).toString(), 303);
    }
    return withHeaders(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
