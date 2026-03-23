import type { Env, SessionEventEnvelope, SessionMetadata, SessionPromptRequest } from './session';

const META_KEY = 'meta';
const EVENTS_KEY = 'events';
const MAX_BUFFERED_EVENTS = 200;
const encoder = new TextEncoder();

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

    await this.appendEvent('session.prompt.accepted', {
      text,
      message: 'Prompt accepted by SessionDO skeleton',
    });

    await this.setStatus('active');
    await this.appendEvent('session.runtime.placeholder', {
      text: `Runtime wiring pending. Received prompt: ${text}`,
    });
    await this.setStatus('idle');

    return Response.json({ ok: true, sessionId: meta.sessionId });
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

    const replay = (await this.getEvents()).filter((event) => event.seq > afterSeq);
    await client.write(`: connected to ${meta.sessionId}\n\n`);
    for (const event of replay) {
      await client.write(formatSse(event));
    }

    request.signal.addEventListener('abort', () => client.close(), { once: true });

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

  private async appendEvent(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<SessionEventEnvelope> {
    const meta = await this.ensureMeta();
    meta.latestSeq += 1;
    meta.updatedAt = new Date().toISOString();

    const event: SessionEventEnvelope = {
      sessionId: meta.sessionId,
      seq: meta.latestSeq,
      type,
      timestamp: meta.updatedAt,
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
}

function formatSse(event: SessionEventEnvelope): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}
