import { Agent } from 'agents';
import type { SessionEventEnvelope, SessionMetadata, SessionPromptRequest } from './session';

interface BruhEnv {
  BRUH_AGENT: DurableObjectNamespace;
  MEMORY_BUCKET: R2Bucket;
  RUNTIME_BASE_URL?: string;
  INTERNAL_API_SECRET?: string;
}

interface BruhState {
  sessionId: string;
  status: 'idle' | 'active';
  title?: string;
  createdAt: string;
  updatedAt: string;
  latestSeq: number;
}

const MAX_BUFFERED_EVENTS = 200;
const encoder = new TextEncoder();

function createSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 72) return normalized;
  return `${normalized.slice(0, 72).trimEnd()}…`;
}

function formatSse(event: SessionEventEnvelope): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

interface SseClient {
  id: string;
  write: (chunk: string) => Promise<void>;
  close: () => void;
}

export class BruhAgent extends Agent<BruhEnv, BruhState> {
  private sseClients = new Map<string, SseClient>();

  initialState: BruhState = {
    sessionId: '',
    status: 'idle',
    title: undefined as string | undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    latestSeq: 0,
  };

  async onStart(): Promise<void> {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS thread_registry (
        session_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )
    `;
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (`${request.method} ${url.pathname}`) {
      case 'POST /init':
        return this.handleInit(request);
      case 'GET /state':
        return this.handleState();
      case 'GET /events':
        return this.handleGetEvents(request);
      case 'GET /stream':
        return this.handleStream(request);
      case 'POST /prompt':
        return this.handlePrompt(request);
      case 'POST /steer':
        return this.handleQueuedCommand(request, 'steer');
      case 'POST /follow-up':
        return this.handleQueuedCommand(request, 'follow-up');
      case 'POST /abort':
        return this.handleAbort();
      case 'POST /events':
        return this.handleIncomingEvent(request);
      case 'POST /register-thread':
        return this.handleRegisterThread(request);
      case 'GET /threads':
        return this.handleListThreads();
      case 'POST /schedule':
        return this.handleSchedule(request);
      case 'GET /schedules':
        return this.handleListSchedules();
      case 'POST /cancel-schedule':
        return this.handleCancelSchedule(request);
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  // --- Session / thread init ---

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
      title?: string;
    };

    const requestedTitle = body.title?.trim();

    if (!this.state.sessionId) {
      const now = new Date().toISOString();
      this.setState({
        sessionId: body.sessionId || this.name || crypto.randomUUID(),
        status: 'idle',
        title: requestedTitle,
        createdAt: now,
        updatedAt: now,
        latestSeq: 0,
      });
    } else if (requestedTitle && !this.state.title) {
      this.setState({
        ...this.state,
        title: requestedTitle,
        updatedAt: new Date().toISOString(),
      });
    }

    const eventCount = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM events`[0]?.count ?? 0;
    if (eventCount === 0) {
      await this.appendEvent('session.created', { message: 'Session created' });
    }

    return Response.json(this.toMetadata());
  }

  private handleState(): Response {
    return Response.json(this.toMetadata());
  }

  // --- Thread registry (replaces SessionIndexDO) ---

  private async handleRegisterThread(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
      createdAt?: string;
    };
    const sessionId = body.sessionId?.trim();
    if (!sessionId) {
      return Response.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const existing = this.sql<{ session_id: string }>`
      SELECT session_id FROM thread_registry WHERE session_id = ${sessionId}
    `;
    if (existing.length === 0) {
      const createdAt = body.createdAt?.trim() || new Date().toISOString();
      this.sql`INSERT INTO thread_registry (session_id, created_at) VALUES (${sessionId}, ${createdAt})`;
    }

    return Response.json({ ok: true, sessionId });
  }

  private handleListThreads(): Response {
    const threads = this.sql<{ session_id: string; created_at: string }>`
      SELECT session_id, created_at FROM thread_registry ORDER BY created_at DESC
    `;
    const sessions = threads.map((t) => ({
      sessionId: t.session_id,
      createdAt: t.created_at,
    }));
    return Response.json({ sessions });
  }

  // --- Scheduling ---

  private async handleSchedule(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      message?: string;
      delaySeconds?: number;
      scheduledAt?: string;
      taskType?: 'task' | 'reminder';
    };

    const message = body.message?.trim();
    if (!message) {
      return Response.json({ error: 'message is required' }, { status: 400 });
    }

    const when = body.scheduledAt
      ? new Date(body.scheduledAt)
      : body.delaySeconds && body.delaySeconds > 0
        ? body.delaySeconds
        : null;

    if (!when) {
      return Response.json(
        { error: 'delaySeconds or scheduledAt is required' },
        { status: 400 },
      );
    }

    const taskType = body.taskType || 'task';
    const payload = JSON.stringify({ message, taskType });
    const schedule = await this.schedule(when, 'executeScheduledTask', payload);

    return Response.json({
      ok: true,
      scheduleId: schedule.id,
      message,
      taskType,
      type: schedule.type,
    });
  }

  private handleListSchedules(): Response {
    const schedules = this.getSchedules().map((s) => ({
      id: s.id,
      type: s.type,
      callback: s.callback,
      payload: s.payload,
      scheduledAt: s.time ? new Date(s.time).toISOString() : undefined,
    }));
    return Response.json({ schedules });
  }

  private async handleCancelSchedule(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { scheduleId?: string };
    const scheduleId = body.scheduleId?.trim();
    if (!scheduleId) {
      return Response.json({ error: 'scheduleId is required' }, { status: 400 });
    }

    const cancelled = await this.cancelSchedule(scheduleId);
    return Response.json({ ok: true, cancelled });
  }

  async executeScheduledTask(rawPayload: string): Promise<void> {
    let message: string;
    let taskType: 'task' | 'reminder';

    try {
      const parsed = JSON.parse(rawPayload) as { message?: string; taskType?: string };
      message = parsed.message || rawPayload;
      taskType = parsed.taskType === 'reminder' ? 'reminder' : 'task';
    } catch {
      message = rawPayload;
      taskType = 'task';
    }

    await this.appendEvent('schedule.fired', {
      message,
      taskType,
      firedAt: new Date().toISOString(),
    });

    if (taskType === 'task') {
      await this.forwardTextCommandToRuntime(this.state.sessionId, 'prompt', message);
    }
  }

  // --- Prompt / steer / follow-up / abort ---

  private async handlePrompt(request: Request): Promise<Response> {
    const body = (await request.json()) as SessionPromptRequest;
    const text = body.text?.trim();
    if (!text) {
      return Response.json({ error: 'text is required' }, { status: 400 });
    }

    this.maybeSetTitleFromText(text);
    await this.appendEvent('session.prompt.accepted', {
      text,
      message: 'Prompt accepted and queued for runtime processing',
    });

    this.ctx.waitUntil(this.forwardTextCommandToRuntime(this.state.sessionId, 'prompt', text));
    return Response.json({ ok: true, sessionId: this.state.sessionId, queued: true });
  }

  private async handleQueuedCommand(
    request: Request,
    kind: 'steer' | 'follow-up',
  ): Promise<Response> {
    const body = (await request.json()) as SessionPromptRequest;
    const text = body.text?.trim();
    if (!text) {
      return Response.json({ error: 'text is required' }, { status: 400 });
    }

    const result = await this.forwardTextCommandToRuntime(this.state.sessionId, kind, text);
    if (!result.ok) {
      return Response.json(
        { error: 'failed_to_queue', details: result.details },
        { status: result.status ?? 409 },
      );
    }

    const eventType =
      kind === 'steer' ? 'session.steer.accepted' : 'session.follow_up.accepted';
    await this.appendEvent(eventType, {
      text,
      message:
        kind === 'steer'
          ? 'Steering instruction accepted and queued'
          : 'Follow-up instruction accepted and queued',
    });

    return Response.json({ ok: true, sessionId: this.state.sessionId, queued: true });
  }

  private async handleAbort(): Promise<Response> {
    this.ctx.waitUntil(this.forwardAbortToRuntime(this.state.sessionId));
    return Response.json({ ok: true, sessionId: this.state.sessionId, requested: true });
  }

  // --- Incoming events from runtime ---

  private async handleIncomingEvent(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      type: string;
      timestamp?: string;
      payload?: Record<string, unknown>;
    };
    if (!body.type) {
      return Response.json({ error: 'type is required' }, { status: 400 });
    }

    if (body.type === 'session.status' && typeof body.payload?.status === 'string') {
      this.setSessionStatus(body.payload.status as 'idle' | 'active');
    }

    if (
      (body.type === 'session.prompt.accepted' || body.type === 'runtime.prompt.start') &&
      typeof body.payload?.text === 'string'
    ) {
      this.maybeSetTitleFromText(body.payload.text);
    }

    const event = await this.appendEvent(body.type, body.payload ?? {}, body.timestamp);
    return Response.json({ ok: true, seq: event.seq });
  }

  // --- Event buffering and SSE ---

  private async handleGetEvents(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const afterSeq = Number(url.searchParams.get('after') ?? '0') || 0;
    const events = this.getEventsAfter(afterSeq);
    return Response.json({ events });
  }

  private async handleStream(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const afterParam = url.searchParams.get('after');
    const lastEventId = request.headers.get('last-event-id');
    const afterSeq = Number(afterParam ?? lastEventId ?? '0') || 0;

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const clientId = crypto.randomUUID();
    let closed = false;
    let pending = Promise.resolve();

    const client: SseClient = {
      id: clientId,
      write: async (chunk: string) => {
        if (closed) return;
        pending = pending
          .then(() => writer.write(encoder.encode(chunk)))
          .catch(() => {
            closed = true;
            this.sseClients.delete(clientId);
          });
        await pending;
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.sseClients.delete(clientId);
        void writer.close().catch(() => undefined);
      },
    };

    this.sseClients.set(clientId, client);
    request.signal.addEventListener('abort', () => client.close(), { once: true });

    this.ctx.waitUntil(
      (async () => {
        const replay = this.getEventsAfter(afterSeq);
        await client.write(`: connected to ${this.state.sessionId}\n\n`);
        for (const event of replay) {
          await client.write(formatSse(event));
        }
      })().catch(() => client.close()),
    );

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
      },
    });
  }

  // --- Internal helpers ---

  private toMetadata(): SessionMetadata {
    return {
      sessionId: this.state.sessionId,
      createdAt: this.state.createdAt,
      updatedAt: this.state.updatedAt,
      latestSeq: this.state.latestSeq,
      status: this.state.status,
      title: this.state.title,
    };
  }

  private setSessionStatus(status: 'idle' | 'active'): void {
    this.setState({
      ...this.state,
      status,
      updatedAt: new Date().toISOString(),
    });
  }

  private maybeSetTitleFromText(text: string): void {
    if (this.state.title) return;
    const title = createSessionTitle(text);
    if (!title) return;
    this.setState({
      ...this.state,
      title,
      updatedAt: new Date().toISOString(),
    });
  }

  private getEventsAfter(afterSeq: number): SessionEventEnvelope[] {
    return this.sql<{
      seq: number;
      session_id: string;
      type: string;
      timestamp: string;
      payload: string;
    }>`
      SELECT seq, session_id, type, timestamp, payload
      FROM events
      WHERE seq > ${afterSeq}
      ORDER BY seq ASC
      LIMIT ${MAX_BUFFERED_EVENTS}
    `.map((row) => ({
      sessionId: row.session_id,
      seq: row.seq,
      type: row.type,
      timestamp: row.timestamp,
      payload: JSON.parse(row.payload),
    }));
  }

  private async appendEvent(
    type: string,
    payload: Record<string, unknown>,
    timestamp?: string,
  ): Promise<SessionEventEnvelope> {
    const now = new Date().toISOString();
    const nextSeq = this.state.latestSeq + 1;

    this.setState({
      ...this.state,
      latestSeq: nextSeq,
      updatedAt: now,
    });

    const eventTimestamp = timestamp || now;
    const event: SessionEventEnvelope = {
      sessionId: this.state.sessionId,
      seq: nextSeq,
      type,
      timestamp: eventTimestamp,
      payload,
    };

    this.sql`
      INSERT INTO events (seq, session_id, type, timestamp, payload)
      VALUES (${event.seq}, ${event.sessionId}, ${event.type}, ${event.timestamp}, ${JSON.stringify(event.payload)})
    `;

    // Prune old events
    this.sql`
      DELETE FROM events WHERE seq <= ${nextSeq - MAX_BUFFERED_EVENTS}
    `;

    await this.broadcastSse(event);
    return event;
  }

  private async broadcastSse(event: SessionEventEnvelope): Promise<void> {
    const clients = [...this.sseClients.values()];
    await Promise.allSettled(clients.map((client) => client.write(formatSse(event))));
  }

  // --- Runtime forwarding ---

  private async forwardTextCommandToRuntime(
    sessionId: string,
    action: 'prompt' | 'steer' | 'follow-up',
    text: string,
  ): Promise<{ ok: boolean; status?: number; details?: string }> {
    const runtimeBaseUrl = (this.env.RUNTIME_BASE_URL || 'http://localhost:8788').replace(
      /\/+$/,
      '',
    );

    try {
      const response = await fetch(
        `${runtimeBaseUrl}/internal/sessions/${sessionId}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        },
      );

      if (!response.ok) {
        const details = await response.text().catch(() => '');
        if (action === 'prompt') {
          this.setSessionStatus('idle');
        }
        await this.appendEvent('runtime.forward.error', {
          action,
          status: response.status,
          details,
        });
        return { ok: false, status: response.status, details };
      }

      return { ok: true };
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Failed to reach runtime';
      if (action === 'prompt') {
        this.setSessionStatus('idle');
      }
      await this.appendEvent('runtime.forward.error', {
        action,
        message: details,
      });
      return { ok: false, details };
    }
  }

  private async forwardAbortToRuntime(sessionId: string): Promise<void> {
    const runtimeBaseUrl = (this.env.RUNTIME_BASE_URL || 'http://localhost:8788').replace(
      /\/+$/,
      '',
    );

    try {
      const response = await fetch(
        `${runtimeBaseUrl}/internal/sessions/${sessionId}/abort`,
        { method: 'POST' },
      );

      if (!response.ok) {
        const details = await response.text().catch(() => '');
        await this.appendEvent('runtime.forward.error', {
          action: 'abort',
          status: response.status,
          details,
        });
      }
    } catch (error) {
      await this.appendEvent('runtime.forward.error', {
        action: 'abort',
        message: error instanceof Error ? error.message : 'Failed to reach runtime',
      });
    }
  }
}
