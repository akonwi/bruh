import type { Env, SessionEventEnvelope, SessionMetadata, SessionPromptRequest } from './session';

interface IncomingEvent {
  type: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

const META_KEY = 'meta';
const EVENTS_KEY = 'events';
const MAX_BUFFERED_EVENTS = 200;
const encoder = new TextEncoder();

function createSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 72) return normalized;
  return `${normalized.slice(0, 72).trimEnd()}…`;
}

interface SseClient {
  id: string;
  write: (chunk: string) => Promise<void>;
  close: () => void;
}

export class SessionDO {
  private clients = new Map<string, SseClient>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (`${request.method} ${url.pathname}`) {
      case 'POST /init':
        return this.handleInit(request);
      case 'GET /state':
        return this.handleState();
      case 'GET /stream':
        return this.handleStream(request);
      case 'POST /prompt':
        return this.handlePrompt(request);
      case 'POST /abort':
        return this.handleAbort();
      case 'POST /events':
        return this.handleIncomingEvent(request);
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  private async handleInit(request?: Request): Promise<Response> {
    const existing = await this.state.storage.get<SessionMetadata>(META_KEY);
    const body = request ? ((await request.json().catch(() => ({}))) as { sessionId?: string }) : {};

    const meta =
      existing ??
      ({
        sessionId: body.sessionId || this.state.id.toString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        latestSeq: 0,
        status: 'idle',
      } satisfies SessionMetadata);

    if (!existing) {
      await this.saveMeta(meta);
    }

    const events = await this.getEvents();
    if (events.length === 0) {
      await this.appendEvent('session.created', {
        message: 'Session created',
      });
    }

    return Response.json(await this.ensureMeta());
  }

  private async handleState(): Promise<Response> {
    return Response.json(await this.ensureMeta());
  }

  private async handlePrompt(request: Request): Promise<Response> {
    const meta = await this.ensureMeta();
    const body = (await request.json()) as SessionPromptRequest;
    const text = body.text?.trim();

    if (!text) {
      return Response.json({ error: 'text is required' }, { status: 400 });
    }

    await this.maybeSetTitleFromText(text);

    await this.appendEvent('session.prompt.accepted', {
      text,
      message: 'Prompt accepted and queued for runtime processing',
    });

    this.state.waitUntil(this.forwardPromptToRuntime(meta.sessionId, text));
    return Response.json({ ok: true, sessionId: meta.sessionId, queued: true });
  }

  private async handleAbort(): Promise<Response> {
    const meta = await this.ensureMeta();
    this.state.waitUntil(this.forwardAbortToRuntime(meta.sessionId));
    return Response.json({ ok: true, sessionId: meta.sessionId, requested: true });
  }

  private async handleIncomingEvent(request: Request): Promise<Response> {
    const body = (await request.json()) as IncomingEvent;
    if (!body.type) {
      return Response.json({ error: 'type is required' }, { status: 400 });
    }

    if (body.type === 'session.status' && typeof body.payload?.status === 'string') {
      await this.setStatus(body.payload.status as SessionMetadata['status']);
    }

    if (
      (body.type === 'session.prompt.accepted' || body.type === 'runtime.prompt.start') &&
      typeof body.payload?.text === 'string'
    ) {
      await this.maybeSetTitleFromText(body.payload.text);
    }

    const event = await this.appendEvent(body.type, body.payload ?? {}, body.timestamp);
    return Response.json({ ok: true, seq: event.seq });
  }

  private async handleStream(request: Request): Promise<Response> {
    const meta = await this.ensureMeta();
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
            this.clients.delete(clientId);
          });
        await pending;
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.clients.delete(clientId);
        void writer.close().catch(() => undefined);
      },
    };

    this.clients.set(clientId, client);
    request.signal.addEventListener('abort', () => client.close(), { once: true });

    this.state.waitUntil(
      (async () => {
        const replay = (await this.getEvents()).filter((event) => event.seq > afterSeq);
        await client.write(`: connected to ${meta.sessionId}\n\n`);
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

  private async ensureMeta(): Promise<SessionMetadata> {
    const existing = await this.state.storage.get<SessionMetadata>(META_KEY);
    if (existing) return existing;

    const sessionId = this.state.id.toString();
    const now = new Date().toISOString();
    const meta: SessionMetadata = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      latestSeq: 0,
      status: 'idle',
    };
    await this.state.storage.put(META_KEY, meta);
    return meta;
  }

  private async saveMeta(meta: SessionMetadata): Promise<void> {
    await this.state.storage.put(META_KEY, meta);
  }

  private async getEvents(): Promise<SessionEventEnvelope[]> {
    return (await this.state.storage.get<SessionEventEnvelope[]>(EVENTS_KEY)) ?? [];
  }

  private async saveEvents(events: SessionEventEnvelope[]): Promise<void> {
    await this.state.storage.put(EVENTS_KEY, events.slice(-MAX_BUFFERED_EVENTS));
  }

  private async setStatus(status: SessionMetadata['status']): Promise<void> {
    const meta = await this.ensureMeta();
    meta.status = status;
    meta.updatedAt = new Date().toISOString();
    await this.saveMeta(meta);
  }

  private async maybeSetTitleFromText(text: string): Promise<void> {
    const title = createSessionTitle(text);
    if (!title) return;

    const meta = await this.ensureMeta();
    if (meta.title) return;

    meta.title = title;
    meta.updatedAt = new Date().toISOString();
    await this.saveMeta(meta);
  }

  private async appendEvent(
    type: string,
    payload: Record<string, unknown>,
    timestamp?: string,
  ): Promise<SessionEventEnvelope> {
    const meta = await this.ensureMeta();
    meta.latestSeq += 1;
    meta.updatedAt = new Date().toISOString();

    const eventTimestamp = timestamp || meta.updatedAt;
    const event: SessionEventEnvelope = {
      sessionId: meta.sessionId,
      seq: meta.latestSeq,
      type,
      timestamp: eventTimestamp,
      payload,
    };

    const events = await this.getEvents();
    events.push(event);

    await this.saveMeta(meta);
    await this.saveEvents(events);
    await this.broadcast(event);

    return event;
  }

  private async broadcast(event: SessionEventEnvelope): Promise<void> {
    const clients = [...this.clients.values()];
    await Promise.allSettled(clients.map((client) => client.write(formatSse(event))));
  }

  private async forwardPromptToRuntime(sessionId: string, text: string): Promise<void> {
    const runtimeBaseUrl = (this.env.RUNTIME_BASE_URL || 'http://localhost:8788').replace(/\/+$/, '');

    try {
      const response = await fetch(`${runtimeBaseUrl}/internal/sessions/${sessionId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const details = await response.text().catch(() => '');
        await this.setStatus('idle');
        await this.appendEvent('runtime.forward.error', {
          action: 'prompt',
          status: response.status,
          details,
        });
      }
    } catch (error) {
      await this.setStatus('idle');
      await this.appendEvent('runtime.forward.error', {
        action: 'prompt',
        message: error instanceof Error ? error.message : 'Failed to reach runtime',
      });
    }
  }

  private async forwardAbortToRuntime(sessionId: string): Promise<void> {
    const runtimeBaseUrl = (this.env.RUNTIME_BASE_URL || 'http://localhost:8788').replace(/\/+$/, '');

    try {
      const response = await fetch(`${runtimeBaseUrl}/internal/sessions/${sessionId}/abort`, {
        method: 'POST',
      });

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

function formatSse(event: SessionEventEnvelope): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}
