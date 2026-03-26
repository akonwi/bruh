import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat'
import { getSandbox, type Sandbox } from '@cloudflare/sandbox'
import { getAgentByName } from 'agents'
import type { UIMessage } from 'ai'
import {
  convertToModelMessages,
  generateText,
  jsonSchema,
  type StreamTextOnFinishCallback,
  stepCountIs,
  streamText,
  type ToolSet,
  tool,
} from 'ai'
import type { SessionEventEnvelope, SessionMetadata } from './session'

/**
 * Remove assistant messages that have tool calls without matching tool results.
 * This prevents MissingToolResultsError when a tool call failed mid-turn
 * (e.g. sandbox container error) and the incomplete state was persisted.
 */
function sanitizeMessages(messages: UIMessage[]): UIMessage[] {
  return messages
    .map((msg) => {
      if (msg.role !== 'assistant' || !msg.parts) return msg

      const hasToolCall = msg.parts.some(
        (p: any) =>
          typeof p.type === 'string' &&
          p.type.startsWith('tool-') &&
          (p.state === 'call' || p.state === 'partial-call'),
      )

      if (!hasToolCall) return msg

      // Strip incomplete tool invocations (call without result)
      const cleanParts = msg.parts.filter((p: any) => {
        if (typeof p.type === 'string' && p.type.startsWith('tool-')) {
          return p.state === 'result' || p.state === 'output-available'
        }
        return true
      })

      return { ...msg, parts: cleanParts }
    })
    .filter((msg) => msg.parts == null || msg.parts.length > 0)
}

// --- Helper: typed tool creation (works around AI SDK v6 overload issues) ---
// Tool execute functions should throw on errors — the AI SDK will set state to 'output-error'
function createTool<T>(config: {
  description: string
  parameters: ReturnType<typeof jsonSchema>
  execute: (args: T) => Promise<string>
}) {
  return tool({ ...config, inputSchema: config.parameters } as any)
}

class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

// --- Env & State ---

interface BruhEnv {
  BRUH_AGENT: DurableObjectNamespace
  SANDBOX: DurableObjectNamespace<Sandbox>
  MEMORY_BUCKET: R2Bucket
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
  INTERNAL_API_SECRET?: string
  MCP_SERVERS?: string
  HOST?: string
  APP_ORIGIN?: string
  GITHUB_MCP_TOKEN?: string
  [key: string]: unknown
}

interface BruhState {
  sessionId: string
  status: 'idle' | 'active'
  title?: string
  createdAt: string
  updatedAt: string
  latestSeq: number
}

interface McpServerConfig {
  name: string
  url: string
  authEnvVar?: string
  transport?: 'auto' | 'sse' | 'streamable-http'
  headers?: Record<string, string>
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

## Sandbox
You have access to an isolated sandbox container with a full Linux environment. It has bash, git, python3, node, and common tools.
- Use sandbox_exec for shell commands (git clone, python scripts, installs, etc.)
- Use sandbox_read/write for file operations in the sandbox
- Use sandbox_git_clone to clone repositories
- The sandbox filesystem persists across tool calls within the same session
- The sandbox working directory is /workspace

## MCP
You can connect to external MCP servers for additional tools. Use mcp_servers to check what's connected.

## Style
- Be direct and concise.
- Use markdown for structure when helpful.
- Don't hedge or add unnecessary caveats.
- When you save to memory, briefly confirm what you saved.`

// --- Helpers ---

function createSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 72) return normalized
  return `${normalized.slice(0, 72).trimEnd()}…`
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/^memory\//, '')
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
  }

  // Wait up to 10s for MCP servers to connect before handling chat messages
  waitForMcpConnections = { timeout: 10_000 }

  async onStart(): Promise<void> {
    this.ensureSchema()

    const appOrigin = this.env.APP_ORIGIN?.trim() || ''
    this.mcp.configureOAuthCallback({
      successRedirect: `${appOrigin}/`,
      errorRedirect: `${appOrigin}/?mcp_error=1`,
    })

    await this.connectDefaultMcpServers()
    await this.connectConfiguredMcpServers()
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
    `
    this.sql`
      CREATE TABLE IF NOT EXISTS thread_registry (
        session_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )
    `
  }

  // --- MCP default servers (token-based, no OAuth) ---

  private static readonly DEFAULT_MCP_SERVERS: Array<{
    name: string
    url: string
    tokenEnvVar: string
  }> = [
    {
      name: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      tokenEnvVar: 'GITHUB_MCP_TOKEN',
    },
  ]

  private async connectDefaultMcpServers(): Promise<void> {
    for (const server of BruhAgent.DEFAULT_MCP_SERVERS) {
      const token = this.env[server.tokenEnvVar]
      if (typeof token !== 'string' || !token.trim()) continue

      try {
        const existing = this.getMcpServers()
        const alreadyConnected = Object.values(existing.servers).some(
          (s) => s.name === server.name && s.state !== 'failed',
        )
        if (alreadyConnected) continue

        await this.addMcpServer(server.name, server.url, {
          transport: { headers: { Authorization: `Bearer ${token.trim()}` } },
        })
        console.log(`[BruhAgent] Connected default MCP server: ${server.name}`)
      } catch (error) {
        console.error(
          `[BruhAgent] Failed to connect default MCP server ${server.name}:`,
          error instanceof Error ? error.message : error,
        )
      }
    }
  }

  // --- MCP config-driven connections ---

  private async connectConfiguredMcpServers(): Promise<void> {
    const raw = this.env.MCP_SERVERS
    if (!raw || typeof raw !== 'string') return

    let configs: McpServerConfig[]
    try {
      configs = JSON.parse(raw)
    } catch {
      console.error('[BruhAgent] Failed to parse MCP_SERVERS config')
      return
    }

    if (!Array.isArray(configs)) return

    for (const config of configs) {
      if (!config.name || !config.url) continue
      try {
        const existing = this.getMcpServers()
        const alreadyConnected = Object.values(existing.servers).some(
          (s) =>
            s.name === config.name &&
            (s.state === 'ready' ||
              s.state === 'discovering' ||
              s.state === 'connected'),
        )
        if (alreadyConnected) continue

        const transportHeaders: Record<string, string> = { ...config.headers }
        if (config.authEnvVar) {
          const token = this.env[config.authEnvVar]
          if (typeof token === 'string' && token.trim()) {
            transportHeaders['Authorization'] = `Bearer ${token.trim()}`
          }
        }

        const callbackHost = this.env.HOST?.trim() || 'http://localhost:8790'
        const options: Record<string, unknown> = { callbackHost }
        if (Object.keys(transportHeaders).length > 0 || config.transport) {
          options.transport = {
            ...(Object.keys(transportHeaders).length > 0
              ? { headers: transportHeaders }
              : {}),
            ...(config.transport ? { type: config.transport } : {}),
          }
        }

        const result = await this.addMcpServer(config.name, config.url, options)
        if (result.state === 'authenticating') {
          console.log(
            `[BruhAgent] MCP server ${config.name} requires OAuth: ${result.authUrl}`,
          )
        }
      } catch (error) {
        console.error(
          `[BruhAgent] Failed to connect MCP server ${config.name}:`,
          error instanceof Error ? error.message : error,
        )
      }
    }
  }

  // --- Sandbox ---

  private getSandbox() {
    // Use short, stable IDs — long UUIDs cause Docker container naming issues locally
    const sessionId = this.state.sessionId || this.name || 'main'
    const shortId = sessionId === 'main' ? 'main' : sessionId.slice(0, 8)
    return getSandbox(this.env.SANDBOX, shortId)
  }

  // --- Model provider selection ---

  private getModel() {
    const anthropicKey = this.env.ANTHROPIC_API_KEY?.trim()
    const openaiKey = this.env.OPENAI_API_KEY?.trim()

    if (anthropicKey) {
      const anthropic = createAnthropic({ apiKey: anthropicKey })
      return anthropic('claude-sonnet-4-20250514')
    }

    if (openaiKey) {
      const openai = createOpenAI({ apiKey: openaiKey })
      return openai('gpt-4o')
    }

    throw new Error(
      'No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.',
    )
  }

  // --- Tools ---

  private getTools(): ToolSet {
    const env = this.env

    return {
      // --- Memory tools ---

      memory_read: createTool<{ path: string }>({
        description:
          'Read a file from persistent memory (R2). Paths like "profile.md", "notes/2026-03-25.md", "projects/bruh/todo.md".',
        parameters: jsonSchema<{ path: string }>({
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path relative to memory root',
            },
          },
          required: ['path'],
        }),
        execute: async ({ path }) => {
          const key = normalizePath(path)
          const object = await env.MEMORY_BUCKET.get(`memory/${key}`)
          if (!object) return `File not found: ${key}`
          return await object.text()
        },
      }),

      memory_write: createTool<{ path: string; content: string }>({
        description:
          'Write or overwrite a file in persistent memory. Use for new files or full replacements.',
        parameters: jsonSchema<{ path: string; content: string }>({
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path relative to memory root',
            },
            content: { type: 'string', description: 'Full content to write' },
          },
          required: ['path', 'content'],
        }),
        execute: async ({ path, content }) => {
          const key = normalizePath(path)
          await env.MEMORY_BUCKET.put(`memory/${key}`, content, {
            httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          })
          return `Written: ${key} (${content.length} bytes)`
        },
      }),

      memory_edit: createTool<{
        path: string
        oldText: string
        newText: string
      }>({
        description:
          'Edit a file in persistent memory by replacing exact text. Use for precise updates to existing files.',
        parameters: jsonSchema<{
          path: string
          oldText: string
          newText: string
        }>({
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path relative to memory root',
            },
            oldText: {
              type: 'string',
              description: 'Exact text to find and replace',
            },
            newText: { type: 'string', description: 'Replacement text' },
          },
          required: ['path', 'oldText', 'newText'],
        }),
        execute: async ({ path, oldText, newText }) => {
          const key = normalizePath(path)
          const object = await env.MEMORY_BUCKET.get(`memory/${key}`)
          if (!object) return `File not found: ${key}`

          const content = await object.text()
          const occurrences = content.split(oldText).length - 1
          if (occurrences === 0)
            throw new ToolError(`old text not found in ${key}`)
          if (occurrences > 1)
            throw new ToolError(
              `old text is ambiguous (found ${occurrences} times) in ${key}`,
            )

          const updated = content.replace(oldText, newText)
          await env.MEMORY_BUCKET.put(`memory/${key}`, updated, {
            httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          })
          return `Edited: ${key}`
        },
      }),

      memory_append: createTool<{ path: string; content: string }>({
        description:
          'Append content to a file in persistent memory. Creates the file if it does not exist. Ideal for dated notes and incremental logs.',
        parameters: jsonSchema<{ path: string; content: string }>({
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path relative to memory root',
            },
            content: { type: 'string', description: 'Content to append' },
          },
          required: ['path', 'content'],
        }),
        execute: async ({ path, content }) => {
          const key = normalizePath(path)
          const existing = await env.MEMORY_BUCKET.get(`memory/${key}`)
          const prev = existing ? await existing.text() : ''
          const separator = prev && !prev.endsWith('\n') ? '\n' : ''
          const updated = prev + separator + content
          await env.MEMORY_BUCKET.put(`memory/${key}`, updated, {
            httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          })
          return `Appended to ${key} (now ${updated.length} bytes)`
        },
      }),

      memory_list: createTool<{ prefix?: string }>({
        description:
          'List files in persistent memory. Returns file names and sizes.',
        parameters: jsonSchema<{ prefix?: string }>({
          type: 'object',
          properties: {
            prefix: {
              type: 'string',
              description:
                'Optional prefix to filter, e.g. "notes/", "projects/bruh/"',
            },
          },
        }),
        execute: async ({ prefix }) => {
          const fullPrefix = prefix
            ? `memory/${normalizePath(prefix)}`
            : 'memory/'
          const result = await env.MEMORY_BUCKET.list({
            prefix: fullPrefix,
            limit: 100,
          })
          if (result.objects.length === 0) return 'No files found.'
          return result.objects
            .map((o) => `${o.key.replace(/^memory\//, '')} (${o.size} bytes)`)
            .join('\n')
        },
      }),

      // --- Scheduling tools ---

      schedule_once: createTool<{
        prompt: string
        delaySeconds?: number
        scheduledAt?: string
      }>({
        description:
          'Schedule a one-time task. The agent will be prompted with the message at the scheduled time. The result appears in the transcript.',
        parameters: jsonSchema<{
          prompt: string
          delaySeconds?: number
          scheduledAt?: string
        }>({
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                'Prompt the agent will execute at the scheduled time',
            },
            delaySeconds: {
              type: 'number',
              description: 'Delay in seconds from now',
            },
            scheduledAt: {
              type: 'string',
              description: 'ISO 8601 datetime to fire at',
            },
          },
          required: ['prompt'],
        }),
        execute: async ({ prompt, delaySeconds, scheduledAt }) => {
          let when: Date | number | null = null
          if (scheduledAt) {
            const date = new Date(scheduledAt)
            if (isNaN(date.getTime()))
              throw new ToolError(
                'invalid scheduledAt date format. Use ISO 8601 (e.g. 2026-03-26T10:00:00Z)',
              )
            if (date.getTime() <= Date.now())
              throw new ToolError('scheduledAt must be in the future')
            when = date
          } else if (delaySeconds && delaySeconds > 0) {
            when = delaySeconds
          }
          if (!when) throw new ToolError('provide delaySeconds or scheduledAt')
          const payload = JSON.stringify({ prompt })
          try {
            const schedule = await this.schedule(
              when,
              'executeScheduledTask',
              payload,
            )
            return `Scheduled one-time task (id: ${schedule.id}): "${prompt}"`
          } catch (e) {
            throw new ToolError(
              `scheduling failed: ${e instanceof Error ? e.message : e}`,
            )
          }
        },
      }),

      schedule_recurring: createTool<{
        prompt: string
        intervalSeconds: number
      }>({
        description:
          'Schedule a recurring task. The agent will be prompted repeatedly at the given interval. The result appears in the transcript each time.',
        parameters: jsonSchema<{ prompt: string; intervalSeconds: number }>({
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Prompt the agent will execute each interval',
            },
            intervalSeconds: {
              type: 'number',
              description: 'Seconds between each execution',
            },
          },
          required: ['prompt', 'intervalSeconds'],
        }),
        execute: async ({ prompt, intervalSeconds }) => {
          if (!intervalSeconds || intervalSeconds < 10)
            throw new ToolError('intervalSeconds must be at least 10')
          const payload = JSON.stringify({ prompt })
          try {
            const schedule = await this.scheduleEvery(
              intervalSeconds,
              'executeScheduledTask',
              payload,
            )
            return `Scheduled recurring task every ${intervalSeconds}s (id: ${schedule.id}): "${prompt}"`
          } catch (e) {
            throw new ToolError(
              `scheduling failed: ${e instanceof Error ? e.message : e}`,
            )
          }
        },
      }),

      schedule_list: createTool<Record<string, never>>({
        description: 'List all active scheduled tasks.',
        parameters: jsonSchema<Record<string, never>>({
          type: 'object',
          properties: {},
        }),
        execute: async () => {
          const schedules = this.getSchedules()
          if (schedules.length === 0) return 'No active schedules.'
          return schedules
            .map((s) => {
              const time = s.time ? new Date(s.time).toISOString() : 'recurring'
              const payload =
                typeof s.payload === 'string'
                  ? JSON.parse(s.payload)
                  : s.payload
              const prompt = payload?.prompt || '(unknown)'
              return `${s.id} [${s.type}] at ${time}: "${prompt}"`
            })
            .join('\n')
        },
      }),

      schedule_cancel: createTool<{ scheduleId: string }>({
        description: 'Cancel a scheduled task by its ID.',
        parameters: jsonSchema<{ scheduleId: string }>({
          type: 'object',
          properties: {
            scheduleId: {
              type: 'string',
              description: 'ID of the schedule to cancel',
            },
          },
          required: ['scheduleId'],
        }),
        execute: async ({ scheduleId }) => {
          const cancelled = await this.cancelSchedule(scheduleId)
          return cancelled
            ? `Cancelled schedule ${scheduleId}`
            : `Schedule ${scheduleId} not found`
        },
      }),

      // --- Thread tools ---

      thread_list: createTool<Record<string, never>>({
        description:
          'List all side threads (not main). Returns thread IDs and creation times.',
        parameters: jsonSchema<Record<string, never>>({
          type: 'object',
          properties: {},
        }),
        execute: async () => {
          try {
            const registryStub = await getAgentByName(
              env.BRUH_AGENT as any,
              '__registry__',
            )
            const response = await registryStub.fetch(
              new Request('https://agent/threads'),
            )
            if (!response.ok) return 'Failed to list threads.'
            const data = (await response.json()) as {
              sessions: Array<{ sessionId: string; createdAt: string }>
            }
            if (!data.sessions?.length) return 'No side threads.'
            return data.sessions
              .map((t) => `${t.sessionId} (created ${t.createdAt})`)
              .join('\n')
          } catch (e) {
            return `Error listing threads: ${e instanceof Error ? e.message : e}`
          }
        },
      }),

      thread_summary: createTool<{ threadId: string }>({
        description: 'Read the summary of a side thread from memory.',
        parameters: jsonSchema<{ threadId: string }>({
          type: 'object',
          properties: {
            threadId: {
              type: 'string',
              description: 'Thread/session ID to read summary for',
            },
          },
          required: ['threadId'],
        }),
        execute: async ({ threadId }) => {
          const key = `memory/sessions/${threadId}/summary.md`
          const object = await env.MEMORY_BUCKET.get(key)
          if (!object) return `No summary found for thread ${threadId}`
          return await object.text()
        },
      }),

      // --- MCP tools ---

      mcp_servers: createTool<Record<string, never>>({
        description: 'List connected MCP servers and their status.',
        parameters: jsonSchema<Record<string, never>>({
          type: 'object',
          properties: {},
        }),
        execute: async () => {
          const state = this.getMcpServers()
          const servers = Object.entries(state.servers)
          if (servers.length === 0) return 'No MCP servers connected.'
          return servers
            .map(([, s]) => {
              let line = `${s.name} (${s.state}) — ${s.server_url}`
              if (s.state === 'authenticating' && s.auth_url) {
                line += `\n  Auth URL: ${s.auth_url}`
              }
              if (s.state === 'failed' && s.error) {
                line += `\n  Error: ${s.error}`
              }
              return line
            })
            .join('\n')
        },
      }),

      mcp_tools: createTool<Record<string, never>>({
        description: 'List all tools available from connected MCP servers.',
        parameters: jsonSchema<Record<string, never>>({
          type: 'object',
          properties: {},
        }),
        execute: async () => {
          const state = this.getMcpServers()
          const tools = state.tools ?? []
          if (tools.length === 0) return 'No MCP tools available.'
          return tools
            .map(
              (t) =>
                `${t.name}: ${t.description || '(no description)'} [server: ${t.serverId}]`,
            )
            .join('\n')
        },
      }),

      mcp_connect: createTool<{
        name: string
        url: string
        headers?: Record<string, string>
      }>({
        description:
          'Connect to an MCP server. For OAuth servers, returns an authorization URL the user must visit. For non-OAuth servers, connects immediately. MCP tools become available on the next turn.',
        parameters: jsonSchema<{
          name: string
          url: string
          headers?: Record<string, string>
        }>({
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name for this server' },
            url: { type: 'string', description: 'Server URL' },
            headers: {
              type: 'object',
              description: 'Optional transport headers (e.g. Authorization)',
            },
          },
          required: ['name', 'url'],
        }),
        execute: async ({ name, url, headers }) => {
          try {
            const callbackHost = this.env.HOST?.trim()
            const options: Record<string, unknown> = {}
            if (callbackHost) {
              options.callbackHost = callbackHost
            }
            if (headers && Object.keys(headers).length > 0) {
              options.transport = { headers }
            }

            console.log(
              `[MCP] addMcpServer("${name}", "${url}", ${JSON.stringify(options)})`,
            )
            const result = await this.addMcpServer(name, url, options)
            console.log(`[MCP] addMcpServer result:`, JSON.stringify(result))

            // addMcpServer may return "ready" before the async connection settles.
            // Wait briefly then check the actual server state.
            await new Promise((r) => setTimeout(r, 3000))
            const state = this.getMcpServers()
            const server = Object.values(state.servers).find(
              (s) => s.name === name,
            )
            console.log(
              `[MCP] actual server state after 3s:`,
              JSON.stringify(server),
            )

            if (server?.state === 'authenticating' && server.auth_url) {
              return `🔐 Server "${name}" requires OAuth authorization.\n\nPlease visit this URL to authorize:\n${server.auth_url}\n\nOnce authorized, the server's tools will become available on the next message.`
            }

            if (server?.state === 'authenticating') {
              return `🔐 Server "${name}" requires OAuth but no authorization URL was provided. The server may need additional configuration.`
            }

            if (server?.state === 'failed') {
              throw new ToolError(
                `failed to connect to "${name}": ${server.error || 'unknown error'}`,
              )
            }

            if (server?.state === 'ready') {
              const toolCount =
                state.tools?.filter((t) => t.serverId === result.id).length ?? 0
              return `Connected to MCP server: ${name} (${toolCount} tools available).`
            }

            // Still connecting/discovering — let the user know
            return `Connecting to "${name}" (state: ${server?.state ?? 'unknown'}). Tools will be available once the server is ready.`
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e)
            console.error(`[MCP] addMcpServer failed:`, errMsg)
            throw new ToolError(`failed to connect: ${errMsg}`)
          }
        },
      }),

      mcp_disconnect: createTool<{ name: string }>({
        description: 'Disconnect from an MCP server by name.',
        parameters: jsonSchema<{ name: string }>({
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Server name to disconnect' },
          },
          required: ['name'],
        }),
        execute: async ({ name }) => {
          try {
            // Look up the server ID by name
            const state = this.getMcpServers()
            const entry = Object.entries(state.servers).find(
              ([, s]) => s.name === name,
            )
            if (!entry)
              throw new ToolError(`no MCP server found with name: ${name}`)
            await this.removeMcpServer(entry[0])
            return `Disconnected MCP server: ${name}`
          } catch (e) {
            throw new ToolError(
              `failed to disconnect: ${e instanceof Error ? e.message : e}`,
            )
          }
        },
      }),

      // Note: MCP tools from connected servers are automatically available to the model
      // via this.mcp.getAITools() — no need for a manual mcp_call wrapper.

      // --- Sandbox tools (code execution, filesystem, git) ---

      sandbox_exec: createTool<{
        command: string
        cwd?: string
        timeout?: number
      }>({
        description:
          'Execute a shell command in an isolated sandbox container. Has bash, git, python3, node, and common CLI tools. The sandbox filesystem persists across calls within the same session.',
        parameters: jsonSchema<{
          command: string
          cwd?: string
          timeout?: number
        }>({
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Shell command to execute',
            },
            cwd: {
              type: 'string',
              description: 'Working directory (default: /workspace)',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 30000)',
            },
          },
          required: ['command'],
        }),
        execute: async ({ command, cwd, timeout }) => {
          const sandbox = this.getSandbox()
          const result = await sandbox.exec(command, {
            cwd: cwd || '/workspace',
            timeout: timeout || 30_000,
          })
          const output = [result.stdout, result.stderr]
            .filter(Boolean)
            .join('\n')
          if (!result.success) {
            throw new ToolError(
              `exit code ${result.exitCode}\n${output}`.trim(),
            )
          }
          return output || '(no output)'
        },
      }),

      sandbox_read: createTool<{ path: string }>({
        description: 'Read a file from the sandbox filesystem.',
        parameters: jsonSchema<{ path: string }>({
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path in the sandbox',
            },
          },
          required: ['path'],
        }),
        execute: async ({ path }) => {
          const sandbox = this.getSandbox()
          const file = await sandbox.readFile(path)
          return file.content
        },
      }),

      sandbox_write: createTool<{ path: string; content: string }>({
        description:
          'Write a file to the sandbox filesystem. Creates parent directories automatically.',
        parameters: jsonSchema<{ path: string; content: string }>({
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path in the sandbox',
            },
            content: { type: 'string', description: 'File content to write' },
          },
          required: ['path', 'content'],
        }),
        execute: async ({ path, content }) => {
          const sandbox = this.getSandbox()
          // Ensure parent directory exists
          const dir = path.substring(0, path.lastIndexOf('/'))
          if (dir) await sandbox.mkdir(dir, { recursive: true }).catch(() => {})
          await sandbox.writeFile(path, content)
          return `Written: ${path} (${content.length} bytes)`
        },
      }),

      sandbox_list: createTool<{ path: string }>({
        description: 'List files and directories in the sandbox filesystem.',
        parameters: jsonSchema<{ path: string }>({
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path to list (default: /workspace)',
            },
          },
          required: ['path'],
        }),
        execute: async ({ path }) => {
          const sandbox = this.getSandbox()
          const result = await sandbox.listFiles(path || '/workspace')
          if (!result.files?.length) return 'Empty directory.'
          return result.files
            .map(
              (f: any) =>
                `${f.type === 'directory' ? 'd' : '-'} ${f.name}${f.size != null ? ` (${f.size} bytes)` : ''}`,
            )
            .join('\n')
        },
      }),

      sandbox_git_clone: createTool<{
        url: string
        branch?: string
        targetDir?: string
      }>({
        description:
          'Clone a git repository into the sandbox. Defaults to /workspace/<repo-name>.',
        parameters: jsonSchema<{
          url: string
          branch?: string
          targetDir?: string
        }>({
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Git repository URL' },
            branch: {
              type: 'string',
              description: 'Branch to checkout (default: default branch)',
            },
            targetDir: {
              type: 'string',
              description: 'Target directory (default: /workspace/<repo-name>)',
            },
          },
          required: ['url'],
        }),
        execute: async ({ url, branch, targetDir }) => {
          const sandbox = this.getSandbox()
          const repoName =
            url
              .replace(/\.git$/, '')
              .split('/')
              .pop() || 'repo'
          const dest = targetDir || `/workspace/${repoName}`
          await sandbox.gitCheckout(url, {
            branch,
            targetDir: dest,
            depth: 1,
          })
          return `Cloned ${url}${branch ? ` (branch: ${branch})` : ''} to ${dest}`
        },
      }),
    }
  }

  // --- AIChatAgent: the agent loop ---

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const model = this.getModel()
    // Merge custom tools with MCP tools from connected servers
    const mcpTools = this.mcp.getAITools()
    const tools = { ...this.getTools(), ...mcpTools }

    // Set title from first user message
    const lastUserMessage = [...this.messages]
      .reverse()
      .find((m) => m.role === 'user')
    if (lastUserMessage && !this.state.title) {
      const textPart = lastUserMessage.parts?.find((p) => p.type === 'text')
      if (textPart && 'text' in textPart) {
        this.setState({
          ...this.state,
          title: createSessionTitle(textPart.text),
          updatedAt: new Date().toISOString(),
        })
      }
    }

    const modelMessages = await convertToModelMessages(
      sanitizeMessages(this.messages),
    )

    // Wrap onFinish to auto-write session summary
    const wrappedOnFinish: StreamTextOnFinishCallback<ToolSet> = async (
      event,
    ) => {
      await onFinish(event)
      // Auto-write session summary to R2
      this.ctx.waitUntil(this.writeSessionSummary(event.text || ''))
    }

    const result = streamText({
      model,
      messages: modelMessages,
      system: SYSTEM_PROMPT,
      tools,
      stopWhen: stepCountIs(10),
      onFinish: wrappedOnFinish,
      abortSignal: options?.abortSignal,
    })

    return result.toUIMessageStreamResponse()
  }

  // --- Session summaries ---

  private async writeSessionSummary(latestResponse: string): Promise<void> {
    try {
      const sessionId = this.state.sessionId || this.name
      if (!sessionId) return

      // Build a brief summary from recent messages
      const recentMessages = this.messages.slice(-10)
      const lines: string[] = [
        `# Session Summary: ${sessionId}`,
        `Updated: ${new Date().toISOString()}`,
        '',
      ]

      for (const msg of recentMessages) {
        const role =
          msg.role === 'user'
            ? 'User'
            : msg.role === 'assistant'
              ? 'Assistant'
              : msg.role
        const textPart = msg.parts?.find((p) => p.type === 'text')
        if (textPart && 'text' in textPart) {
          const text =
            textPart.text.length > 200
              ? textPart.text.slice(0, 200) + '…'
              : textPart.text
          lines.push(`**${role}:** ${text}`, '')
        }
      }

      const summary = lines.join('\n')
      await this.env.MEMORY_BUCKET.put(
        `memory/sessions/${sessionId}/summary.md`,
        summary,
        {
          httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
        },
      )
    } catch (error) {
      console.error('[BruhAgent] Failed to write session summary:', error)
    }
  }

  // --- Scheduled task execution ---

  async executeScheduledTask(rawPayload: string): Promise<void> {
    let prompt: string
    try {
      const parsed = JSON.parse(rawPayload) as {
        prompt?: string
        message?: string
      }
      prompt = parsed.prompt || parsed.message || rawPayload
    } catch {
      prompt = rawPayload
    }

    console.log(`[BruhAgent] Executing scheduled task: "${prompt}"`)

    try {
      // Run as an ephemeral agent — standalone prompt, not part of conversation history.
      // The agent has tools (memory etc.) so it can look up context if needed.
      const model = this.getModel()
      const tools = this.getTools()

      const result = await generateText({
        model,
        prompt: prompt,
        system: `${SYSTEM_PROMPT}\n\nYou are executing a scheduled task. Carry out the task and report the result concisely. The user will see your response in their chat transcript.`,
        tools,
        stopWhen: stepCountIs(10),
      })

      const responseText = result.text?.trim()
      if (!responseText) {
        console.log('[BruhAgent] Scheduled task produced no text output')
        return
      }

      // Post only the result as an assistant message in the transcript
      const assistantMessage = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: `⏰ ${responseText}` }],
        createdAt: new Date(),
      }
      this.messages.push(assistantMessage)
      await this.saveMessages(this.messages)

      console.log(
        `[BruhAgent] Scheduled task completed: ${result.text?.length ?? 0} chars`,
      )
    } catch (error) {
      console.error('[BruhAgent] Scheduled task failed:', error)

      const errorMessage = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        parts: [
          {
            type: 'text' as const,
            text: `⚠️ Scheduled task failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          },
        ],
        createdAt: new Date(),
      }
      this.messages.push(errorMessage)
      await this.saveMessages(this.messages)
    }
  }

  // --- Custom request handling ---

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)

    switch (`${request.method} ${url.pathname}`) {
      case 'POST /init':
        return this.handleInit(request)
      case 'GET /state':
        return this.handleState()
      case 'POST /prompt':
        return this.handleHttpPrompt(request)
      case 'POST /steer':
        return this.handleHttpSteer(request)
      case 'POST /follow-up':
        return this.handleHttpFollowUp(request)
      case 'POST /abort':
        return this.handleHttpAbort()
      case 'POST /register-thread':
        return this.handleRegisterThread(request)
      case 'GET /threads':
        return this.handleListThreads()
      // Legacy event system (remove once web app fully migrated)
      case 'GET /events':
        return this.handleGetEvents(request)
      case 'GET /stream':
        return this.handleStream(request)
      default:
        return super.onRequest(request)
    }
  }

  // --- HTTP prompt / steer / follow-up / abort ---

  private async handleHttpPrompt(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { text?: string }
    const text = body.text?.trim()
    if (!text)
      return Response.json({ error: 'text is required' }, { status: 400 })

    if (!this.state.title) {
      this.setState({
        ...this.state,
        title: createSessionTitle(text),
        updatedAt: new Date().toISOString(),
      })
    }

    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: text,
      parts: [{ type: 'text' as const, text }],
      createdAt: new Date(),
    }
    this.messages.push(userMessage)

    const model = this.getModel()
    const mcpTools = this.mcp.getAITools()
    const tools = { ...this.getTools(), ...mcpTools }
    const modelMessages = await convertToModelMessages(
      sanitizeMessages(this.messages),
    )

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
        }
        this.messages.push(assistantMessage)
        await this.saveMessages(this.messages)
        this.ctx.waitUntil(this.writeSessionSummary(event.text || ''))
      },
    })

    return result.toUIMessageStreamResponse()
  }

  private async handleHttpSteer(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { text?: string }
    const text = body.text?.trim()
    if (!text)
      return Response.json({ error: 'text is required' }, { status: 400 })

    // Steer: add as a system-level instruction that the agent should incorporate
    const steerMessage = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: `[STEER] ${text}`,
      parts: [{ type: 'text' as const, text: `[STEER] ${text}` }],
      createdAt: new Date(),
    }
    this.messages.push(steerMessage)

    return Response.json({ ok: true, queued: true })
  }

  private async handleHttpFollowUp(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { text?: string }
    const text = body.text?.trim()
    if (!text)
      return Response.json({ error: 'text is required' }, { status: 400 })

    // Follow-up: queue for after current turn finishes — add to messages
    const followUpMessage = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: text,
      parts: [{ type: 'text' as const, text }],
      createdAt: new Date(),
    }
    this.messages.push(followUpMessage)

    return Response.json({ ok: true, queued: true })
  }

  private async handleHttpAbort(): Promise<Response> {
    // The abort is handled by the AbortSignal on the active stream
    // For now, return ok — the client can close the connection
    return Response.json({ ok: true, aborted: true })
  }

  // --- Session / thread init ---

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string
      title?: string
    }
    const requestedTitle = body.title?.trim()

    if (!this.state.sessionId) {
      const now = new Date().toISOString()
      this.setState({
        sessionId: body.sessionId || this.name || crypto.randomUUID(),
        status: 'idle',
        title: requestedTitle,
        createdAt: now,
        updatedAt: now,
        latestSeq: 0,
      })
    } else if (requestedTitle && !this.state.title) {
      this.setState({
        ...this.state,
        title: requestedTitle,
        updatedAt: new Date().toISOString(),
      })
    }

    return Response.json(this.toMetadata())
  }

  private handleState(): Response {
    return Response.json(this.toMetadata())
  }

  // --- Thread registry ---

  private async handleRegisterThread(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string
      createdAt?: string
    }
    const sessionId = body.sessionId?.trim()
    if (!sessionId)
      return Response.json({ error: 'sessionId is required' }, { status: 400 })

    const existing = this.sql<{
      session_id: string
    }>`SELECT session_id FROM thread_registry WHERE session_id = ${sessionId}`
    if (existing.length === 0) {
      const createdAt = body.createdAt?.trim() || new Date().toISOString()
      this
        .sql`INSERT INTO thread_registry (session_id, created_at) VALUES (${sessionId}, ${createdAt})`
    }

    return Response.json({ ok: true, sessionId })
  }

  private handleListThreads(): Response {
    const threads = this.sql<{ session_id: string; created_at: string }>`
      SELECT session_id, created_at FROM thread_registry ORDER BY created_at DESC
    `
    return Response.json({
      sessions: threads.map((t) => ({
        sessionId: t.session_id,
        createdAt: t.created_at,
      })),
    })
  }

  // --- Legacy event system ---

  private async handleGetEvents(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const afterSeq = Number(url.searchParams.get('after') ?? '0') || 0
    return Response.json({ events: this.getEventsAfter(afterSeq) })
  }

  private async handleStream(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const afterSeq =
      Number(
        url.searchParams.get('after') ??
          request.headers.get('last-event-id') ??
          '0',
      ) || 0

    const stream = new TransformStream<Uint8Array, Uint8Array>()
    const writer = stream.writable.getWriter()
    const encoder = new TextEncoder()
    let closed = false

    const write = async (chunk: string) => {
      if (closed) return
      try {
        await writer.write(encoder.encode(chunk))
      } catch {
        closed = true
      }
    }

    this.ctx.waitUntil(
      (async () => {
        await write(`: connected to ${this.state.sessionId}\n\n`)
        for (const event of this.getEventsAfter(afterSeq)) {
          await write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
        }
      })().catch(() => {
        closed = true
      }),
    )

    request.signal.addEventListener(
      'abort',
      () => {
        closed = true
        void writer.close().catch(() => undefined)
      },
      { once: true },
    )

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
      },
    })
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
    }
  }

  private getEventsAfter(afterSeq: number): SessionEventEnvelope[] {
    return this.sql<{
      seq: number
      session_id: string
      type: string
      timestamp: string
      payload: string
    }>`
      SELECT seq, session_id, type, timestamp, payload FROM events WHERE seq > ${afterSeq} ORDER BY seq ASC LIMIT 200
    `.map((row) => ({
      sessionId: row.session_id,
      seq: row.seq,
      type: row.type,
      timestamp: row.timestamp,
      payload: JSON.parse(row.payload),
    }))
  }

  private async appendEvent(
    type: string,
    payload: Record<string, unknown>,
    timestamp?: string,
  ): Promise<SessionEventEnvelope> {
    const now = new Date().toISOString()
    const nextSeq = this.state.latestSeq + 1
    this.setState({ ...this.state, latestSeq: nextSeq, updatedAt: now })

    const event: SessionEventEnvelope = {
      sessionId: this.state.sessionId,
      seq: nextSeq,
      type,
      timestamp: timestamp || now,
      payload,
    }
    this
      .sql`INSERT INTO events (seq, session_id, type, timestamp, payload) VALUES (${event.seq}, ${event.sessionId}, ${event.type}, ${event.timestamp}, ${JSON.stringify(event.payload)})`
    this.sql`DELETE FROM events WHERE seq <= ${nextSeq - 200}`
    return event
  }
}
