// L'état résumé d'une session Claude Code (et de ses sous-agents), construit ligne à ligne à partir
// de sa transcription JSONL. Seul le résumé est gardé en mémoire, jamais les lignes.
import fs from 'node:fs';
import path from 'node:path';
import { NAMES, ROLES, roleOfType } from '../shared/activity.ts';
import type { Decision, FeedMedia, RoomEvent, SessionStatus, SessionSummary, SubagentSummary } from '../shared/live.ts';
import type { ActKind, OfficeEvent, PlanItem, Role } from '../shared/protocol.ts';
import { costOf } from '../shared/pricing.ts';
import { summarize } from './summarize.ts';
import { busyText, firstSentence, passage, safe, safeAct, untilde } from './describe.ts';

type Json = Record<string, any>;

const MIN = 60_000;
const WORKING_RECENT_MS = 3 * MIN;
const PENDING_BLOCKED_MS = 10 * MIN;
const END_TURN_WAIT_MS = 120 * MIN;
const SUB_IDLE_MS = 15 * MIN;
const SILENT_DONE_MS = 30 * MIN;
const MAX_SUBAGENTS_LISTED = 40;

// ── Lecture incrémentale d'un fichier JSONL ──

const CHUNK = 4 * 1024 * 1024;

/** Les lignes qu'on ne lit jamais (énormes et inutiles ici) : on les écarte avant de les décoder. */
function wanted(buf: Buffer): boolean {
  const head = buf.toString('latin1', 0, Math.min(buf.length, 220));
  if (head.startsWith('{"type":"api-request') || head.startsWith('{"type":"file-history') || head.startsWith('{"type":"queue-operation') || head.startsWith('{"type":"last-prompt')) return false;
  if (head.includes('"attachment":{')) return false;
  return true;
}

export class LineReader {
  readonly file: string;
  offset = 0;
  size = 0;
  mtime = 0;
  private partial: Buffer | null = null;

  constructor(file: string) { this.file = file; }

  /** Lit les nouvelles lignes complètes. Renvoie 'reset' si le fichier a rétréci (réécrit), sinon le nombre de lignes lues. */
  read(onLine: (m: Json) => void): number | 'reset' {
    let st: fs.Stats;
    try { st = fs.statSync(this.file); } catch { return 0; }
    this.mtime = st.mtimeMs;
    if (st.size === this.size) return 0;
    if (st.size < this.offset) { this.offset = 0; this.size = 0; this.partial = null; return 'reset'; }
    let fd: number;
    try { fd = fs.openSync(this.file, 'r'); } catch { return 0; }
    let n = 0;
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      while (this.offset < st.size) {
        const got = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - this.offset), this.offset);
        if (got <= 0) break;
        this.offset += got;
        let data = buf.subarray(0, got);
        if (this.partial) { data = Buffer.concat([this.partial, data]); this.partial = null; }
        let start = 0;
        for (;;) {
          const nl = data.indexOf(10, start);
          if (nl < 0) break;
          if (nl > start) {
            const line = data.subarray(start, nl);
            if (wanted(line)) {
              let m: Json | null = null;
              try { m = JSON.parse(line.toString('utf8')); } catch { /* ligne abîmée : on passe */ }
              if (m && typeof m === 'object') { onLine(m); n++; }
            }
          }
          start = nl + 1;
        }
        if (start < data.length) this.partial = Buffer.from(data.subarray(start));
      }
    } finally { fs.closeSync(fd); }
    this.size = st.size;
    return n;
  }
}

// ── Petits outils ──

const ts = (m: Json): number | null => {
  const t = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
};

const TAG_BLOCKS = /<(system-reminder|task-notification|local-command-stdout|local-command-stderr|local-command-caveat|command-message|command-args|command-name|ide_opened_file|ide_selection)>[\s\S]*?<\/\1>/g;

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: Json) => (c?.type === 'text' ? String(c.text ?? '') : '')).join('\n');
  return '';
}

function planStatus(s: unknown): PlanItem['status'] {
  return s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending';
}

const agoMin = (ms: number) => Math.max(1, Math.round(ms / MIN));

interface Pending { name: string; at: number; kind: ActKind }

// ── Un sous-agent ──

export class SubState {
  readonly id: string;
  type = '';
  task = '';
  role: Role = 'renfort';
  name = '';
  background = false;
  status: SubagentSummary['status'] = 'working';
  startedAt: number;
  endedAt?: number;
  lastLineAt: number;
  tokens = 0;
  tools = 0;
  /** équivalent tarif API (dollars) ; costUnknown = jetons d'un modèle hors de la table */
  cost = 0;
  costUnknown = 0;
  lastAct?: string;
  lastText = '';
  endTurn = false;
  hired = false;
  readonly msgIds = new Set<string>();
  readonly pending = new Map<string, Pending>();
  reader: LineReader | null = null;

  constructor(id: string, at: number) {
    this.id = id;
    this.startedAt = at;
    this.lastLineAt = at;
  }
}

export interface Options { sourceId: string; snippets: boolean; eventCap: number; shareRequest: boolean; aiSummary: boolean }

// ── Une session ──

export class SessionState {
  readonly key: string;
  readonly sessionId: string;
  readonly file: string;
  readonly reader: LineReader;
  /** dossier des transcriptions des sous-agents */
  readonly subDir: string;
  private readonly subDirMtimes = new Map<string, number>();
  private readonly opts: Options;

  cwd = '';
  branch = '';
  entrypoint = '';
  model = '';
  customTitle = '';
  firstPrompt = '';
  /** tes messages (en mémoire seulement : seul leur résumé part au bureau) */
  private firstRequest = '';
  private firstRequestAt = 0;
  private lastRequest = '';
  private lastRequestAt = 0;
  private requestCount = 0;
  prUrl = '';
  startedAt = 0;
  lastActivity = 0;
  lastAct?: string;
  plan: PlanItem[] = [];
  private taskIds: string[] = [];
  private taskSeq = 0;
  tokens = 0;
  tools = 0;
  cost = 0;
  costUnknown = 0;
  /** coût et tâches cochées, par jour (minuit local), pour le bandeau du jour */
  readonly costByDay = new Map<number, number>();
  readonly unknownDays = new Set<number>();
  readonly doneByDay = new Map<number, number>();
  /** pour le fil des réalisations : le dernier compte rendu (wrap_up), le dernier texte du chef, les liens et fichiers */
  recap = '';
  lastChefText = '';
  readonly links = new Set<string>();
  readonly files = new Set<string>();
  /** ce que l'app desktop sait de la session (fichier claude-code-sessions/…/local_<id>.json) */
  desktop: DesktopMeta | null = null;
  /** clés des salles parente et enfants (rattachées par index.ts) */
  parentKey?: string;
  childKeys: string[] = [];
  hasAssistant = false;
  private readonly msgIds = new Set<string>();
  readonly pending = new Map<string, Pending>();
  readonly subs = new Map<string, SubState>();
  private readonly subByFile = new Set<string>();
  private readonly names = new Set<string>();
  private wrapUp: { ask: boolean; at: number } | null = null;
  /** la dernière décision demandée (question, plan à valider, choix de fin de tour) ; gardée pour le fil des réalisations */
  lastDecision: Decision | null = null;
  /** les images de la session, dans l'ordre : jointes à un message (avant / après, graphiques), ou regardées */
  readonly shots: Shot[] = [];
  /** les captures déjà envoyées au Worker (rattachées par feed.ts) */
  media: FeedMedia[] = [];
  private endTurnAt: number | null = null;
  private lastEndMsg = '';
  private turnStartAt = 0;
  private apiErrors = 0;
  private apiErrorKind = '';
  /** le processus s'est arrêté (cost-state), jusqu'à la prochaine ligne de conversation */
  private exited = false;

  /** événements pas encore envoyés */
  outbox: RoomEvent[] = [];
  /** le résumé a changé depuis le dernier envoi */
  dirty = true;
  /** signature du dernier statut envoyé (statut + phrase) */
  statusSig = '';
  status: SessionStatus = 'working';
  statusText = '';

  constructor(file: string, sessionId: string, opts: Options) {
    this.file = file;
    this.sessionId = sessionId;
    this.opts = opts;
    this.key = `${opts.sourceId}:${sessionId}`;
    this.reader = new LineReader(file);
    this.subDir = path.join(path.dirname(file), sessionId, 'subagents');
  }

  private emit(at: number, ev: OfficeEvent) {
    this.outbox.push({ key: this.key, at, ev });
    if (this.outbox.length > this.opts.eventCap * 2) this.trimOutbox(this.opts.eventCap);
    this.dirty = true;
  }

  /** Ne garde que les n derniers événements à envoyer (rattrapage d'historique). */
  trimOutbox(n: number) {
    const box = this.outbox.sort((a, b) => a.at - b.at);
    if (box.length <= n) return;
    // on garde toujours ce qui remet la salle dans son état : le dernier message reçu, le dernier plan,
    // et l'arrivée des sous-agents encore au travail
    const keep = new Set<RoomEvent>();
    let lastPlan: RoomEvent | undefined;
    let lastStart: RoomEvent | undefined;
    for (const e of box) {
      if (e.ev.k === 'plan') lastPlan = e;
      else if (e.ev.k === 'start') lastStart = e;
      else if (e.ev.k === 'hire' && this.subs.get(e.ev.id)?.status === 'working') keep.add(e);
    }
    if (lastPlan) keep.add(lastPlan);
    if (lastStart) keep.add(lastStart);
    const cutoff = box.length - Math.max(0, n - keep.size);
    this.outbox = box.filter((e, i) => i >= cutoff || keep.has(e));
  }

  private pickName(role: Role) {
    const name = NAMES[role].find((n) => !this.names.has(n)) ?? `${ROLES[role].label} ${this.names.size + 1}`;
    this.names.add(name);
    return name;
  }

  // ── Lecture ──

  /** Lit les nouvelles lignes du chef puis des sous-agents. Renvoie vrai si quelque chose a bougé. */
  update(): boolean {
    let moved = false;
    const r = this.reader.read((m) => this.chefLine(m));
    if (r === 'reset') { this.resetState(); this.reader.read((m) => this.chefLine(m)); moved = true; }
    else if (r > 0) moved = true;
    if (this.scanSubDir()) moved = true;
    for (const sub of this.subs.values()) {
      if (!sub.reader) continue;
      const n = sub.reader.read((m) => this.subLine(sub, m));
      if (n === 'reset') continue;
      if (n > 0) {
        moved = true;
        if (sub.endTurn && sub.pending.size === 0) this.finishSub(sub, true, sub.lastLineAt);
      }
    }
    if (!this.lastActivity) this.lastActivity = this.reader.mtime;
    if (moved) this.dirty = true;
    return moved;
  }

  private resetState() {
    this.plan = []; this.taskIds = []; this.tokens = 0; this.tools = 0; this.cost = 0; this.costUnknown = 0; this.firstRequest = ''; this.lastRequest = ''; this.requestCount = 0; this.costByDay.clear(); this.unknownDays.clear(); this.doneByDay.clear(); this.msgIds.clear(); this.pending.clear();
    this.wrapUp = null; this.endTurnAt = null; this.apiErrors = 0; this.exited = false; this.lastDecision = null; this.shots.length = 0;
  }

  /** Repère les transcriptions de sous-agents (agent-<id>.meta.json) et les rattache à l'appel Agent du chef. */
  private scanSubDir(): boolean {
    // les sous-agents de l'outil Agent (subagents/), et ceux des workflows (subagents/workflows/<run>/)
    const dirs = [this.subDir];
    const wf = path.join(this.subDir, 'workflows');
    try { for (const r of fs.readdirSync(wf)) dirs.push(path.join(wf, r)); } catch { /* pas de workflow */ }
    let moved = false;
    for (const dir of dirs) if (this.scanOneSubDir(dir)) moved = true;
    return moved;
  }

  private scanOneSubDir(dir: string): boolean {
    let st: fs.Stats;
    try { st = fs.statSync(dir); } catch { return false; }
    if (!st.isDirectory() || st.mtimeMs === this.subDirMtimes.get(dir)) return false;
    this.subDirMtimes.set(dir, st.mtimeMs);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return false; }
    let moved = false;
    for (const n of names) {
      const m = /^agent-(.+)\.meta\.json$/.exec(n);
      if (!m) continue;
      const jsonl = path.join(dir, `agent-${m[1]}.jsonl`);
      if (this.subByFile.has(jsonl)) continue;
      let meta: Json;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
      const id = String(meta.toolUseId ?? `agent-${m[1]}`);
      let sub = this.subs.get(id);
      if (!sub) {
        let at = this.lastActivity || Date.now();
        try { at = fs.statSync(path.join(dir, n)).mtimeMs; } catch { /* rien */ }
        const task = meta.workflowPhase ? `${meta.workflowPhase} · ${meta.description ?? ''}` : String(meta.description ?? '');
        sub = this.hire(id, String(meta.agentType ?? ''), task, at);
      }
      if (meta.requestShape === 'background') sub.background = true;
      sub.reader = new LineReader(jsonl);
      this.subByFile.add(jsonl);
      moved = true;
    }
    return moved;
  }

  private hire(id: string, type: string, description: string, at: number): SubState {
    let sub = this.subs.get(id);
    if (!sub) { sub = new SubState(id, at); this.subs.set(id, sub); }
    sub.type = type || sub.type;
    sub.task = safe(description || sub.task || ROLES[roleOfType(sub.type)].label, 48);
    sub.role = roleOfType(sub.type);
    if (!sub.hired) {
      sub.hired = true;
      sub.name = this.pickName(sub.role);
      this.emit(at, { k: 'hire', id, role: sub.role, type: safe(sub.type, 40), name: sub.name, task: sub.task, prompt: '' });
    }
    return sub;
  }

  private finishSub(sub: SubState, ok: boolean, at: number) {
    if (sub.status !== 'working') return;
    sub.status = ok ? 'done' : 'failed';
    sub.endedAt = at;
    sub.pending.clear();
    const text = this.opts.snippets && sub.lastText ? firstSentence(sub.lastText, 100) : '';
    this.emit(at, { k: 'report', who: sub.id, text: text || (ok ? 'Travail rendu' : 'Travail interrompu') });
    this.emit(at, { k: 'leave', who: sub.id, ok, tokens: sub.tokens, tools: sub.tools, ms: Math.max(0, at - sub.startedAt) });
    this.dirty = true;
  }

  private chefLine(m: Json) {
    const at = ts(m);
    if (typeof m.cwd === 'string' && m.cwd) this.cwd = m.cwd;
    if (typeof m.gitBranch === 'string' && m.gitBranch) this.branch = m.gitBranch;
    if (typeof m.entrypoint === 'string' && m.entrypoint) this.entrypoint = m.entrypoint;
    switch (m.type) {
      case 'custom-title': if (m.customTitle) this.customTitle = String(m.customTitle); return;
      case 'agent-name': if (m.agentName) this.customTitle = String(m.agentName); return;
      case 'cost-state': this.exited = true; return;
      case 'pr-link': if (typeof m.prUrl === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(m.prUrl)) this.prUrl = m.prUrl; return;
      case 'assistant': case 'user': case 'system': break;
      default: return;
    }
    if (m.type !== 'system') this.exited = false;
    if (m.isSidechain) return; // anciens sous-agents écrits dans le fichier du chef : on ne les compte pas comme le chef
    const t = at ?? (this.lastActivity || Date.now());
    if (!this.startedAt) this.startedAt = t;
    if (t > this.lastActivity) this.lastActivity = t;
    if (m.type === 'assistant') this.assistant(m, null, t);
    else if (m.type === 'user') this.user(m, null, t);
  }

  private subLine(sub: SubState, m: Json) {
    if (m.type !== 'assistant' && m.type !== 'user') return;
    const t = ts(m) ?? sub.lastLineAt;
    if (t > sub.lastLineAt) sub.lastLineAt = t;
    if (m.type === 'assistant') this.assistant(m, sub, t);
    else this.user(m, sub, t);
  }

  private assistant(m: Json, sub: SubState | null, at: number) {
    const msg = m.message;
    if (!msg || typeof msg !== 'object') return;
    if (m.isApiErrorMessage || msg.model === '<synthetic>') {
      if (!sub && m.isApiErrorMessage) { this.apiErrors++; this.apiErrorKind = String(m.error ?? ''); }
      return;
    }
    if (!sub) { this.apiErrors = 0; this.hasAssistant = true; if (msg.model) this.model = String(msg.model); }
    const id = String(msg.id ?? '');
    const u = msg.usage ?? {};
    const tok = Number(u.input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0) + Number(u.output_tokens ?? 0);
    const ids = sub ? sub.msgIds : this.msgIds;
    if (id && !ids.has(id)) {
      ids.add(id);
      if (Number.isFinite(tok)) { this.tokens += tok; if (sub) sub.tokens += tok; }
      const c = costOf(String(msg.model ?? ''), u);
      const all = tok + Number(u.cache_read_input_tokens ?? 0);
      const day = dayOf(at);
      if (c === null) { this.costUnknown += all; if (sub) sub.costUnknown += all; this.unknownDays.add(day); }
      else if (Number.isFinite(c)) { this.cost += c; if (sub) sub.cost += c; this.costByDay.set(day, (this.costByDay.get(day) ?? 0) + c); }
    }
    if (sub) {
      // un sous-agent qu'on croyait fini reprend (relancé par le chef)
      if (sub.status !== 'working' && at > (sub.endedAt ?? 0) && Array.isArray(msg.content) && msg.content.some((c: Json) => c?.type === 'tool_use')) {
        sub.status = 'working'; sub.endedAt = undefined; sub.endTurn = false; sub.hired = false;
        this.names.delete(sub.name);
        this.hire(sub.id, sub.type, sub.task, at);
      }
    }
    const content: Json[] = Array.isArray(msg.content) ? msg.content : [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text') {
        const text = String(c.text ?? '');
        if (!text.trim()) continue;
        if (!sub) { this.lastChefText = text.slice(0, 4000); this.collectLinks(text); }
        if (sub) sub.lastText = text;
        if (this.opts.snippets) {
          // la bulle garde la première phrase ; le fil de la salle reçoit un passage plus long (caviardé)
          const s = firstSentence(text, 100);
          const long = passage(text, 700);
          if (s || long) this.emit(at, { k: 'say', who: sub ? sub.id : 'chef', text: s || firstSentence(long, 100), ...(long && long !== s ? { long } : {}) });
        }
      } else if (c.type === 'thinking') {
        // la réflexion n'est presque jamais lisible (seule une signature est gardée) ; quand un résumé est écrit, on le montre
        const text = this.opts.snippets ? passage(c.thinking, 500) : '';
        if (text) this.emit(at, { k: 'think', who: sub ? sub.id : 'chef', text });
      } else if (c.type === 'tool_use') {
        this.toolUse(c, sub, at);
      }
    }
    const stop = msg.stop_reason;
    if (sub) {
      sub.endTurn = stop === 'end_turn';
      return;
    }
    if (stop === 'end_turn') {
      if (id !== this.lastEndMsg) {
        this.lastEndMsg = id;
        this.endTurnAt = at;
        this.pending.clear();
        this.emit(at, { k: 'end', ok: true, text: '', ms: Math.max(0, at - (this.turnStartAt || at)) });
      }
    } else if (stop === 'tool_use') {
      this.endTurnAt = null;
    }
  }

  private toolUse(c: Json, sub: SubState | null, at: number) {
    const name = String(c.name ?? '');
    const id = String(c.id ?? '');
    const input = (c.input && typeof c.input === 'object' ? c.input : {}) as Json;
    this.tools++;
    if (sub) sub.tools++;
    if (name === 'Agent' || name === 'Task') {
      const child = this.hire(id, String(input.subagent_type ?? ''), String(input.description ?? ''), at);
      const bg = input.run_in_background;
      if (bg === true || bg === 'true') child.background = true;
      if (!sub) { this.wrapUp = null; this.endTurnAt = null; this.lastAct = `J’appelle ${child.name}`; }
      return;
    }
    if (!sub && this.planTool(name, input, at)) { this.wrapUp = null; return; }
    this.collectShots(name, input);
    const act = safeAct(name, input, this.cwd);
    const who = sub ? sub.id : 'chef';
    this.emit(at, { k: 'act', who, id, kind: act.kind, tool: safe(name, 60), label: act.label, detail: act.detail });
    if (sub) {
      sub.pending.set(id, { name, at, kind: act.kind });
      sub.lastAct = act.label;
      sub.endTurn = false;
      return;
    }
    this.pending.set(id, { name, at, kind: act.kind });
    this.lastAct = act.label;
    this.endTurnAt = null;
    if (name === 'mcp__ccd_turn__wrap_up') {
      this.wrapUp = { ask: !!(input.ask || input.blocked), at };
      if (typeof input.recap === 'string' && input.recap.trim()) this.recap = input.recap.slice(0, 2000);
      const d = this.wrapUp.ask ? decisionOfWrapUp(input, this.lastChefText) : null;
      if (d) this.lastDecision = d;
    } else if (name === 'AskUserQuestion') {
      const d = decisionOfQuestion(input, this.lastChefText);
      if (d) this.lastDecision = d;
    } else if (name === 'ExitPlanMode') {
      this.lastDecision = decisionOfPlan(input);
    }
    if ((name === 'Write' || name === 'NotebookEdit') && typeof (input.file_path ?? input.notebook_path) === 'string') {
      const f = String(input.file_path ?? input.notebook_path);
      if (DELIVERABLE.test(f) && this.files.size < 12) this.files.add(path.basename(f));
    }
    // un autre outil après la fin de tour : la session a repris (le wrap_up lui-même ne s'efface pas)
    if (name !== 'mcp__ccd_turn__wrap_up') this.wrapUp = null;
  }

  /** Les outils de plan du chef. Renvoie vrai si l'outil a été traité ici. */
  private planTool(name: string, i: Json, at: number): boolean {
    const before = JSON.stringify(this.plan);
    const doneBefore = this.plan.filter((p) => p.status === 'completed').length;
    if (name === 'TodoWrite') {
      const todos: Json[] = Array.isArray(i.todos) ? i.todos : [];
      this.plan = todos.map((t) => ({ text: safe(t.content ?? t.activeForm ?? '', 90), status: planStatus(t.status) }));
      this.taskIds = [];
    } else if (name === 'mcp__ccd_turn__update_plan') {
      if (Array.isArray(i.items)) {
        this.plan = (i.items as Json[]).map((t) => ({ text: safe(t.content ?? t.text ?? '', 90), status: planStatus(t.status) }));
        this.taskIds = [];
      }
      if (i.advance) {
        const cur = this.plan.findIndex((p) => p.status === 'in_progress');
        if (cur >= 0) this.plan[cur].status = 'completed';
        const next = this.plan.findIndex((p, j) => j > cur && p.status === 'pending');
        if (next >= 0) this.plan[next].status = 'in_progress';
      }
      if (Array.isArray(i.done)) for (const n of i.done) { const p = this.plan[Number(n) - 1]; if (p) p.status = 'completed'; }
      if (i.start != null) { const p = this.plan[Number(i.start) - 1]; if (p) p.status = 'in_progress'; }
    } else if (name === 'TaskCreate') {
      this.plan.push({ text: safe(i.subject ?? i.content ?? i.description ?? '', 90), status: 'pending' });
      this.taskIds.push(String(++this.taskSeq));
    } else if (name === 'TaskUpdate') {
      const idx = this.taskIds.indexOf(String(i.taskId ?? ''));
      if (idx >= 0) {
        if (i.status === 'deleted') { this.plan.splice(idx, 1); this.taskIds.splice(idx, 1); }
        else if (i.status) this.plan[idx].status = planStatus(i.status);
        if (typeof i.subject === 'string') this.plan[idx] && (this.plan[idx].text = safe(i.subject, 90));
      }
    } else return false;
    this.lastAct = 'Je mets le plan à jour';
    const newlyDone = this.plan.filter((p) => p.status === 'completed').length - doneBefore;
    if (newlyDone > 0) { const d = dayOf(at); this.doneByDay.set(d, (this.doneByDay.get(d) ?? 0) + newlyDone); }
    if (JSON.stringify(this.plan) !== before) this.emit(at, { k: 'plan', items: this.plan.map((p) => ({ ...p })) });
    return true;
  }

  private user(m: Json, sub: SubState | null, at: number) {
    const content = m.message?.content;
    if (Array.isArray(content)) {
      for (const c of content as Json[]) {
        if (c?.type !== 'tool_result') continue;
        const id = String(c.tool_use_id ?? '');
        const ok = !c.is_error;
        const child = this.subs.get(id);
        if (child) {
          const r = (m.toolUseResult ?? {}) as Json;
          if (r.isAsync || r.status === 'async_launched') child.background = true;
          else this.finishSub(child, ok && r.status !== 'failed', at);
          continue;
        }
        if (!sub) this.collectLinks(typeof c.content === 'string' ? c.content : userText(c.content));
        const owner = sub ? sub.pending : this.pending;
        const was = owner.get(id);
        // la question ou le plan a reçu sa réponse : la décision n'attend plus
        if (!sub && (was?.name === 'AskUserQuestion' || was?.name === 'ExitPlanMode')) this.lastDecision = null;
        if (owner.delete(id)) this.emit(at, { k: 'act_done', who: sub ? sub.id : 'chef', id, ok });
      }
    }
    if (sub || m.isMeta || m.toolUseResult !== undefined) return;
    // une tâche planifiée (la consigne que tu as enregistrée) compte comme ta demande ; les autres messages système non
    const scheduled = m.origin?.kind === 'task-notification' && m.origin?.subkind === 'scheduled-trigger';
    if (!scheduled && (m.promptSource === 'system' || (m.origin && m.origin.kind && m.origin.kind !== 'human'))) return;
    const raw = userText(content);
    if (!raw) return;
    const isCommand = raw.includes('<command-name>');
    const text = raw.replace(TAG_BLOCKS, ' ').trim();
    if (/^\[Request interrupted/.test(text)) {
      this.pending.clear();
      this.endTurnAt = at;
      this.emit(at, { k: 'end', ok: false, text: '', ms: Math.max(0, at - (this.turnStartAt || at)), stopped: true });
      return;
    }
    if (!text && !isCommand) return;
    if (!this.firstPrompt && text) this.firstPrompt = promptTitle(text);
    if (text) {
      this.requestCount++;
      if (!this.firstRequest) { this.firstRequest = text.slice(0, 12_000); this.firstRequestAt = at; }
      else { this.lastRequest = text.slice(0, 12_000); this.lastRequestAt = at; }
    }
    this.turnStartAt = at;
    this.endTurnAt = null;
    this.wrapUp = null;
    this.lastDecision = null;
    this.pending.clear();
    this.emit(at, { k: 'start', text: 'Nouveau message' });
  }

  // ── Statut (dépend du temps : recalculé à chaque passage) ──

  computeStatus(now: number): { status: SessionStatus; text: string } {
    if (this.desktop?.archived) return { status: 'done', text: 'Archivée' };
    // sous-agents silencieux depuis trop longtemps : on les considère comme partis
    for (const s of this.subs.values()) {
      if (s.status === 'working' && now - s.lastLineAt > SUB_IDLE_MS) this.finishSub(s, true, s.lastLineAt);
    }
    const active = [...this.subs.values()].filter((s) => s.status === 'working').length;
    const pend = [...this.pending.values()];
    const idle = now - this.lastActivity;
    if ((this.apiErrors >= 2 || (this.apiErrors >= 1 && this.apiErrorKind === 'rate_limit')) && idle < END_TURN_WAIT_MS) {
      return { status: 'blocked', text: this.apiErrorKind === 'rate_limit' ? 'Limite d’usage atteinte' : 'Erreurs de l’API en série' };
    }
    // le processus Claude Code s'est arrêté (ligne cost-state en fin de fichier)
    if (this.exited) {
      if (this.wrapUp?.ask) return { status: 'waiting', text: 'Attend ta réponse' };
      return { status: 'done', text: 'Terminée' };
    }
    if (pend.some((p) => p.name === 'AskUserQuestion' || p.name === 'ExitPlanMode')) return { status: 'waiting', text: 'Attend ta réponse' };
    if (active > 0) return { status: 'working', text: active > 1 ? `${active} sous-agents au travail` : '1 sous-agent au travail' };
    const live = pend.filter((p) => p.name !== 'mcp__ccd_turn__wrap_up');
    if (live.length && idle < END_TURN_WAIT_MS) {
      const oldest = live.reduce((a, b) => (a.at <= b.at ? a : b));
      const age = now - oldest.at;
      if (age > PENDING_BLOCKED_MS) return { status: 'blocked', text: `Bloquée depuis ${agoMin(age)} min : permission ou commande en attente ?` };
      const base = busyText(oldest.kind, oldest.name);
      return { status: 'working', text: age >= 2 * MIN ? `${base} depuis ${agoMin(age)} min` : base };
    }
    if (this.wrapUp) return this.wrapUp.ask ? { status: 'waiting', text: 'Attend ta réponse' } : { status: 'done', text: 'Terminée' };
    // un tour fini sans question n'attend rien de toi : la salle est « terminée » (elle reprend si tu écris)
    if (this.endTurnAt) return { status: 'done', text: now - this.endTurnAt < END_TURN_WAIT_MS ? 'Tour terminé' : 'Terminée' };
    if (idle < WORKING_RECENT_MS) return { status: 'working', text: 'Au travail' };
    if (idle < SILENT_DONE_MS) return { status: 'blocked', text: `Silencieuse depuis ${agoMin(idle)} min` };
    return { status: 'done', text: 'Inactive' };
  }

  /** Recalcule le statut ; renvoie vrai s'il a changé depuis le dernier envoi. */
  refreshStatus(now: number): boolean {
    const { status, text } = this.computeStatus(now);
    this.status = status;
    this.statusText = text;
    const sig = `${status}|${text}`;
    if (sig !== this.statusSig) { this.dirty = true; return true; }
    return false;
  }

  markSent() { this.statusSig = `${this.status}|${this.statusText}`; this.dirty = false; }

  // ── Résumé ──

  projectInfo(): { project: string; worktree?: string } {
    const cwd = untilde(this.cwd || '');
    if (!cwd) return { project: 'Projet inconnu' };
    const wt = /^(.*?)\/\.claude\/worktrees\/([^/]+)/.exec(cwd);
    if (wt) {
      const repo = wt[1].split('/').filter(Boolean).pop() || '~';
      return { project: safe(repo, 60), worktree: safe(wt[2], 60) };
    }
    const last = cwd.split('/').filter(Boolean).pop() || '~';
    return { project: safe(last, 60) };
  }

  summary(): SessionSummary {
    const { project, worktree } = this.projectInfo();
    const subs = [...this.subs.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_SUBAGENTS_LISTED);
    const s: SessionSummary = {
      key: this.key,
      sourceId: this.opts.sourceId,
      sessionId: this.sessionId,
      title: this.title(),
      doing: this.doing(),
      cost: costValue(this.cost, this.costUnknown),
      project,
      status: this.status,
      statusText: this.statusText,
      startedAt: this.startedAt || this.lastActivity,
      lastActivity: Math.max(this.lastActivity, ...[...this.subs.values()].filter((x) => x.status === 'working').map((x) => x.lastLineAt)),
      plan: this.plan.map((p) => ({ ...p })),
      subagents: subs.map((x) => {
        const o: SubagentSummary = { id: x.id, type: safe(x.type, 40), task: x.task, status: x.status, startedAt: x.startedAt, tokens: x.tokens, tools: x.tools };
        if (x.endedAt) o.endedAt = x.endedAt;
        if (x.lastAct) o.lastAct = x.lastAct;
        o.cost = costValue(x.cost, x.costUnknown);
        if (x.background) o.background = true;
        return o;
      }),
      activeSubagents: [...this.subs.values()].filter((x) => x.status === 'working').length,
      tokens: this.tokens,
      tools: this.tools,
    };
    if (worktree) s.worktree = worktree;
    if (this.branch) s.branch = safe(this.branch, 80);
    if (this.entrypoint) s.entrypoint = safe(this.entrypoint, 30);
    if (this.model) s.model = safe(this.model, 40);
    if (this.lastAct) s.lastAct = this.lastAct;
    if (this.prUrl) s.prUrl = this.prUrl;
    if (this.status === 'waiting' && this.lastDecision) s.decision = this.lastDecision;
    if (this.status === 'waiting' && this.media.length) s.media = this.media;
    if (this.costUnknown > 0 && this.cost > 0) s.costPartial = true;
    if (this.parentKey) s.parentKey = this.parentKey;
    if (this.childKeys.length) s.childKeys = [...this.childKeys];
    if (this.opts.shareRequest && this.firstRequest) {
      const first = summarize(this.firstRequest, this.opts.aiSummary);
      if (first.text) {
        s.request = { first: first.text, firstAt: this.firstRequestAt, count: this.requestCount, kind: first.kind };
        if (this.lastRequest) {
          const last = summarize(this.lastRequest, this.opts.aiSummary);
          if (last.text) { s.request.last = last.text; s.request.lastAt = this.lastRequestAt; if (last.kind === 'extrait') s.request.kind = 'extrait'; }
        }
      }
    }
    return s;
  }

  /** Ta demande de départ, brute (en mémoire seulement : sert au résumé du fil par Haiku, jamais envoyée telle quelle). */
  get requestText() { return this.firstRequest; }

  /** Les images de la session : fichiers joints à un message (outil de réponse d'un canal, champ files), images lues. */
  private collectShots(name: string, input: Json) {
    const add = (p: unknown, sent: boolean, caption?: string) => {
      if (typeof p !== 'string' || !IMAGE.test(p) || !path.isAbsolute(p) || this.shots.length >= 40) return;
      const old = this.shots.find((x) => x.path === p);
      if (old) { if (sent && !old.sent) { old.sent = true; old.caption = caption; } return; }
      this.shots.push({ path: p, sent, caption });
    };
    if (Array.isArray(input.files)) {
      const caption = typeof input.text === 'string' ? input.text.split('\n').map((l: string) => l.trim()).find((l: string) => l.length > 2) : undefined;
      for (const f of input.files) add(typeof f === 'string' ? f : (f as Json)?.path, true, caption);
    }
    if (name === 'Read') add(input.file_path, false);
  }

  /** Les liens utiles repérés dans la session : PR GitHub, artefacts claude.ai. */
  private collectLinks(text: string) {
    if (!text || this.links.size >= 8) return;
    for (const m of text.matchAll(LINK_RE)) { if (this.links.size < 8) this.links.add(m[0].replace(/[).,;'"»]+$/, '')); }
  }

  /** Le dossier où Claude Code range les résultats d'outils de la session (dont les captures du navigateur). */
  get toolResultsDir() { return path.join(path.dirname(this.file), this.sessionId, 'tool-results'); }

  /** Le plan est fini (toutes les tâches cochées). */
  get planComplete() { return this.plan.length > 0 && this.plan.every((p) => p.status === 'completed'); }

  title(): string {
    const t = this.customTitle || this.desktop?.title || '';
    return clean(t ? safe(t, 70) : this.firstPrompt) || 'Session sans titre';
  }

  /** « Ce que je fais » : la tâche du plan en cours, sinon la prochaine à faire, sinon le titre. */
  doing(): string {
    const cur = this.plan.find((p) => p.status === 'in_progress') ?? (this.status !== 'done' ? this.plan.find((p) => p.status === 'pending') : undefined);
    return (cur && clean(cur.text)) || this.title();
  }
}


/**
 * Le titre d'une session sans titre, tiré de son premier message : son début, coupé et caviardé.
 */
function promptTitle(text: string): string {
  return safe(untilde(text), 70);
}

// ── Les décisions : ce que la session te demande, avec ses choix (tout est caviardé et coupé ici) ──

const opt = (label: unknown, effect: unknown) => {
  const l = safe(label, 80);
  const e = typeof effect === 'string' ? safe(effect, 240) : '';
  return l ? { label: l, ...(e && e !== l ? { effect: e } : {}) } : null;
};

/** La fin de tour avec une question (wrap_up) : la question, le compte rendu en contexte, les réponses proposées. */
function decisionOfWrapUp(i: Json, lastText: string): Decision | null {
  const question = safe(typeof i.ask === 'string' ? i.ask : i.blocked === true ? 'La session est bloquée et attend ton aide.' : String(i.blocked ?? ''), 240);
  if (!question) return null;
  const actions: Json[] = Array.isArray(i.actions) ? i.actions : [];
  const context = passage(typeof i.recap === 'string' && i.recap.trim() ? i.recap : lastText, 900);
  const d: Decision = { question, options: actions.map((a) => opt(a?.label, a?.message)).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 5), from: 'fin-de-tour' };
  if (context) d.context = context;
  return d;
}

/** Une question posée par l'outil AskUserQuestion : la (ou les) question(s) et leurs choix, avec leur explication. */
function decisionOfQuestion(i: Json, lastText: string): Decision | null {
  const qs: Json[] = Array.isArray(i.questions) ? i.questions : [];
  if (!qs.length) return null;
  const first = qs[0];
  const question = safe(first?.question ?? first?.header ?? '', 240);
  if (!question) return null;
  const options = (Array.isArray(first?.options) ? first.options as Json[] : []).map((o) => opt(o?.label, o?.description)).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 6);
  const more = qs.slice(1).map((q) => safe(q?.question ?? q?.header ?? '', 160)).filter(Boolean);
  const context = passage(lastText, 900);
  const d: Decision = { question, options, from: 'question' };
  if (context) d.context = context;
  if (more.length) d.why = `Autres questions posées en même temps : ${more.join(' ; ')}`;
  return d;
}

/** Un plan à valider (ExitPlanMode) : le plan lui-même en contexte. */
function decisionOfPlan(i: Json): Decision {
  const plan = passage(i.plan, 1400);
  const d: Decision = {
    question: 'Valider le plan proposé avant que l’agent commence ?',
    why: 'L’agent ne modifie rien tant que le plan n’est pas validé.',
    options: [
      { label: 'Valider le plan', effect: 'L’agent démarre le travail tel que décrit.' },
      { label: 'Demander des changements', effect: 'L’agent revoit le plan avec tes remarques avant de commencer.' },
    ],
    from: 'plan',
  };
  if (plan) d.context = plan;
  return d;
}

/** Une image de la session : son chemin sur le Mac, envoyée (jointe à un message) ou seulement regardée, et sa légende. */
export interface Shot { path: string; sent: boolean; caption?: string }
const IMAGE = /\.(png|jpe?g|webp)$/i;

/** Ce que l'app desktop écrit sur une session (seuls les champs utiles, jamais le texte des tours). */
export interface DesktopMeta { localId: string; parentLocalId?: string; title?: string; archived: boolean }

/** Le coût affiché : null si rien n'a pu être compté parce que le modèle est inconnu. */
function costValue(cost: number, unknown: number): number | null {
  if (cost > 0) return Math.round(cost * 10000) / 10000;
  return unknown > 0 ? null : 0;
}

/** Retire ce qui ne parle qu'aux machines : numéros d'issue ou de PR (« #123 »). */
export function clean(t: string): string {
  return t
    .replace(/\s*\((?:#\d{2,6}[,\s]*)+\)/g, '')
    .replace(/(^|\s)#\d{2,6}\b\s*[·:-]?\s*/g, '$1')
    .replace(/^\d{3,6} est (ferm[ée]e|fini[e]?|termin[ée]e)\s*:\s*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Minuit (heure de la machine) du jour d'un instant. */
export function dayOf(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Les fichiers qui sont des livrables (pas du code) : documents, images, vidéos, tableaux. */
const DELIVERABLE = /\.(md|pdf|html?|docx?|pptx?|xlsx?|csv|png|jpe?g|webp|gif|svg|mp4|mov|webm|mp3)$/i;
const LINK_RE = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|claude\.ai\/(?:code\/)?artifact\/[\w-]+)/g;
