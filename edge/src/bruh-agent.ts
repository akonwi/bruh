import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import { streamText, generateText, convertToModelMessages, stepCountIs, type StreamTextOnFinishCallback, type ToolSet, tool, jsonSchema } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { getAgentByName } from 'agents';
import type { SessionEventEnvelope, SessionMetadata } from './session';

// --- Helper: typed tool creation (works around AI SDK v6 overload issues) ---
function createTool<T>(config: {
  description: string;
  parameters: ReturnType<typeof jsonSchema>;
  execute: (args: T) => Promise<string>;
}) {
  return tool({ ...config, inputSchema: config.parameters } as any);
}

// --- Env & State ---

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

interface McpServerConfig {
  name: string;
  url: string;
  authEnvVar?: string;
  transport?: 'auto' | 'sse' | 'streamable-http';
  headers?: Record<string, string>;
}

// --- System prompt ---

const SYSTEM_PROMPT = `You are Bruh, a personal AI assistant. You are helpful, direct, and concise.
You have access to persistent memory (R2 storage), scheduling, thread awareness, and MCP tools.

## Memory

You have durable memory stored in R2. Use it to remember important information across conversations.
All threads share the same memory.

### Memory conventions
- \`profile.md\` — user preferences, communication style, standing instructions. Always save preferences here.
- \`notes/YYYY-MM-DD.md\` — dated notes, observations, meeting notes. Append, don't overwrite.
- \`projects/<slug>/overview.md\` — project goals, constraints, current shape.
- \`projects/<slug>/todo.md\` — next actions and open tasks.
- \`projects/<slug>/decisions.md\` — important decisions and rationale.
- \`sessions/<sessionId>/summary.md\` — rolling session summaries (auto-generated).

### Memory habits
- Recall before asking the user to repeat themselves.
- Save durable things (preferences, decisions, project context), not ephemeral chatter.
- User preferences always go to \`profile.md\`, even if mentioned in a project thread.
- Use \`memory_append\` for dated notes, \`memory_write\` for new files, \`memory_edit\` for precise updates.

## Scheduling
You can schedule one-time or recurring tasks. Each scheduled task is a prompt that you (the agent) execute at the scheduled time. The result appears in the message transcript so the user can see what happened. Use schedule_once for one-time tasks and schedule_recurring for repeated tasks.

## Threads
You run as the main thread or a side thread. Use thread tools to list and read summaries of other threads.

## MCP
You can connect to external MCP servers for additional tools. Use mcp_servers to check what's connected.

## Style
- Be direct and concise.
- Use markdown for structure when helpful.
- Don't hedge or add unnecessary caveats.
- When you save to memory, briefly confirm what you saved.`;

// --- Helpers ---

function createSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 72) return normalized;
  return `${normalized.slice(0, 72).trimEnd()}…`;
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/^memory\//, '');
}

// --- Agent ---

export class BruhAgent extends AIChatAgent<BruhEnv, BruhState> {
  initialState: BruhState = {
    sessionId: '',
    status: 'idle',
    title: undefined as string | undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    latestSeq: 0,
  };

  // Wait up to 10s for MCP servers to connect before handling chat messages
  waitForMcpConnections = { timeout: 10_000 };

  async onStart(): Promise<void> {
    this.ensureSchema();

    // After OAuth completes, redirect back to the app root
    this.mcp.configureOAuthCallback({
      successRedirect: '/',
      errorRedirect: '/?mcp_error=1',
    });

    await this.connectConfiguredMcpServers();
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

  // --- MCP config-driven connections ---

  private async connectConfiguredMcpServers(): Promise<void> {
    const raw = this.env.MCP_SERVERS;
    if (!raw || typeof raw !== 'string') return;

    let configs: McpServerConfig[];
    try {
      configs = JSON.parse(raw);
    } catch {
      console.error('[BruhAgent] Failed to parse MCP_SERVERS config');
      return;
    }

    if (!Array.isArray(configs)) return;

    for (const config of configs) {
      if (!config.name || !config.url) continue;
      try {
        const existing = this.getMcpServers();
        const alreadyConnected = Object.values(existing.servers).some(
          (s) => s.name === config.name && (s.state === 'ready' || s.state === 'discovering' || s.state === 'connected'),
        );
        if (alreadyConnected) continue;

        const transportHeaders: Record<string, string> = { ...config.headers };
        if (config.authEnvVar) {
          const token = this.env[config.authEnvVar];
          if (typeof token === 'string' && token.trim()) {
            transportHeaders['Authorization'] = `Bearer ${token.trim()}`;
          }
        }

        const options: Record<string, unknown> = {};
        if (Object.keys(transportHeaders).length > 0 || config.transport) {
          options.transport = {
            ...(Object.keys(transportHeaders).length > 0 ? { headers: transportHeaders } : {}),
            ...(config.transport ? { type: config.transport } : {}),
          };
        }

        const result = await this.addMcpServer(config.name, config.url, options);
        if (result.state === 'authenticating') {
          console.log(`[BruhAgent] MCP server ${config.name} requires OAuth: ${result.authUrl}`);
        }
      } catch (error) {
        console.error(`[BruhAgent] Failed to connect MCP server ${config.name}:`, error instanceof Error ? error.message : error);
      }
    }
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
      // --- Memory tools ---

      memory_read: createTool<{ path: string }>({
        description: 'Read a file from persistent memory (R2). Paths like "profile.md", "notes/2026-03-25.md", "projects/bruh/todo.md".',
        parameters: jsonSchema<{ path: string }>({
          type: 'object',
          properties: { path: { type: 'string', description: 'Path relative to memory root' } },
          required: ['path'],
        }),
        execute: async ({ path }) => {
          const key = normalizePath(path);
          const object = await env.MEMORY_BUCKET.get(`memory/${key}`);
          if (!object) return `File not found: ${key}`;
          return await object.text();
        },
      }),

      memory_write: createTool<{ path: string; content: string }>({
        description: 'Write or overwrite a file in persistent memory. Use for new files or full replacements.',
        parameters: jsonSchema<{ path: string; content: string }>({
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to memory root' },
            content: { type: 'string', description: 'Full content to write' },
          },
          required: ['path', 'content'],
        }),
        execute: async ({ path, content }) => {
          const key = normalizePath(path);
          await env.MEMORY_BUCKET.put(`memory/${key}`, content, {
            httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          });
          return `Written: ${key} (${content.length} bytes)`;
        },
      }),

      memory_edit: createTool<{ path: string; oldText: string; newText: string }>({
        description: 'Edit a file in persistent memory by replacing exact text. Use for precise updates to existing files.',
        parameters: jsonSchema<{ path: string; oldText: string; newText: string }>({
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to memory root' },
            oldText: { type: 'string', description: 'Exact text to find and replace' },
            newText: { type: 'string', description: 'Replacement text' },
          },
          required: ['path', 'oldText', 'newText'],
        }),
        execute: async ({ path, oldText, newText }) => {
          const key = normalizePath(path);
          const object = await env.MEMORY_BUCKET.get(`memory/${key}`);
          if (!object) return `File not found: ${key}`;

          const content = await object.text();
          const occurrences = content.split(oldText).length - 1;
          if (occurrences === 0) return `Error: old text not found in ${key}`;
          if (occurrences > 1) return `Error: old text is ambiguous (found ${occurrences} times) in ${key}`;

          const updated = content.replace(oldText, newText);
          await env.MEMORY_BUCKET.put(`memory/${key}`, updated, {
            httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          });
          return `Edited: ${key}`;
        },
      }),

      memory_append: createTool<{ path: string; content: string }>({
        description: 'Append content to a file in persistent memory. Creates the file if it does not exist. Ideal for dated notes and incremental logs.',
        parameters: jsonSchema<{ path: string; content: string }>({
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to memory root' },
            content: { type: 'string', description: 'Content to append' },
          },
          required: ['path', 'content'],
        }),
        execute: async ({ path, content }) => {
          const key = normalizePath(path);
          const existing = await env.MEMORY_BUCKET.get(`memory/${key}`);
          const prev = existing ? await existing.text() : '';
          const separator = prev && !prev.endsWith('\n') ? '\n' : '';
          const updated = prev + separator + content;
          await env.MEMORY_BUCKET.put(`memory/${key}`, updated, {
            httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          });
          return `Appended to ${key} (now ${updated.length} bytes)`;
        },
      }),

      memory_list: createTool<{ prefix?: string }>({
        description: 'List files in persistent memory. Returns file names and sizes.',
        parameters: jsonSchema<{ prefix?: string }>({
          type: 'object',
          properties: { prefix: { type: 'string', description: 'Optional prefix to filter, e.g. "notes/", "projects/bruh/"' } },
        }),
        execute: async ({ prefix }) => {
          const fullPrefix = prefix ? `memory/${normalizePath(prefix)}` : 'memory/';
          const result = await env.MEMORY_BUCKET.list({ prefix: fullPrefix, limit: 100 });
          if (result.objects.length === 0) return 'No files found.';
          return result.objects
            .map((o) => `${o.key.replace(/^memory\//, '')} (${o.size} bytes)`)
            .join('\n');
        },
      }),

      // --- Scheduling tools ---

      schedule_once: createTool<{ prompt: string; delaySeconds?: number; scheduledAt?: string }>({
        description: 'Schedule a one-time task. The agent will be prompted with the message at the scheduled time. The result appears in the transcript.',
        parameters: jsonSchema<{ prompt: string; delaySeconds?: number; scheduledAt?: string }>({
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Prompt the agent will execute at the scheduled time' },
            delaySeconds: { type: 'number', description: 'Delay in seconds from now' },
            scheduledAt: { type: 'string', description: 'ISO 8601 datetime to fire at' },
          },
          required: ['prompt'],
        }),
        execute: async ({ prompt, delaySeconds, scheduledAt }) => {
          const when = scheduledAt
            ? new Date(scheduledAt)
            : delaySeconds && delaySeconds > 0
              ? delaySeconds
              : null;
          if (!when) return 'Error: provide delaySeconds or scheduledAt';
          const payload = JSON.stringify({ prompt });
          const schedule = await agent.schedule(when, 'executeScheduledTask', payload);
          return `Scheduled one-time task (id: ${schedule.id}): "${prompt}"`;
        },
      }),

      schedule_recurring: createTool<{ prompt: string; intervalSeconds: number }>({
        description: 'Schedule a recurring task. The agent will be prompted repeatedly at the given interval. The result appears in the transcript each time.',
        parameters: jsonSchema<{ prompt: string; intervalSeconds: number }>({
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Prompt the agent will execute each interval' },
            intervalSeconds: { type: 'number', description: 'Seconds between each execution' },
          },
          required: ['prompt', 'intervalSeconds'],
        }),
        execute: async ({ prompt, intervalSeconds }) => {
          if (intervalSeconds < 10) return 'Error: intervalSeconds must be at least 10';
          const payload = JSON.stringify({ prompt });
          const schedule = await agent.scheduleEvery(intervalSeconds, 'executeScheduledTask', payload);
          return `Scheduled recurring task every ${intervalSeconds}s (id: ${schedule.id}): "${prompt}"`;
        },
      }),

      schedule_list: createTool<Record<string, never>>({
        description: 'List all active scheduled tasks.',
        parameters: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
        execute: async () => {
          const schedules = agent.getSchedules();
          if (schedules.length === 0) return 'No active schedules.';
          return schedules.map((s) => {
            const time = s.time ? new Date(s.time).toISOString() : 'recurring';
            const payload = typeof s.payload === 'string' ? JSON.parse(s.payload) : s.payload;
            const prompt = payload?.prompt || '(unknown)';
            return `${s.id} [${s.type}] at ${time}: "${prompt}"`;
          }).join('\n');
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

      // --- Thread tools ---

      thread_list: createTool<Record<string, never>>({
        description: 'List all side threads (not main). Returns thread IDs and creation times.',
        parameters: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
        execute: async () => {
          try {
            const registryStub = await getAgentByName(env.BRUH_AGENT as any, '__registry__');
            const response = await registryStub.fetch(new Request('https://agent/threads'));
            if (!response.ok) return 'Failed to list threads.';
            const data = await response.json() as { sessions: Array<{ sessionId: string; createdAt: string }> };
            if (!data.sessions?.length) return 'No side threads.';
            return data.sessions.map((t) => `${t.sessionId} (created ${t.createdAt})`).join('\n');
          } catch (e) {
            return `Error listing threads: ${e instanceof Error ? e.message : e}`;
          }
        },
      }),

      thread_summary: createTool<{ threadId: string }>({
        description: 'Read the summary of a side thread from memory.',
        parameters: jsonSchema<{ threadId: string }>({
          type: 'object',
          properties: { threadId: { type: 'string', description: 'Thread/session ID to read summary for' } },
          required: ['threadId'],
        }),
        execute: async ({ threadId }) => {
          const key = `memory/sessions/${threadId}/summary.md`;
          const object = await env.MEMORY_BUCKET.get(key);
          if (!object) return `No summary found for thread ${threadId}`;
          return await object.text();
        },
      }),

      // --- MCP tools ---

      mcp_servers: createTool<Record<string, never>>({
        description: 'List connected MCP servers and their status.',
        parameters: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
        execute: async () => {
          const state = agent.getMcpServers();
          const servers = Object.entries(state.servers);
          if (servers.length === 0) return 'No MCP servers connected.';
          return servers.map(([id, s]) => `${s.name} (${s.state}) — ${s.server_url}`).join('\n');
        },
      }),

      mcp_tools: createTool<Record<string, never>>({
        description: 'List all tools available from connected MCP servers.',
        parameters: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
        execute: async () => {
          const state = agent.getMcpServers();
          const tools = state.tools ?? [];
          if (tools.length === 0) return 'No MCP tools available.';
          return tools.map((t) => `${t.name}: ${t.description || '(no description)'} [server: ${t.serverId}]`).join('\n');
        },
      }),

      mcp_connect: createTool<{ name: string; url: string; headers?: Record<string, string> }>({
        description: 'Connect to an MCP server. For OAuth servers, returns an authorization URL the user must visit. For non-OAuth servers, connects immediately. MCP tools become available on the next turn.',
        parameters: jsonSchema<{ name: string; url: string; headers?: Record<string, string> }>({
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name for this server' },
            url: { type: 'string', description: 'Server URL' },
            headers: { type: 'object', description: 'Optional transport headers (e.g. Authorization)' },
          },
          required: ['name', 'url'],
        }),
        execute: async ({ name, url, headers }) => {
          try {
            const options: Record<string, unknown> = {};
            if (headers && Object.keys(headers).length > 0) {
              options.transport = { headers };
            }

            const result = await agent.addMcpServer(name, url, options);

            if (result.state === 'authenticating') {
              return `🔐 Server "${name}" requires OAuth authorization.\n\nPlease visit this URL to authorize:\n${result.authUrl}\n\nOnce authorized, the server's tools will become available.`;
            }

            return `Connected to MCP server: ${name} (id: ${result.id}). Its tools will be available on the next message.`;
          } catch (e) {
            return `Failed to connect: ${e instanceof Error ? e.message : e}`;
          }
        },
      }),

      mcp_disconnect: createTool<{ serverId: string }>({
        description: 'Disconnect from an MCP server by its ID (from mcp_servers).',
        parameters: jsonSchema<{ serverId: string }>({
          type: 'object',
          properties: { serverId: { type: 'string', description: 'Server ID to disconnect' } },
          required: ['serverId'],
        }),
        execute: async ({ serverId }) => {
          try {
            await agent.removeMcpServer(serverId);
            return `Disconnected MCP server: ${serverId}`;
          } catch (e) {
            return `Failed to disconnect: ${e instanceof Error ? e.message : e}`;
          }
        },
      }),

      // Note: MCP tools from connected servers are automatically available to the model
      // via this.mcp.getAITools() — no need for a manual mcp_call wrapper.
    };
  }

  // --- AIChatAgent: the agent loop ---

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const model = this.getModel();
    // Merge custom tools with MCP tools from connected servers
    const mcpTools = this.mcp.getAITools();
    const tools = { ...this.getTools(), ...mcpTools };

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

    // Wrap onFinish to auto-write session summary
    const wrappedOnFinish: StreamTextOnFinishCallback<ToolSet> = async (event) => {
      await onFinish(event);
      // Auto-write session summary to R2
      this.ctx.waitUntil(this.writeSessionSummary(event.text || ''));
    };

    const result = streamText({
      model,
      messages: modelMessages,
      system: SYSTEM_PROMPT,
      tools,
      stopWhen: stepCountIs(10),
      onFinish: wrappedOnFinish,
      abortSignal: options?.abortSignal,
    });

    return result.toUIMessageStreamResponse();
  }

  // --- Session summaries ---

  private async writeSessionSummary(latestResponse: string): Promise<void> {
    try {
      const sessionId = this.state.sessionId || this.name;
      if (!sessionId) return;

      // Build a brief summary from recent messages
      const recentMessages = this.messages.slice(-10);
      const lines: string[] = [`# Session Summary: ${sessionId}`, `Updated: ${new Date().toISOString()}`, ''];

      for (const msg of recentMessages) {
        const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : msg.role;
        const textPart = msg.parts?.find((p) => p.type === 'text');
        if (textPart && 'text' in textPart) {
          const text = textPart.text.length > 200 ? textPart.text.slice(0, 200) + '…' : textPart.text;
          lines.push(`**${role}:** ${text}`, '');
        }
      }

      const summary = lines.join('\n');
      await this.env.MEMORY_BUCKET.put(`memory/sessions/${sessionId}/summary.md`, summary, {
        httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
      });
    } catch (error) {
      console.error('[BruhAgent] Failed to write session summary:', error);
    }
  }

  // --- Scheduled task execution ---

  async executeScheduledTask(rawPayload: string): Promise<void> {
    let prompt: string;
    try {
      const parsed = JSON.parse(rawPayload) as { prompt?: string; message?: string };
      prompt = parsed.prompt || parsed.message || rawPayload;
    } catch {
      prompt = rawPayload;
    }

    console.log(`[BruhAgent] Executing scheduled task: "${prompt}"`);

    try {
      // Run as an ephemeral agent — standalone prompt, not part of conversation history.
      // The agent has tools (memory etc.) so it can look up context if needed.
      const model = this.getModel();
      const tools = this.getTools();

      const result = await generateText({
        model,
        prompt: prompt,
        system: `${SYSTEM_PROMPT}\n\nYou are executing a scheduled task. Carry out the task and report the result concisely. The user will see your response in their chat transcript.`,
        tools,
        stopWhen: stepCountIs(10),
      });

      const responseText = result.text?.trim();
      if (!responseText) {
        console.log('[BruhAgent] Scheduled task produced no text output');
        return;
      }

      // Post only the result as an assistant message in the transcript
      const assistantMessage = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: `⏰ ${responseText}` }],
        createdAt: new Date(),
      };
      this.messages.push(assistantMessage);
      await this.saveMessages(this.messages);

      console.log(`[BruhAgent] Scheduled task completed: ${result.text?.length ?? 0} chars`);
    } catch (error) {
      console.error('[BruhAgent] Scheduled task failed:', error);

      const errorMessage = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: `⚠️ Scheduled task failed: ${error instanceof Error ? error.message : 'unknown error'}` }],
        createdAt: new Date(),
      };
      this.messages.push(errorMessage);
      await this.saveMessages(this.messages);
    }
  }

  // --- Custom request handling ---

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (`${request.method} ${url.pathname}`) {
      case 'POST /init':
        return this.handleInit(request);
      case 'GET /state':
        return this.handleState();
      case 'POST /prompt':
        return this.handleHttpPrompt(request);
      case 'POST /steer':
        return this.handleHttpSteer(request);
      case 'POST /follow-up':
        return this.handleHttpFollowUp(request);
      case 'POST /abort':
        return this.handleHttpAbort();
      case 'POST /register-thread':
        return this.handleRegisterThread(request);
      case 'GET /threads':
        return this.handleListThreads();
      // Legacy event system (remove once web app fully migrated)
      case 'GET /events':
        return this.handleGetEvents(request);
      case 'GET /stream':
        return this.handleStream(request);
      default:
        return super.onRequest(request);
    }
  }

  // --- HTTP prompt / steer / follow-up / abort ---

  private async handleHttpPrompt(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { text?: string };
    const text = body.text?.trim();
    if (!text) return Response.json({ error: 'text is required' }, { status: 400 });

    if (!this.state.title) {
      this.setState({ ...this.state, title: createSessionTitle(text), updatedAt: new Date().toISOString() });
    }

    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: text,
      parts: [{ type: 'text' as const, text }],
      createdAt: new Date(),
    };
    this.messages.push(userMessage);

    const model = this.getModel();
    const mcpTools = this.mcp.getAITools();
    const tools = { ...this.getTools(), ...mcpTools };
    const modelMessages = await convertToModelMessages(this.messages);

    const result = streamText({
      model,
      messages: modelMessages,
      system: SYSTEM_PROMPT,
      tools,
      stopWhen: stepCountIs(10),
      onFinish: async (event) => {
        const assistantMessage = {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: event.text || '',
          parts: [{ type: 'text' as const, text: event.text || '' }],
          createdAt: new Date(),
        };
        this.messages.push(assistantMessage);
        await this.saveMessages(this.messages);
        this.ctx.waitUntil(this.writeSessionSummary(event.text || ''));
      },
    });

    return result.toUIMessageStreamResponse();
  }

  private async handleHttpSteer(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { text?: string };
    const text = body.text?.trim();
    if (!text) return Response.json({ error: 'text is required' }, { status: 400 });

    // Steer: add as a system-level instruction that the agent should incorporate
    const steerMessage = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: `[STEER] ${text}`,
      parts: [{ type: 'text' as const, text: `[STEER] ${text}` }],
      createdAt: new Date(),
    };
    this.messages.push(steerMessage);

    return Response.json({ ok: true, queued: true });
  }

  private async handleHttpFollowUp(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { text?: string };
    const text = body.text?.trim();
    if (!text) return Response.json({ error: 'text is required' }, { status: 400 });

    // Follow-up: queue for after current turn finishes — add to messages
    const followUpMessage = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: text,
      parts: [{ type: 'text' as const, text }],
      createdAt: new Date(),
    };
    this.messages.push(followUpMessage);

    return Response.json({ ok: true, queued: true });
  }

  private async handleHttpAbort(): Promise<Response> {
    // The abort is handled by the AbortSignal on the active stream
    // For now, return ok — the client can close the connection
    return Response.json({ ok: true, aborted: true });
  }

  // --- Session / thread init ---

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { sessionId?: string; title?: string };
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
      this.setState({ ...this.state, title: requestedTitle, updatedAt: new Date().toISOString() });
    }

    return Response.json(this.toMetadata());
  }

  private handleState(): Response {
    return Response.json(this.toMetadata());
  }

  // --- Thread registry ---

  private async handleRegisterThread(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { sessionId?: string; createdAt?: string };
    const sessionId = body.sessionId?.trim();
    if (!sessionId) return Response.json({ error: 'sessionId is required' }, { status: 400 });

    const existing = this.sql<{ session_id: string }>`SELECT session_id FROM thread_registry WHERE session_id = ${sessionId}`;
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
    return Response.json({ sessions: threads.map((t) => ({ sessionId: t.session_id, createdAt: t.created_at })) });
  }

  // --- Legacy event system ---

  private async handleGetEvents(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const afterSeq = Number(url.searchParams.get('after') ?? '0') || 0;
    return Response.json({ events: this.getEventsAfter(afterSeq) });
  }

  private async handleStream(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const afterSeq = Number(url.searchParams.get('after') ?? request.headers.get('last-event-id') ?? '0') || 0;

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    let closed = false;

    const write = async (chunk: string) => {
      if (closed) return;
      try { await writer.write(encoder.encode(chunk)); } catch { closed = true; }
    };

    this.ctx.waitUntil(
      (async () => {
        await write(`: connected to ${this.state.sessionId}\n\n`);
        for (const event of this.getEventsAfter(afterSeq)) {
          await write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      })().catch(() => { closed = true; }),
    );

    request.signal.addEventListener('abort', () => { closed = true; void writer.close().catch(() => undefined); }, { once: true });

    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', Connection: 'keep-alive' },
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
    return this.sql<{ seq: number; session_id: string; type: string; timestamp: string; payload: string }>`
      SELECT seq, session_id, type, timestamp, payload FROM events WHERE seq > ${afterSeq} ORDER BY seq ASC LIMIT 200
    `.map((row) => ({ sessionId: row.session_id, seq: row.seq, type: row.type, timestamp: row.timestamp, payload: JSON.parse(row.payload) }));
  }

  private async appendEvent(type: string, payload: Record<string, unknown>, timestamp?: string): Promise<SessionEventEnvelope> {
    const now = new Date().toISOString();
    const nextSeq = this.state.latestSeq + 1;
    this.setState({ ...this.state, latestSeq: nextSeq, updatedAt: now });

    const event: SessionEventEnvelope = { sessionId: this.state.sessionId, seq: nextSeq, type, timestamp: timestamp || now, payload };
    this.sql`INSERT INTO events (seq, session_id, type, timestamp, payload) VALUES (${event.seq}, ${event.sessionId}, ${event.type}, ${event.timestamp}, ${JSON.stringify(event.payload)})`;
    this.sql`DELETE FROM events WHERE seq <= ${nextSeq - 200}`;
    return event;
  }
}
