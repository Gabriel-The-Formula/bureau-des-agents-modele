// Le chien de garde de la boucle du collecteur. Un fil à part (worker_threads) lit, dans une mémoire partagée, le
// dernier battement de la boucle principale et l'étape en cours (stage) : si la boucle ne bat plus depuis 5 s, il l'écrit
// lui-même au journal PENDANT le blocage (la boucle figée ne peut rien écrire), puis la durée totale quand elle repart.
// C'est ce qui a prouvé le blocage des clics du 4/11 (4 min 38 entre un « Revenir en arrière » et sa tâche).
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';

const STAGE_BYTES = 120;
// [0] dernier battement (ms, Float64) ; puis la longueur de l'étape (Int32) et son texte (UTF-8)
const sab = new SharedArrayBuffer(8 + 4 + STAGE_BYTES);
const beatAt = new Float64Array(sab, 0, 1);
const stageLen = new Int32Array(sab, 8, 1);
const stageBuf = new Uint8Array(sab, 12, STAGE_BYTES);
const enc = new TextEncoder();
let current = '';

/** L'étape en cours de la boucle principale (relue par le chien de garde si elle se fige). */
export function stage(name: string) {
  if (name === current) return;
  current = name;
  const b = enc.encode(name).slice(0, STAGE_BYTES);
  stageBuf.fill(0);
  stageBuf.set(b);
  Atomics.store(stageLen, 0, b.length);
}

/** Démarre le chien de garde (une fois) ; logFile = le journal du collecteur (écrit directement, sans la boucle principale). */
export function startWatchdog(logFile: string | undefined) {
  if (!logFile || process.env.BUREAU_WATCHDOG === '0') return;
  beatAt[0] = Date.now();
  setInterval(() => { beatAt[0] = Date.now(); }, 500).unref();
  const code = `
    const { workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const { sab, logFile } = workerData;
    const beatAt = new Float64Array(sab, 0, 1), stageLen = new Int32Array(sab, 8, 1), stageBuf = new Uint8Array(sab, 12, ${STAGE_BYTES});
    const dec = new TextDecoder();
    const hm = () => new Date().toTimeString().slice(0, 8);
    const write = (s) => { try { fs.appendFileSync(logFile, '[bureau ' + hm() + '] ' + s + '\\n'); } catch {} };
    let since = 0, stageAt = '', told = 0;
    setInterval(() => {
      const late = Date.now() - beatAt[0];
      const st = dec.decode(stageBuf.slice(0, Atomics.load(stageLen, 0))) || 'inconnue';
      if (late > 5000) {
        if (!since) { since = beatAt[0]; stageAt = st; told = 0; }
        // pendant le blocage : une ligne à 5 s, puis toutes les 30 s
        if (late - told >= (told ? 30000 : 5000)) { told = late; write('boucle figée depuis ' + Math.round(late / 1000) + ' s, étape « ' + stageAt + ' »'); }
      } else if (since) {
        write('boucle repartie après ' + Math.round((beatAt[0] - since) / 1000) + ' s figée, étape « ' + stageAt + ' »');
        since = 0;
      }
    }, 1000);
  `;
  try {
    const w = new Worker(code, { eval: true, workerData: { sab, logFile } });
    w.unref();
    w.on('error', () => undefined);
  } catch { /* sans chien de garde */ }
}

/** Le journal du collecteur (celui de launchd, sinon BUREAU_LOG). */
export function collectorLog(): string | undefined {
  const f = process.env.BUREAU_LOG || `${process.env.HOME}/Library/Logs/bureau-collector/collector.log`;
  try { fs.accessSync(f, fs.constants.W_OK); return f; } catch { return undefined; }
}

let lastBreath = Date.now();
/** Rend la main à la boucle si le travail en cours dure depuis plus de 50 ms (à appeler dans les longues boucles). */
export async function breathe() {
  if (Date.now() - lastBreath < 50) return;
  await new Promise((r) => setImmediate(r));
  lastBreath = Date.now();
}
