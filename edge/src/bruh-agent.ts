import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import { streamText, convertToModelMessages, stepCountIs, type StreamTextOnFinishCallback, type ToolSet, tool, jsonSchema } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { SessionEventEnvelope, SessionMetadata } from './session';

// Helper to create a tool with typed execute — works around AI SDK v6 overload issues
function createTool<T>(config: {
  description: string;
  parameters: ReturnType<typeof jsonSchema>;
  execute: (args: T) => Promise<string>;
}) {
  return tool({ ...config, inputSchema: config.parameters } as any);
}

interface BruhEnv {
  BRUH_AGENT: DurableObjectNamespace;
  MEMORY_BUCKET: R2Bucket;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  INTERNAL_API_SECRET?: string;
  MCP_SERVERS?: string;
  [key: string]: unknown;
}

interface BruhState {
  sessionId: string;
  status: 'idle' | 'active';
  title?: string;
  createdAt: string;
  updatedAt: string;
  latestSeq: number;
}

const SYSTEM_PROMPT = `You are Bruh, a personal AI assistant. You are helpful, direct, and concise.

You have access to tools for managing memory (persistent R2 storage) and other capabilities.
Use memory tools to remember important information across conversations.
Be proactive about saving useful context to memory when the user shares preferences or important information.`;

function createSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 72) return normalized;
  return `${normalized.slice(0, 72).trimEnd()}…`;
}

export class BruhAgent extends AIChatAgent<BruhEnv, BruhState> {
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

  // --- Model provider selection ---

  private getModel() {
    const anthropicKey = this.env.ANTHROPIC_API_KEY?.trim();
    const openaiKey = this.env.OPENAI_API_KEY?.trim();

    if (anthropicKey) {
      const anthropic = createAnthropic({ apiKey: anthropicKey });
      return anthropic('claude-sonnet-4-20250514');
    }

    if (openaiKey) {
      const openai = createOpenAI({ apiKey: openaiKey });
      return openai('gpt-4o');
    }

    throw new Error('No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  }

  // --- Tools ---

  private getTools(): ToolSet {
    const env = this.env;
    const agent = this;

    return {
      memory_read: createTool<{ path: string }>({
        description: 'Read a file from persistent memory (R2 storage). Use paths like "profile.md", "preferences.md", etc.',
        parameters: jsonSchema<{ path: string }>({
          type: 'object',
          properties: { path: { type: 'string', description: 'Path relative to memory root, e.g. "profile.md"' } },
          required: ['path'],
        }),
        execute: async ({ path }) => {
          const normalized = path.replace(/^\/+/, '').replace(/^memory\//, '');
          const object = await env.MEMORY_BUCKET.get(`memory/${normalized}`);
          if (!object) return `File not found: ${normalized}`;
          return await object.text();
        },
      }),

      memory_write: createTool<{ path: string; content: string }>({
        description: 'Write or overwrite a file in persistent memory. Use for saving preferences, notes, session summaries, etc.',
        parameters: jsonSchema<{ path: string; content: string }>({
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to memory root' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['path', 'content'],
        }),
        execute: async ({ path, content }) => {
          const normalized = path.replace(/^\/+/, '').replace(/^memory\//, '');
          await env.MEMORY_BUCKET.put(`memory/${normalized}`, content, {
            httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          });
          return `Written: ${normalized} (${content.length} bytes)`;
        },
      }),

      memory_list: createTool<{ prefix?: string }>({
        description: 'List files in persistent memory. Returns file names and sizes.',
        parameters: jsonSchema<{ prefix?: string }>({
          type: 'object',
          properties: { prefix: { type: 'string', description: 'Optional prefix to filter by, e.g. "sessions/"' } },
        }),
        execute: async ({ prefix }) => {
          const fullPrefix = prefix
            ? `memory/${prefix.replace(/^\/+/, '').replace(/^memory\//, '')}`
            : 'memory/';
          const result = await env.MEMORY_BUCKET.list({ prefix: fullPrefix, limit: 100 });
          if (result.objects.length === 0) return 'No files found.';
          return result.objects
            .map((o) => `${o.key.replace(/^memory\//, '')} (${o.size} bytes)`)
            .join('\n');
        },
      }),

      schedule_set: createTool<{ message: string; delaySeconds?: number; scheduledAt?: string; taskType?: 'task' | 'reminder' }>({
        description: 'Schedule a task or reminder for later. The agent will be prompted with the message at the scheduled time.',
        parameters: jsonSchema<{ message: string; delaySeconds?: number; scheduledAt?: string; taskType?: 'task' | 'reminder' }>({
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Message to be delivered at the scheduled time' },
            delaySeconds: { type: 'number', description: 'Delay in seconds from now' },
            scheduledAt: { type: 'string', description: 'ISO 8601 datetime to fire at' },
            taskType: { type: 'string', enum: ['task', 'reminder'], description: 'Type: "task" auto-prompts, "reminder" just notifies' },
          },
          required: ['message'],
        }),
        execute: async ({ message, delaySeconds, scheduledAt, taskType }) => {
          const when = scheduledAt
            ? new Date(scheduledAt)
            : delaySeconds && delaySeconds > 0
              ? delaySeconds
              : null;

          if (!when) return 'Error: delaySeconds or scheduledAt is required';

          const payload = JSON.stringify({ message, taskType: taskType || 'task' });
          const schedule = await agent.schedule(when, 'executeScheduledTask', payload);
          return `Scheduled "${message}" (${schedule.type}, id: ${schedule.id})`;
        },
      }),

      schedule_list: createTool<Record<string, never>>({
        description: 'List all active scheduled tasks and reminders.',
        parameters: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
        execute: async () => {
          const schedules = agent.getSchedules();
          if (schedules.length === 0) return 'No active schedules.';
          return schedules
            .map((s) => {
              const time = s.time ? new Date(s.time).toISOString() : 'recurring';
              return `${s.id}: ${s.callback} at ${time}`;
            })
            .join('\n');
        },
      }),

      schedule_cancel: createTool<{ scheduleId: string }>({
        description: 'Cancel a scheduled task by its ID.',
        parameters: jsonSchema<{ scheduleId: string }>({
          type: 'object',
          properties: { scheduleId: { type: 'string', description: 'ID of the schedule to cancel' } },
          required: ['scheduleId'],
        }),
        execute: async ({ scheduleId }) => {
          const cancelled = await agent.cancelSchedule(scheduleId);
          return cancelled ? `Cancelled schedule ${scheduleId}` : `Schedule ${scheduleId} not found`;
        },
      }),
    };
  }

  // --- AIChatAgent: the agent loop ---

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const model = this.getModel();
    const tools = this.getTools();

    // Set title from first user message
    const lastUserMessage = [...this.messages].reverse().find((m) => m.role === 'user');
    if (lastUserMessage && !this.state.title) {
      const textPart = lastUserMessage.parts?.find((p) => p.type === 'text');
      if (textPart && 'text' in textPart) {
        this.setState({
          ...this.state,
          title: createSessionTitle(textPart.text),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    const modelMessages = await convertToModelMessages(this.messages);

    const result = streamText({
      model,
      messages: modelMessages,
      system: SYSTEM_PROMPT,
      tools,
      stopWhen: stepCountIs(10),
      onFinish,
      abortSignal: options?.abortSignal,
    });

    return result.toUIMessageStreamResponse();
  }

  // --- Scheduled task execution ---

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

    // For tasks, we could auto-prompt the agent by sending a message
    // For now, just log the event
  }

  // --- Custom request handling (session init, events, threads, etc.) ---

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Let AIChatAgent handle its own routes first
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
        return this.handleHttpPrompt(request);
      case 'POST /register-thread':
        return this.handleRegisterThread(request);
      case 'GET /threads':
        return this.handleListThreads();
      default:
        // Fall through to AIChatAgent's built-in handling (WebSocket, chat protocol)
        return super.onRequest(request);
    }
  }

  // --- HTTP prompt bridge (for current web app that uses POST, not WebSocket) ---

  private async handleHttpPrompt(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { text?: string };
    const text = body.text?.trim();
    if (!text) {
      return Response.json({ error: 'text is required' }, { status: 400 });
    }

    // Set title from first prompt
    if (!this.state.title) {
      this.setState({
        ...this.state,
        title: createSessionTitle(text),
        updatedAt: new Date().toISOString(),
      });
    }

    // Add user message to conversation
    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: text,
      parts: [{ type: 'text' as const, text }],
      createdAt: new Date(),
    };
    this.messages.push(userMessage);

    // Emit event for the legacy SSE stream
    await this.appendEvent('session.prompt.accepted', { text });

    // Run the model directly (bypass AIChatAgent's WebSocket-based onChatMessage)
    const model = this.getModel();
    const tools = this.getTools();
    const modelMessages = await convertToModelMessages(this.messages);

    const result = streamText({
      model,
      messages: modelMessages,
      system: SYSTEM_PROMPT,
      tools,
      stopWhen: stepCountIs(10),
      onFinish: async (event) => {
        // Save the assistant message
        const assistantMessage = {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: event.text || '',
          parts: [{ type: 'text' as const, text: event.text || '' }],
          createdAt: new Date(),
        };
        this.messages.push(assistantMessage);
        await this.saveMessages(this.messages);

        // Emit events for legacy SSE stream
        await this.appendEvent('assistant.message.complete', { text: event.text || '' });
      },
    });

    return result.toUIMessageStreamResponse();
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

    return Response.json(this.toMetadata());
  }

  private handleState(): Response {
    return Response.json(this.toMetadata());
  }

  // --- Thread registry ---

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

  // --- Legacy event system (for compatibility with current web app) ---

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
    const encoder = new TextEncoder();
    let closed = false;

    const replay = this.getEventsAfter(afterSeq);
    const write = async (chunk: string) => {
      if (closed) return;
      try {
        await writer.write(encoder.encode(chunk));
      } catch {
        closed = true;
      }
    };

    this.ctx.waitUntil(
      (async () => {
        await write(`: connected to ${this.state.sessionId}\n\n`);
        for (const event of replay) {
          await write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        // Keep connection open — events will be pushed via appendEvent
      })().catch(() => {
        closed = true;
      }),
    );

    request.signal.addEventListener('abort', () => {
      closed = true;
      void writer.close().catch(() => undefined);
    }, { once: true });

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
      LIMIT 200
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

    const event: SessionEventEnvelope = {
      sessionId: this.state.sessionId,
      seq: nextSeq,
      type,
      timestamp: timestamp || now,
      payload,
    };

    this.sql`
      INSERT INTO events (seq, session_id, type, timestamp, payload)
      VALUES (${event.seq}, ${event.sessionId}, ${event.type}, ${event.timestamp}, ${JSON.stringify(event.payload)})
    `;

    // Prune old events
    this.sql`DELETE FROM events WHERE seq <= ${nextSeq - 200}`;

    return event;
  }
}
