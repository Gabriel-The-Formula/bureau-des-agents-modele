// npm run local : le Bureau des agents en entier sur ta machine, sans compte Cloudflare ni mot de passe.
//   1. installe ce qui manque (une fois) et construit le bureau (dist/)
//   2. crée worker/.dev.vars (jeton du collecteur et mot de passe local tirés au hasard, LOCAL_MODE=1) s'il n'existe pas
//   3. lance le Worker en local (wrangler dev : le même code qu'en ligne, Durable Object et R2 simulés dans
//      worker/.wrangler/state, gardés d'un lancement à l'autre) sur http://127.0.0.1:8790
//   4. lance le collecteur (tes sessions Claude Code de ~/.claude/projects) pointé dessus, puis ouvre le navigateur ;
//      onglet Rapports : les fiches .md du dossier donné par --rapports (ou BUREAU_REPORTS_DIR)
// Ctrl+C arrête tout. Options : --port 8790, --no-open, --rapports <dossier>. Rien ne part ailleurs que sur ta machine (sauf les
// résumés Claude Haiku si `claude` est connecté, sur ton abonnement ; BUREAU_AI_SUMMARY=0 les coupe). Le navigateur
// est connecté par le lien /login?cle=<mot de passe local> (le bureau garde une connexion : une page piégée qui viserait 127.0.0.1 ne voit rien).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'worker');
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(opt('--port')) || 8790;
const OPEN = !args.includes('--no-open');
const URL_LOCAL = `http://127.0.0.1:${PORT}`;
const WIN = process.platform === 'win32';

function step(text: string) { console.log(`\n  > ${text}`); }
function fail(text: string): never { console.error(`\n  Arrêt : ${text}\n`); process.exit(1); }

function run(cmd: string, argv: string[], cwd: string) {
  const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit', shell: WIN });
  if (r.status !== 0) fail(`« ${cmd} ${argv.join(' ')} » a échoué (dossier ${path.relative(ROOT, cwd) || '.'}).`);
}

// 1. Node, dépendances (à installer la première fois, ou à refaire si package-lock.json a changé depuis : git pull), construction
run(process.execPath, ['scripts/check-node.mjs'], ROOT);
const mtime = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const stale = (dir: string) => mtime(path.join(dir, 'node_modules', '.package-lock.json')) < mtime(path.join(dir, 'package-lock.json'));
function install(dir: string, label: string) {
  if (!stale(dir)) return;
  step(`Installation ${label} (~1 min, la première fois ou après une mise à jour)`);
  run('npm', ['install', '--no-audit', '--no-fund'], dir);
  const mark = path.join(dir, 'node_modules', '.package-lock.json');
  if (fs.existsSync(mark)) fs.utimesSync(mark, new Date(), new Date()); // npm ne le réécrit pas quand rien n'a changé
}
install(ROOT, 'du bureau');
install(WORKER, 'du serveur local');
step('Construction du bureau');
run('npx', ['vite', 'build', '--logLevel', 'warn'], ROOT);

// 2. worker/.dev.vars : complété sans rien écraser (jamais versionné, voir .gitignore)
const varsFile = path.join(WORKER, '.dev.vars');
const vars = new Map<string, string>();
if (fs.existsSync(varsFile)) {
  for (const line of fs.readFileSync(varsFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars.set(m[1], m[2].replace(/^"(.*)"$/, '$1'));
  }
}
const missing: string[] = [];
for (const k of ['INGEST_TOKEN', 'SESSION_SECRET', 'ACCESS_PASSWORD']) if (!vars.get(k)) { vars.set(k, randomBytes(24).toString('base64url')); missing.push(k); }
if (vars.get('LOCAL_MODE') !== '1') { vars.set('LOCAL_MODE', '1'); missing.push('LOCAL_MODE'); }
if (missing.length) {
  const add = missing.map((k) => `${k}=${vars.get(k)}`).join('\n') + '\n';
  const prev = fs.existsSync(varsFile) ? fs.readFileSync(varsFile, 'utf8') : '# Mode local du Bureau des agents (npm run local) : secrets de cette machine seulement, jamais versionnés.\n';
  fs.writeFileSync(varsFile, prev.replace(/\n?$/, '\n') + add, { mode: 0o600 });
}

// les rapports de l'onglet Rapports : --rapports, sinon BUREAU_REPORTS_DIR (sans dossier, l'onglet reste vide)
const REPORTS = opt('--rapports') ? path.resolve(opt('--rapports') as string)
  : process.env.BUREAU_REPORTS_DIR ? path.resolve(process.env.BUREAU_REPORTS_DIR)
  : undefined;
if (REPORTS && !fs.existsSync(REPORTS)) fail(`dossier des rapports introuvable : ${REPORTS}`);

/** Les fiches que l'onglet Rapports publiera : .md à deux niveaux au plus qui commencent par un en-tête `rapport:` (comme le collecteur). */
function countReports(dir: string, depth = 0): number {
  let n = 0;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.') || d.name === 'node_modules') continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory() && depth < 2) n += countReports(p, depth + 1);
    else if (d.isFile() && depth > 0 && d.name.endsWith('.md')) {
      const head = fs.readFileSync(p, 'utf8').slice(0, 4000);
      if (/^---\r?\n/.test(head) && /^rapport\s*:/m.test(head.split(/\r?\n---/)[0] ?? '')) n++;
    }
  }
  return n;
}
const nReports = REPORTS ? countReports(REPORTS) : 0;

// 3. le Worker en local, puis 4. le collecteur
const procs: ChildProcess[] = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill('SIGINT');
  setTimeout(() => process.exit(code), 1500);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

step(`Démarrage du bureau sur ${URL_LOCAL}`);
const worker = spawn('npx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(PORT),
  // sans ça, wrangler présente les requêtes avec le domaine de la route en ligne (wrangler.toml) au lieu de 127.0.0.1
  '--local-upstream', `127.0.0.1:${PORT}`, '--show-interactive-dev-session=false', '--log-level', 'warn'], {
  cwd: WORKER, stdio: 'inherit', shell: WIN, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
procs.push(worker);
worker.on('exit', (code) => { if (!stopping) { console.error(`\n  Le serveur local s'est arrêté (code ${code}). Port ${PORT} déjà pris ? Relance avec --port 8791.`); stop(1); } });

async function ready(): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${URL_LOCAL}/favicon.svg`);
      if (r.ok) return true; // le Worker répond
    } catch { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (!(await ready())) { console.error(`\n  Le bureau ne répond pas sur ${URL_LOCAL} après 60 s.`); stop(1); }
else {
  const collector = spawn(process.execPath, ['collector/index.ts'], {
    cwd: ROOT, stdio: 'inherit',
    env: {
      ...process.env, BUREAU_URL: URL_LOCAL, BUREAU_TOKEN: vars.get('INGEST_TOKEN'), BUREAU_SOURCE_ID: 'local', BUREAU_SOURCE_LABEL: process.env.BUREAU_SOURCE_LABEL ?? 'Mes sessions',
      ...(REPORTS ? { BUREAU_REPORTS_DIR: REPORTS } : {}),
      // les rapports déjà envoyés sont notés à côté de l'état du Worker local : effacer l'un efface l'autre
      BUREAU_REPORTS_STORE: path.join(WORKER, '.wrangler', 'state', 'rapports-envoyes.json'),
    },
  });
  procs.push(collector);
  collector.on('exit', (code) => { if (!stopping) { console.error(`\n  Le collecteur s'est arrêté (code ${code}).`); stop(1); } });
  const hours = Number(process.env.BUREAU_WINDOW_H) || 24;
  const link = `${URL_LOCAL}/login?cle=${encodeURIComponent(vars.get('ACCESS_PASSWORD') ?? '')}`;
  const reports = !REPORTS ? '  Onglet Rapports : vide (relance avec --rapports <dossier> pour y publier tes fiches .md).\n'
    : nReports ? `  Onglet Rapports : ${nReports} fiche${nReports > 1 ? 's' : ''} de ${REPORTS}\n`
    : `  Onglet Rapports : aucune fiche avec un en-tête « rapport: » dans ${REPORTS}.\n`;
  console.log(`\n  Le Bureau des agents est ouvert : ${URL_LOCAL}\n  Lien de connexion (un clic, retenu 30 jours) : ${link}\n  Tes sessions Claude Code des dernières ${hours} h y apparaissent en quelques secondes.\n${reports}  Ctrl+C pour tout arrêter.\n`);
  if (OPEN) spawn(process.platform === 'darwin' ? 'open' : WIN ? 'cmd' : 'xdg-open', WIN ? ['/c', 'start', '', link] : [link], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
