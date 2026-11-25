// Le résumé audio d'un rapport (bouton « Écouter » de la page de lecture), fait par le collecteur une fois par
// version du texte :
//  1. le texte à dire : écrit par Claude (la CLI `claude` connectée à ton abonnement, comme les résumés de summarize.ts ;
//     aucun crédit d'API), chiffres et décisions d'abord, chaque graphique décrit en une phrase ;
//  2. la voix : « Thomas », la voix française du Mac (commande say, gratuite, rien à installer). BUREAU_TTS=edge prend une
//     voix neuronale de Microsoft (outil edge-tts, le texte part chez Microsoft) ; BUREAU_TTS=piper un moteur local ;
//  3. un MP3 mono 64 kb/s (ffmpeg), rangé dans le R2 comme le PDF.
// Chaque fabrication ajoute une ligne à audio-couts.jsonl (durées de calcul, tailles) : le coût mesuré par rapport.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Report } from '../shared/live.ts';
import { findClaude, haikuEnv, WORK_DIR } from './summarize.ts';

const DIR = path.join(os.homedir(), '.config', 'bureau-collector');
/** le moteur de voix : « say » (voix du Mac), « piper » (installé dans ~/.config/bureau-collector/tts) ou
 * « edge » : les voix neuronales de Microsoft (outil edge-tts, sans compte ni frais, le texte part chez Microsoft ;
 * en panne, la voix du Mac prend le relais) */
const ENGINE: 'say' | 'piper' | 'edge' = process.env.BUREAU_TTS === 'piper' ? 'piper' : process.env.BUREAU_TTS === 'edge' ? 'edge' : 'say';
const SAY_BIN = '/usr/bin/say';
const SAY_VOICE = process.env.BUREAU_SAY_VOICE || 'Thomas';
const TTS_DIR = process.env.BUREAU_TTS_DIR || path.join(DIR, 'tts');
const PIPER = process.env.BUREAU_PIPER_BIN || path.join(TTS_DIR, 'venv', 'bin', 'piper');
const VOICE = process.env.BUREAU_PIPER_VOICE || path.join(TTS_DIR, 'voix', 'fr_FR-tom-medium.onnx');
const EDGE_BIN = process.env.BUREAU_EDGE_BIN || path.join(TTS_DIR, 'venv', 'bin', 'edge-tts');
/** la voix neuronale par défaut (BUREAU_EDGE_VOICE pour une autre) */
const EDGE_VOICE = process.env.BUREAU_EDGE_VOICE || 'fr-FR-RemyMultilingualNeural';
const VOICE_NAME = ENGINE === 'say' ? `say-${SAY_VOICE}` : ENGINE === 'edge' ? `edge-${EDGE_VOICE}` : path.basename(VOICE, '.onnx');
const COSTS_FILE = path.join(DIR, 'audio-couts.jsonl');
export const AUDIO_MODEL = process.env.BUREAU_AUDIO_MODEL || 'claude-sonnet-5-5';
/** débit mesuré sur un vrai résumé, pauses comprises (Thomas : 742 mots en 264 s ; Piper : 270 mots en 107 s), pour viser 3 à 6 minutes */
const WORDS_PER_MIN = ENGINE === 'say' ? 168 : ENGINE === 'edge' ? 180 : 150;
/** en dessous (quelques lignes), il n'y a rien à résumer : pas de résumé audio */
export const AUDIO_MIN_WORDS = 100;
/** 6 minutes au plus : un texte plus long est refusé */
const MAX_SCRIPT_WORDS = 6 * WORDS_PER_MIN;
/** un rapport plus long que cela (environ 35 000 mots) est envoyé sans son milieu : le début et la fin portent le verdict et les décisions */
const MAX_SOURCE = 240_000;

const MP3_KBPS = 64;
/** le débit demandé à la voix du Mac, en mots par minute (un peu plus posé que son réglage d'origine, 175) */
const SAY_RATE = 165;
/** en dessous (2,5 s), le fichier n'est pas un résumé */
export const MP3_MIN_BYTES = 20_000;
/** la durée d'un MP3 du collecteur : débit constant, elle se lit sur sa taille */
export const mp3Seconds = (mp3: Buffer) => Math.round(mp3.length / (MP3_KBPS * 125));
let seq = 0;
let ffmpegBin: string | undefined;
function findFfmpeg(): string | null {
  // trouvé : retenu ; absent : recherché de nouveau au passage suivant (ffmpeg installé après le démarrage du collecteur)
  ffmpegBin ??= [process.env.BUREAU_FFMPEG, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((c) => !!c && fs.existsSync(c));
  return ffmpegBin ?? null;
}

/** La voix est-elle disponible sur ce Mac (le moteur, ffmpeg, la CLI claude) ? Relu à chaque passage. */
export function audioReady(): boolean {
  return (ENGINE === 'piper' ? fs.existsSync(PIPER) && fs.existsSync(VOICE) : fs.existsSync(ENGINE === 'edge' ? EDGE_BIN : SAY_BIN)) && !!findFfmpeg() && !!findClaude();
}

const runBin = (bin: string, args: string[], opts: { timeout: number; input?: string; env?: NodeJS.ProcessEnv; cwd?: string }) =>
  new Promise<string>((ok, ko) => {
    const child = execFile(bin, args, { timeout: opts.timeout, maxBuffer: 4 << 20, env: opts.env, cwd: opts.cwd }, (err, stdout, stderr) => {
      if (err) ko(new Error(`${path.basename(bin)} : ${String(stderr || err.message).trim().split('\n').pop()?.slice(0, 200)}`));
      else ok(String(stdout ?? ''));
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input ?? '');
  });

/** Le rapport tel que Claude le reçoit : une image devient « [Graphique : sa légende] ». */
export function audioSource(r: Report): string {
  const body = r.body
    .replace(/<!--[^]*?-->/g, '')
    .replace(/@@\/?detail(?::[^@\n]{1,80})?@@/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt.trim() ? `[Graphique : ${alt.trim()}]` : '[Graphique]'))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const all = `Titre : ${r.title}\nSujet : ${r.subject}\nDate : ${r.date}\nRésumé : ${r.summary}\n\n${body}`;
  if (all.length <= MAX_SOURCE) return all;
  return `${all.slice(0, MAX_SOURCE * 0.75)}\n\n[… milieu du rapport non transmis …]\n\n${all.slice(-MAX_SOURCE * 0.25)}`;
}

const system = (words: number) => {
  // 3 à 6 minutes d'écoute ; un rapport court donne un résumé plus court (jamais plus long que le rapport)
  const max = Math.min(Math.round(5.5 * WORDS_PER_MIN), Math.max(Math.min(220, words), Math.round(words * 0.6)));
  const min = Math.min(3 * WORDS_PER_MIN, Math.round(max * 0.75));
  return 'Tu écris le texte qu’une voix de synthèse va lire à voix haute pour résumer un rapport. La personne écoute sans voir le rapport. '
    + `Écris en français, entre ${min} et ${max} mots. `
    + 'Ordre imposé : une phrase qui dit le sujet et le verdict ; puis les chiffres clés ; puis les décisions (prises, ou attendues et de qui) ; '
    + 'puis le reste par ordre d’importance. Chaque graphique important est décrit en une seule phrase (« Le graphique montre… »), par ce qu’il apprend, jamais par ses couleurs ni sa forme. '
    + 'Les chiffres sont ceux du rapport, exacts, jamais inventés ni recalculés. '
    + 'C’est un texte pour l’oreille : phrases courtes (20 mots au plus), aucun titre, aucune liste, aucune mise en forme, aucun symbole '
    + '(écris « pour cent », « euros », « dollars », « plus », « moins »), aucune abréviation, aucun sigle non expliqué, aucune parenthèse. '
    + 'Jamais de nom de fichier, de numéro de tâche, d’adresse web, de code ni d’identifiant technique. '
    + 'Pas de préambule, pas de formule de politesse. Termine par la phrase : « Fin du résumé. »';
};

/**
 * Piper seulement : les mots anglais que ses voix françaises écorchent (« closing » rendu « ploussing »,
 * « LinkedIn » rendu « l’INK »), écrits comme ils se prononcent. La voix du Mac a son propre lexique, plus court (SAY_MAC).
 */
const SAY: [RegExp, string][] = [
  [/\blinkedin\b/gi, 'Linnkedinn'], [/\bclosings?\b/gi, 'clozinng'], [/\bsettings?\b/gi, 'séttinng'], [/\bclosers?\b/gi, 'clozeur'],
  [/\bsetters?\b/gi, 'setteur'], [/\bleads?\b/gi, 'lide'], [/\bcalls?\b/gi, 'col'], [/\bWhatsApp\b/gi, 'Watsap'],
  [/\be-?mails?\b/gi, 'imèle'], [/\bfeedbacks?\b/gi, 'fidbak'], [/\bbusiness\b/gi, 'biznèss'],
];

/**
 * Voix du Mac : elle dit juste « LinkedIn », « closing », « setting », mais lit à la française « closer » (« closet »),
 * « setter » (« CETER »), « leads » (« LEA ») et « WhatsApp » (« ou apps ») ; ajoute ici les mots de ton métier.
 */
const SAY_MAC: [RegExp, string][] = [
  [/\bclosers\b/gi, 'clozeurs'], [/\bcloser\b/gi, 'clozeur'], [/\bsetters\b/gi, 'setteurs'], [/\bsetter\b/gi, 'setteur'],
  [/\bleads\b/gi, 'lides'], [/\blead\b/gi, 'lide'], [/\bWhatsApp\b/gi, 'Watsap'],
];

/** Le texte tel que la voix le reçoit : une seule ligne, sans signe qu'elle lirait tout haut. */
export function forVoice(script: string): string {
  let t = script.replace(/[*_`#>|[\]]/g, ' ').replace(/\s[—–-]\s/g, ', ').replace(/[«»"“”]/g, ' ')
    .replace(/(\d)[   ](?=\d{3}\b)/g, '$1').replace(/%/g, ' pour cent').replace(/€/g, ' euros').replace(/\$/g, ' dollars')
    .replace(/&/g, ' et ').replace(/\+(?=\d)/g, 'plus ');
  if (ENGINE === 'piper') for (const [re, to] of SAY) t = t.replace(re, to);
  else if (ENGINE === 'say') for (const [re, to] of SAY_MAC) t = t.replace(re, to);
  return t.replace(/\s+/g, ' ').replace(/ ([,.])/g, '$1').trim();
}

/** Le texte à dire, écrit par Claude. Lève une erreur si la CLI échoue ou rend un texte hors gabarit. */
async function writeScript(r: Report): Promise<string> {
  const bin = findClaude();
  if (!bin) throw new Error('CLI claude absente');
  await fsp.mkdir(WORK_DIR, { recursive: true, mode: 0o700 });
  const out = (await runBin(bin, ['-p', '--model', AUDIO_MODEL, '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--system-prompt', system(r.words)], { timeout: 180_000, input: audioSource(r), env: haikuEnv(), cwd: WORK_DIR })).trim();
  const n = out.split(/\s+/).length;
  // un message de panne de la CLI est court : au-delà de 120 mots c'est un vrai texte, même s'il parle de connexion OAuth
  if ((n < 120 && /failed to authenticate|oauth|please run|\/login|api error/i.test(out)) || n < 50 || n > MAX_SCRIPT_WORDS) throw new Error(`texte refusé (${n} mots)`);
  return out;
}

/** La voix : le moteur écrit un WAV, ffmpeg en fait un MP3 mono à débit constant (la durée se lit sur sa taille). */
export async function speak(text: string): Promise<{ mp3: Buffer; seconds: number; voice: string }> {
  const base = path.join(WORK_DIR, `report-audio-${process.pid}-${++seq}`);
  let voice = VOICE_NAME;
  try {
    await fsp.mkdir(WORK_DIR, { recursive: true, mode: 0o700 });
    let src = `${base}.wav`;
    if (ENGINE === 'edge') {
      await fsp.writeFile(`${base}.txt`, text, { mode: 0o600 });
      try {
        await runBin(EDGE_BIN, ['--voice', EDGE_VOICE, '--file', `${base}.txt`, '--write-media', `${base}.src.mp3`], { timeout: 600_000 });
        src = `${base}.src.mp3`;
      } catch {
        // service de Microsoft injoignable : la voix du Mac, avec son lexique, plutôt qu'aucun résumé
        voice = `say-${SAY_VOICE}`;
        let t = text;
        for (const [re, to] of SAY_MAC) t = t.replace(re, to);
        await fsp.writeFile(`${base}.txt`, t, { mode: 0o600 });
        await runBin(SAY_BIN, ['-v', SAY_VOICE, '-r', String(SAY_RATE), '--data-format=LEI16@22050', '-o', `${base}.wav`, '-f', `${base}.txt`], { timeout: 240_000 });
      }
    } else if (ENGINE === 'say') {
      await fsp.writeFile(`${base}.txt`, text, { mode: 0o600 });
      await runBin(SAY_BIN, ['-v', SAY_VOICE, '-r', String(SAY_RATE), '--data-format=LEI16@22050', '-o', `${base}.wav`, '-f', `${base}.txt`], { timeout: 240_000 });
    } else await runBin(PIPER, ['-m', VOICE, '-f', `${base}.wav`, '--sentence-silence', '0.35'], { timeout: 240_000, input: text });
    await runBin(findFfmpeg()!, ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-b:a', `${MP3_KBPS}k`, `${base}.mp3`], { timeout: 90_000 });
    const mp3 = await fsp.readFile(`${base}.mp3`);
    if (mp3.length < MP3_MIN_BYTES) throw new Error('son vide');
    return { mp3, seconds: mp3Seconds(mp3), voice };
  } finally {
    for (const ext of ['txt', 'wav', 'mp3', 'src.mp3']) await fsp.rm(`${base}.${ext}`, { force: true }).catch(() => undefined);
  }
}

export interface AudioMade { mp3: Buffer; seconds: number; script: string }

/** Le résumé audio d'un rapport (texte puis voix), et sa ligne de coût. */
export async function renderReportAudio(r: Report): Promise<AudioMade> {
  const t0 = Date.now();
  const script = await writeScript(r);
  const t1 = Date.now();
  const { mp3, seconds, voice } = await speak(forVoice(script));
  const line = {
    at: new Date().toISOString(), id: r.id, mots_rapport: r.words, caracteres_envoyes: audioSource(r).length, mots_texte: script.split(/\s+/).length,
    modele: AUDIO_MODEL, texte_s: Math.round((t1 - t0) / 1000), voix: voice, voix_s: Math.round((Date.now() - t1) / 1000),
    duree_s: seconds, mp3_ko: Math.round(mp3.length / 1024), cout_api_usd: 0,
  };
  await fsp.appendFile(COSTS_FILE, `${JSON.stringify(line)}\n`, { mode: 0o600 }).catch(() => undefined);
  return { mp3, seconds, script };
}
