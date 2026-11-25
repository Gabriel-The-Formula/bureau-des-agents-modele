// La connexion au bureau en ligne : un mot de passe (secret ACCESS_PASSWORD), puis un cookie HttpOnly
// signé (HMAC-SHA256 avec SESSION_SECRET) valable 30 jours. Le navigateur ne voit jamais le secret.
import type { Env } from './index.ts';

const COOKIE = 'bureau_session';
const MAX_AGE_S = 30 * 24 * 3600;

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export type Role = 'owner';

/** Le rôle ouvert par ce mot de passe, sinon null. */
export async function checkPassword(pwd: string, env: Env): Promise<Role | null> {
  if (!env.SESSION_SECRET || !pwd) return null;
  // on compare des empreintes : même longueur, temps constant
  const given = await hmac(env.SESSION_SECRET, 'pwd:' + pwd);
  const owner = !!env.ACCESS_PASSWORD && timingSafeEqual(given, await hmac(env.SESSION_SECRET, 'pwd:' + env.ACCESS_PASSWORD));
  return owner ? 'owner' : null;
}

export async function loginCookie(env: Env, _role: Role = 'owner'): Promise<string[]> {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  const value = `${exp}.${await hmac(env.SESSION_SECRET, 'session:' + exp)}`;
  return [`${COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly;${secure(env)} SameSite=Lax`];
}

export function clearCookie(env: Env): string[] {
  return [`${COOKIE}=; Path=/; Max-Age=0; HttpOnly;${secure(env)} SameSite=Lax`];
}

/** Secure partout, sauf en mode local (npm run local, http://127.0.0.1) où certains navigateurs le refusent. */
function secure(env: Env): string {
  return env.LOCAL_MODE === '1' ? '' : ' Secure;';
}

/** Le rôle de la session (cookie signé), sinon null. */
export async function sessionRole(request: Request, env: Env): Promise<Role | null> {
  if (!env.SESSION_SECRET) return null;
  const raw = (request.headers.get('cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return null;
  return timingSafeEqual(sig, await hmac(env.SESSION_SECRET, 'session:' + exp)) ? 'owner' : null;
}

export function loginPage(error = '', status = 200): Response {
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Le Bureau des agents</title><link rel="icon" href="/favicon.svg">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: #1b1530; color: #f4ecd8;
    font: 16px/1.4 ui-monospace, "SF Mono", Menlo, monospace; image-rendering: pixelated; }
  form { width: min(360px, calc(100vw - 32px)); background: #2a2148; border: 4px solid #0e0a1c; box-shadow: 6px 6px 0 #0e0a1c;
    padding: 24px; display: grid; gap: 14px; animation: in .22s ease-out; }
  h1 { margin: 0; font-size: 20px; letter-spacing: .5px; color: #ffc93d; }
  p { margin: 0; color: #c9bfe0; font-size: 14px; }
  input { font: inherit; padding: 10px 12px; background: #120d24; color: #f4ecd8; border: 3px solid #0e0a1c; outline: none;
    transition: border-color .15s; }
  input:focus { border-color: #ffc93d; }
  button { font: inherit; font-weight: 700; padding: 10px; background: #ff8a3d; color: #1b1530; border: 3px solid #0e0a1c;
    box-shadow: 3px 3px 0 #0e0a1c; cursor: pointer; transition: background .15s, transform .1s; }
  button:hover { background: #ffc93d; }
  button:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 #0e0a1c; }
  .err { color: #ff6f8a; }
  @keyframes in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { form { animation: none; } }
</style></head>
<body><form method="post" action="/login">
  <h1>Le Bureau des agents</h1>
  <p>Entre ton mot de passe pour ouvrir le bureau.</p>
  ${error ? `<p class="err">${error}</p>` : ''}
  <input type="password" name="password" autocomplete="current-password" placeholder="Mot de passe" autofocus required>
  <button type="submit">Entrer</button>
</form></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
