// Vignettes des captures : un JPEG de 1000 px au plus (environ 10 fois plus léger que l'original), envoyé à côté de
// l'original (PUT /api/media/<id>?thumb=1) et servi par /media/<id>?w=s dans les cartes du fil et des rapports. L'original
// reste celui de la visionneuse et du corps des rapports.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { WORK_DIR } from './summarize.ts';

const run = promisify(execFile);
/** au-dessous, l'original sert déjà de vignette */
const SMALL_BYTES = 120_000;

/** La vignette d'une image, ou null si l'original est déjà léger (ou si sips échoue). */
export async function makeThumb(body: Buffer, ext: string): Promise<Buffer | null> {
  if (body.length <= SMALL_BYTES) return null;
  await fs.mkdir(WORK_DIR, { recursive: true, mode: 0o700 });
  const src = path.join(WORK_DIR, `thumb-in-${process.pid}-${Date.now()}.${ext}`);
  const out = path.join(WORK_DIR, `thumb-out-${process.pid}-${Date.now()}.jpg`);
  try {
    await fs.writeFile(src, body, { mode: 0o600 });
    await run('/usr/bin/sips', ['-Z', '1000', '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', src, '--out', out], { timeout: 30_000 });
    const small = await fs.readFile(out);
    return small.length < body.length * 0.8 ? small : null;
  } catch {
    return null;
  } finally {
    await fs.rm(src, { force: true });
    await fs.rm(out, { force: true });
  }
}

type Put = (body: Buffer, type: string, id: string, thumb: boolean) => Promise<boolean>;

/** Envoie la vignette d'une capture qu'on vient d'envoyer (sans effet si elle est déjà légère). */
export async function sendThumb(body: Buffer, id: string, put: Put): Promise<void> {
  const small = await makeThumb(body, id.split('.').pop() ?? 'png');
  if (small) await put(small, 'image/jpeg', id, true);
}

/** Rattrapage : une vignette pour chaque capture déjà en ligne qui n'en a pas. */
export async function backfillThumbs(base: string, token: string, put: Put, log: (m: string) => void): Promise<number> {
  const auth = { authorization: `Bearer ${token}` };
  const res = await fetch(`${base}/api/media`, { headers: auth, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`liste des captures : HTTP ${res.status}`);
  const { missing } = (await res.json()) as { missing: string[] };
  log(`vignettes : ${missing.length} captures sans vignette`);
  let made = 0;
  for (const [i, id] of missing.entries()) {
    try {
      const r = await fetch(`${base}/api/media/${id}`, { headers: auth, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) continue;
      const body = Buffer.from(await r.arrayBuffer());
      const small = await makeThumb(body, id.split('.').pop() ?? 'png');
      if (small && (await put(small, 'image/jpeg', id, true))) made++;
    } catch { /* la suivante */ }
    if ((i + 1) % 50 === 0) log(`vignettes : ${i + 1}/${missing.length}, ${made} faites`);
  }
  return made;
}
