// Les libellés SÛRS des actions, pour le suivi en ligne.
// Contrairement à describeAct() (shared/activity.ts), rien de brut ne sort d'ici : pas de commande complète,
// pas de chemin absolu, pas d'URL complète, pas de nom d'utilisateur. Tout passe par redact() puis est coupé court.
import os from 'node:os';
import { mcpName } from '../shared/activity.ts';
import { redact } from '../shared/live.ts';
import type { ActKind } from '../shared/protocol.ts';

const HOME = os.homedir();
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOME_RE = new RegExp(esc(HOME), 'g');
const USER = (() => { try { return os.userInfo().username; } catch { return ''; } })();
const USER_RE = USER.length >= 3 ? new RegExp(esc(USER), 'gi') : null;

/** Coupe proprement (espaces compactés, « … » à la fin). */
export function cut(s: unknown, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/** Retire le dossier personnel et tout chemin /Users/<nom> ou /home/<nom> restant. */
export function untilde(s: string): string {
  let t = s.replace(HOME_RE, '~').replace(/\/(?:Users|home)\/[^/\s"'`]+/g, '~').replace(/\/private\/(?:tmp|var)\/[^\s"'`]*/g, '(dossier temporaire)');
  t = t.replace(/-(?:Users|home)-[A-Za-z0-9_.]+-/g, '~-');
  return USER_RE ? t.replace(USER_RE, '~') : t;
}

/** Le passage obligé de tout texte envoyé : chemins personnels retirés, secrets caviardés, coupé à n. */
export function safe(s: unknown, n: number): string {
  return cut(redact(untilde(String(s ?? ''))).replace(/\s*—\s*/g, ', '), n);
}

/** Nom de fichier + au plus 2 dossiers parents, relatif au cwd s'il est dedans ; jamais absolu. */
export function shortPath(p: unknown, cwd: string): string {
  let s = String(p ?? '').trim();
  if (!s) return '';
  if (cwd && (s === cwd || s.startsWith(cwd + '/'))) s = s.slice(cwd.length + 1) || '.';
  const parts = s.split(/[\\/]+/).filter((x) => x && x !== '~');
  return safe(parts.slice(-3).join('/'), 60);
}

function hostOf(u: unknown): string {
  try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return 'une page web'; }
}

/** Le programme lancé par une commande Bash : premier mot utile, sans variables d'env, cd, sudo ni chemin. */
export function programOf(command: unknown): string {
  const c = String(command ?? '');
  // dernière commande après un « cd … && » ; sinon la première
  const segs = c.split(/&&|\|\||;|\n/).map((x) => x.trim()).filter(Boolean);
  for (const seg of segs) {
    const words = seg.split(/\s+/);
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ['sudo', 'env', 'time', 'nohup', 'exec', 'command', '('].includes(words[i]))) i++;
    const w = (words[i] ?? '').replace(/^["'(]+|["')]+$/g, '');
    if (!w || w === 'cd' || w === 'export' || w === 'source' || w === '.') continue;
    const base = w.split('/').pop() ?? '';
    if (/^[A-Za-z0-9][A-Za-z0-9._+-]{0,29}$/.test(base)) return base;
  }
  return 'une commande';
}

export interface SafeAct { kind: ActKind; label: string; detail: string }

/** L'action d'un outil, résumée sans aucune donnée brute. */
export function safeAct(tool: string, input: Record<string, unknown> | undefined, cwd: string): SafeAct {
  const i = input ?? {};
  switch (tool) {
    case 'Bash': {
      const desc = typeof i.description === 'string' && i.description.trim() ? safe(i.description, 50) : '';
      const label = desc || `Je lance ${programOf(i.command)}`;
      return { kind: 'bash', label, detail: label };
    }
    case 'BashOutput': return { kind: 'bash', label: 'Je regarde une commande en cours', detail: '' };
    case 'KillShell': case 'TaskStop': return { kind: 'bash', label: 'J’arrête une tâche', detail: '' };
    case 'Read': { const f = shortPath(i.file_path, cwd); return { kind: 'read', label: `Je lis ${cut(f.split('/').pop(), 40)}`, detail: f }; }
    case 'Write': { const f = shortPath(i.file_path, cwd); return { kind: 'write', label: `J’écris ${cut(f.split('/').pop(), 40)}`, detail: f }; }
    case 'Edit': case 'MultiEdit': { const f = shortPath(i.file_path, cwd); return { kind: 'edit', label: `Je retouche ${cut(f.split('/').pop(), 38)}`, detail: f }; }
    case 'NotebookEdit': { const f = shortPath(i.notebook_path, cwd); return { kind: 'edit', label: `Je retouche ${cut(f.split('/').pop(), 38)}`, detail: f }; }
    case 'Glob': return { kind: 'read', label: 'Je fouille le dossier', detail: safe(i.pattern, 40) };
    case 'Grep': { const p = safe(i.pattern, 40); return { kind: 'read', label: `Je cherche « ${p} »`, detail: p }; }
    case 'LS': return { kind: 'read', label: 'Je regarde le dossier', detail: '' };
    case 'WebSearch': { const q = safe(i.query, 40); return { kind: 'search', label: `Je cherche « ${q} »`, detail: q }; }
    case 'WebFetch': { const h = safe(hostOf(i.url), 50); return { kind: 'web', label: `Je lis ${h}`, detail: h }; }
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'mcp__ccd_turn__update_plan':
      return { kind: 'plan', label: 'Je mets le plan à jour', detail: '' };
    case 'mcp__ccd_turn__wrap_up': return { kind: 'plan', label: 'Je fais le point', detail: '' };
    case 'AskUserQuestion': return { kind: 'other', label: 'Je te pose une question', detail: '' };
    case 'ExitPlanMode': return { kind: 'plan', label: 'Je te propose un plan', detail: '' };
    case 'Skill': { const s = safe(i.skill ?? i.name, 30); return { kind: 'skill', label: `J’applique la méthode ${s}`, detail: s }; }
    case 'ToolSearch': return { kind: 'other', label: 'Je cherche le bon outil', detail: '' };
    case 'SendMessage': return { kind: 'other', label: 'J’écris à un agent', detail: '' };
  }
  if (tool.startsWith('mcp__')) {
    const { server, action } = mcpName(tool);
    const s = safe(server, 30);
    return { kind: 'mcp', label: `Je passe par ${s}`, detail: safe(action, 40) };
  }
  return { kind: 'other', label: `J’utilise ${safe(tool, 30)}`, detail: '' };
}

/** La phrase du statut « au travail » pour une action en cours. */
export function busyText(kind: ActKind, tool: string): string {
  switch (kind) {
    case 'bash': return 'Lance une commande';
    case 'read': return 'Lit des fichiers';
    case 'write': case 'edit': return 'Modifie des fichiers';
    case 'search': case 'web': return 'Cherche sur internet';
    case 'plan': return 'Met le plan à jour';
    case 'skill': return 'Applique une méthode';
    case 'mcp': return `Passe par ${safe(mcpName(tool).server, 30)}`;
    default: return 'Au travail';
  }
}

/**
 * Un passage plus long d'un message de l'agent (pour le fil de la salle et les décisions) : sans code ni balises,
 * les retours à la ligne gardés, caviardé et coupé à n.
 */
export function passage(text: unknown, n = 600): string {
  const t = redact(untilde(String(text ?? '')))
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<[^>]{1,40}>[\s\S]*?<\/[^>]{1,40}>/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s*—\s*/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  // caviardé une seconde fois APRÈS le nettoyage : un secret coupé par la mise en forme (`sk-**…**`) est recollé ici
  const r = redact(untilde(t));
  return r.length > n ? r.slice(0, n - 1).trimEnd() + '…' : r;
}

/** La première phrase d'un texte du chef (sans blocs de code ni balises), courte et caviardée. */
export function firstSentence(text: unknown, n = 100): string {
  const t = String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<[^>]{1,40}>[\s\S]*?<\/[^>]{1,40}>/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_#>]+/g, ' ');
  const line = t.split('\n').map((l) => l.trim()).find((l) => l.length > 1) ?? '';
  const m = line.match(/^.*?[.!?…](?=\s|$)/);
  return safe(m ? m[0] : line, n);
}
