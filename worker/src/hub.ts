// Le Hub : un seul Durable Object qui garde l'état en direct de toutes les salles (sessions) de toutes les
// sources, et le diffuse aux navigateurs connectés (WebSockets « hibernables »).
//
// Sauvegarde : dans le bucket R2 privé plutôt que dans le SQLite du Durable Object, dont le quota gratuit (100 000 lignes
// écrites par jour) s'épuise vite. Dans R2 :
//   hub/state.json.gz        les salles, le bandeau, le fil (au plus une écriture par minute)
//   hub/logs/<salle>.json.gz le journal d'une salle (au plus toutes les 3 min tant qu'il bouge, tout de suite à la fin)
// Les journaux sont chargés à la demande (entrée dans une salle, nouvel événement).
import { DurableObject } from 'cloudflare:workers';
import type { OfficeEvent } from '../../shared/protocol.ts';
import {
  DONE_VISIBLE_MS, ROOM_LOG_MAX,
  type DayStats, type FeedEntry, type IngestPayload, type IngestReply, type LiveClientMsg, type LiveServerMsg, type SessionSummary, type SourceInfo,
} from '../../shared/live.ts';
import type { Env } from './index.ts';

type Log = { at: number; ev: OfficeEvent }[];
interface Attachment { watch: string | null }

/** Au-delà, une salle est oubliée (même plus ouvrable). */
const FORGET_MS = 3 * 24 * 3600_000;
const STATE_EVERY_MS = 60_000;
const LOG_EVERY_MS = 3 * 60_000;
const STATE_KEY = 'hub/state.json.gz';
const logKey = (k: string) => `hub/logs/${encodeURIComponent(k)}.json.gz`;

interface Saved {
  at: number; sources: SourceInfo[]; sessions: SessionSummary[]; archived: string[];
  days: [string, DayStats][]; feeds: [string, FeedEntry[]][];
}

async function gzipJson(v: unknown): Promise<ArrayBuffer> {
  const body = new Blob([JSON.stringify(v)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(body).arrayBuffer();
}
async function gunzipJson<T>(obj: R2ObjectBody): Promise<T> {
  return new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).json<T>();
}

export class Hub extends DurableObject<Env> {
  private sessions = new Map<string, SessionSummary>();
  /** les salles terminées qui ne sont plus à l'étage mais gardées (elles sont au fil des réalisations) : ouvrables 3 jours */
  private archived = new Set<string>();
  private sources = new Map<string, SourceInfo>();
  private days = new Map<string, DayStats>();
  private feeds = new Map<string, FeedEntry[]>();
  /** les journaux chargés en mémoire (les autres sont dans R2) */
  private logs = new Map<string, Log>();
  private loading = new Map<string, Promise<void>>();
  private dirtyLogs = new Set<string>();
  private logWrittenAt = new Map<string, number>();
  private stateDirty = false;
  private stateWrittenAt = 0;
  /** les sources dont on a reçu la liste complète depuis le démarrage (sinon : on la demande, réponse « cold ») */
  private fullSeen = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      try {
        const obj = await env.MEDIA.get(STATE_KEY);
        if (obj) { this.restore(await gunzipJson<Saved>(obj)); return; }
      } catch (e) { console.log('état R2 illisible :', String((e as Error)?.message ?? e).slice(0, 200)); }
    });
  }

  private restore(s: Saved) {
    for (const x of s.sessions ?? []) if (x?.key) this.sessions.set(x.key, x);
    for (const k of s.archived ?? []) if (this.sessions.has(k)) this.archived.add(k);
    for (const x of s.sources ?? []) this.sources.set(x.id, x);
    for (const [k, v] of s.days ?? []) this.days.set(k, v);
    for (const [k, v] of s.feeds ?? []) this.feeds.set(k, v);
    this.stateWrittenAt = s.at ?? 0;
  }

  // ── Les journaux, chargés à la demande ──

  private loadLog(key: string): Promise<void> {
    if (this.logs.has(key)) return Promise.resolve();
    let p = this.loading.get(key);
    if (p) return p;
    p = (async () => {
      let log: Log = [];
      try {
        const obj = await this.env.MEDIA.get(logKey(key));
        if (obj) log = await gunzipJson<Log>(obj);
      } catch { /* pas de journal gardé */ }
      // des événements ont pu arriver pendant le chargement : on les garde après l'ancien journal
      const fresh = this.logs.get(key) ?? [];
      const merged = [...log, ...fresh].slice(-ROOM_LOG_MAX);
      this.logs.set(key, merged);
      this.loading.delete(key);
    })();
    this.loading.set(key, p);
    return p;
  }

  // ── Requêtes ──

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ watch: null } satisfies Attachment);
      // les salles et le bandeau d'abord (petit message, affiché tout de suite), puis le fil (plus gros)
      this.send(server, { t: 'hello', build: this.env.CF_VERSION_METADATA?.id, sources: this.sourceList(), sessions: this.visible(), day: this.mergedDay() });
      this.send(server, { t: 'feed', feed: this.mergedFeed() });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/ingest') {
      let p: IngestPayload;
      try { p = (await request.json()) as IngestPayload; } catch { return new Response('JSON illisible', { status: 400 }); }
      if (!p?.source?.id || !Array.isArray(p.sessions) || !Array.isArray(p.events)) return new Response('Format inattendu', { status: 400 });
      const sourceId = String(p.source.id).slice(0, 64);
      await this.ingest(p, sourceId);
      // le collecteur règle sa cadence d'envoi sur le nombre de navigateurs ouverts (5 s si quelqu'un regarde, 15 à 60 s sinon)
      const reply: IngestReply = { ok: true, viewers: this.ctx.getWebSockets().length };
      if (!this.fullSeen.has(sourceId)) reply.cold = true;
      this.maybeSave(Date.now());
      return Response.json(reply);
    }
    return new Response('Introuvable', { status: 404 });
  }

  private feedKeys(): Set<string> {
    const s = new Set<string>();
    for (const list of this.feeds.values()) for (const e of list) s.add(e.key);
    return s;
  }

  private async ingest(p: IngestPayload, sourceId: string) {
    const now = Date.now();
    const label = String(p.source.label || sourceId).slice(0, 60);
    if (this.sources.get(sourceId)?.label !== label) this.stateDirty = true;
    this.sources.set(sourceId, { id: sourceId, label, seenAt: now });

    // les journaux qui vont recevoir des événements : chargés d'abord, pour ne pas écraser l'ancien avec un journal partiel
    const keys = new Set(p.events.filter((e) => e?.key).map((e) => e.key));
    await Promise.all([...keys].map((k) => this.loadLog(k)));

    if (Array.isArray(p.feed)) {
      this.feeds.set(sourceId, p.feed.slice(0, 500));
      this.stateDirty = true;
      this.broadcast({ t: 'feed', feed: this.mergedFeed() });
    }

    const touched = new Set<string>();
    for (const s of p.sessions) {
      if (!s?.key || s.sourceId !== sourceId) continue;
      this.sessions.set(s.key, s);
      this.archived.delete(s.key);
      touched.add(s.key);
    }
    const drop = new Set<string>((p.removed ?? []).filter((k) => typeof k === 'string' && k.startsWith(sourceId + ':')));
    if (p.full) {
      for (const [k, s] of this.sessions) if (s.sourceId === sourceId && !touched.has(k) && !this.archived.has(k)) drop.add(k);
      this.fullSeen.add(sourceId);
    }
    // une salle qui quitte l'étage reste ouvrable si elle est au fil des réalisations (3 jours après sa dernière activité)
    const kept = this.feedKeys();
    for (const k of drop) {
      if (kept.has(k)) { this.archived.add(k); this.dirtyLogs.add(k); this.logWrittenAt.set(k, 0); }
      else this.forget(k);
    }

    for (const e of p.events) {
      if (!e?.key || !e.ev || !this.sessions.has(e.key)) continue;
      const log = this.logs.get(e.key) ?? [];
      log.push({ at: Number(e.at) || now, ev: e.ev });
      if (log.length > ROOM_LOG_MAX) log.splice(0, log.length - ROOM_LOG_MAX);
      this.logs.set(e.key, log);
      this.dirtyLogs.add(e.key);
      this.broadcastEv(e.key, Number(e.at) || now, e.ev);
    }

    for (const [k, s] of this.sessions) if (now - s.lastActivity > FORGET_MS) { this.forget(k); drop.add(k); }

    if (p.day && typeof p.day === 'object') {
      const before = JSON.stringify(this.days.get(sourceId) ?? null);
      this.days.set(sourceId, p.day);
      if (JSON.stringify(p.day) !== before) { this.stateDirty = true; this.broadcast({ t: 'day', day: this.mergedDay() }); }
    }
    if (touched.size || drop.size) { this.stateDirty = true; this.broadcast({ t: 'sessions', sources: this.sourceList(), sessions: this.visible() }); }
  }

  private forget(key: string) {
    this.sessions.delete(key);
    this.archived.delete(key);
    this.logs.delete(key);
    this.dirtyLogs.delete(key);
    this.logWrittenAt.delete(key);
    void this.env.MEDIA.delete(logKey(key)).catch(() => { /* déjà absent */ });
  }

  // ── Sauvegarde dans R2 ──

  /** Écrit ce qui est dû (l'état au plus une fois par minute, chaque journal au plus toutes les 3 min), sinon programme
   *  un réveil pour le faire. Les écritures partent en fond : la réponse au collecteur n'attend pas. */
  private maybeSave(now: number, force = false) {
    const jobs: Promise<unknown>[] = [];
    if (this.stateDirty && (force || now - this.stateWrittenAt >= STATE_EVERY_MS)) jobs.push(this.saveState(now));
    for (const k of [...this.dirtyLogs]) {
      if (now - (this.logWrittenAt.get(k) ?? 0) < LOG_EVERY_MS) continue;
      const log = this.logs.get(k);
      this.dirtyLogs.delete(k);
      this.logWrittenAt.set(k, now);
      if (log) jobs.push(gzipJson(log).then((b) => this.env.MEDIA.put(logKey(k), b)).catch((e) => { this.dirtyLogs.add(k); console.log('journal non écrit :', String(e).slice(0, 120)); }));
    }
    if (jobs.length) this.ctx.waitUntil(Promise.all(jobs));
    if (this.stateDirty || this.dirtyLogs.size) {
      void this.ctx.storage.getAlarm().then((a) => (a === null ? this.ctx.storage.setAlarm(now + STATE_EVERY_MS) : undefined)).catch(() => { /* on réessaiera */ });
    }
  }

  private async saveState(now: number) {
    this.stateDirty = false;
    this.stateWrittenAt = now;
    const s: Saved = {
      at: now, sources: this.sourceList(), sessions: [...this.sessions.values()], archived: [...this.archived],
      days: [...this.days], feeds: [...this.feeds],
    };
    try { await this.env.MEDIA.put(STATE_KEY, await gzipJson(s)); }
    catch (e) { this.stateDirty = true; console.log('état non écrit :', String(e).slice(0, 120)); }
  }

  async alarm() {
    const now = Date.now();
    // au réveil par l'alarme, rien ne reste « dû » en mémoire si le Hub a redémarré entre-temps : rien à écrire
    this.maybeSave(now);
  }

  // ── Ce qu'on envoie aux navigateurs ──

  /** Les salles affichées : tout sauf les sessions terminées depuis longtemps et les salles gardées pour le fil. */
  private visible(): SessionSummary[] {
    const now = Date.now();
    return [...this.sessions.values()]
      .filter((s) => !this.archived.has(s.key) && (s.status !== 'done' || now - s.lastActivity < DONE_VISIBLE_MS))
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  private sourceList(): SourceInfo[] { return [...this.sources.values()]; }

  /** Le bandeau de toutes les sources réunies. */
  private mergedDay(): DayStats | null {
    const list = [...this.days.entries()];
    if (!list.length) return null;
    if (list.length === 1) return list[0][1];
    const out: DayStats = { day: 0, tasksDone: 0, sessionsDone: 0, cost: 0 };
    for (const [, d] of list) {
      out.day = Math.max(out.day, d.day);
      out.tasksDone += d.tasksDone; out.sessionsDone += d.sessionsDone; out.cost += d.cost;
      if (d.costPartial) out.costPartial = true;
    }
    const totals = list.map(([, d]) => d.total).filter((t): t is NonNullable<DayStats['total']> => !!t);
    if (totals.length) {
      out.total = { since: Math.min(...totals.map((t) => t.since)), input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, unknown: 0,
        partial: totals.some((t) => t.partial), sources: totals.length, expectedSources: Math.max(...totals.map((t) => t.expectedSources), totals.length) };
      for (const t of totals) { out.total.input += t.input; out.total.output += t.output; out.total.cacheWrite += t.cacheWrite; out.total.cacheRead += t.cacheRead; out.total.cost += t.cost; out.total.unknown += t.unknown; }
      out.total.cost = Math.round(out.total.cost * 100) / 100;
    }
    // un jour qui n'est plus aujourd'hui ne compte plus (une source éteinte depuis hier)
    for (const [, d] of list) if (d.day < out.day) { out.tasksDone -= d.tasksDone; out.sessionsDone -= d.sessionsDone; out.cost -= d.cost; }
    out.cost = Math.round(out.cost * 100) / 100;
    return out;
  }

  private mergedFeed(): FeedEntry[] {
    return [...this.feeds.values()].flat().sort((a, b) => b.at - a.at).slice(0, 600);
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    let m: LiveClientMsg;
    try { m = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return; }
    if (m?.t !== 'watch') return;
    const key = typeof m.key === 'string' && this.sessions.has(m.key) ? m.key : null;
    ws.serializeAttachment({ watch: key } satisfies Attachment);
    if (key) {
      await this.loadLog(key);
      this.send(ws, { t: 'room', session: this.sessions.get(key)!, log: this.logs.get(key) ?? [] });
    } else if (typeof m.key === 'string') this.send(ws, { t: 'gone', key: m.key.slice(0, 200) });
  }

  async webSocketClose(ws: WebSocket, code: number) { try { ws.close(code === 1005 ? 1000 : code, 'au revoir'); } catch { /* déjà fermée */ } }
  async webSocketError() { /* le navigateur se reconnecte tout seul */ }

  private send(ws: WebSocket, m: LiveServerMsg) { try { ws.send(JSON.stringify(m)); } catch { /* fermée */ } }

  private broadcast(m: LiveServerMsg) {
    const s = JSON.stringify(m);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch { /* fermée */ } }
  }

  private broadcastEv(key: string, at: number, ev: OfficeEvent) {
    const s = JSON.stringify({ t: 'ev', key, at, ev } satisfies LiveServerMsg);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.watch === key) { try { ws.send(s); } catch { /* fermée */ } }
    }
  }
}
