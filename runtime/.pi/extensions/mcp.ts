import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'

interface McpServer {
  id: string
  name: string
  state: string
  url?: string
}

interface McpTool {
  name: string
  description?: string
  serverId: string
  inputSchema?: unknown
}

const MCP_TOOL_GUIDELINES = [
  'MCP tools let you connect to external tool servers and call their tools.',
  'Use mcp_connect to add a server, mcp_tools to discover available tools, and mcp_call to invoke them.',
  'MCP connections persist for the lifetime of the thread agent instance.',
]

function getEdgeBaseUrl(): string {
  return (process.env.EDGE_BASE_URL?.trim() || 'http://localhost:8790').replace(/\/+$/, '')
}

function getInternalSecret(): string | undefined {
  return process.env.INTERNAL_API_SECRET?.trim() || undefined
}

function createHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  const secret = getInternalSecret()
  if (secret) {
    headers['X-Bruh-Internal-Secret'] = secret
  }

  return headers
}

function getSessionId(ctx: { cwd: string }): string {
  return ctx.cwd.split('/').pop() || 'main'
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'mcp_connect',
    label: 'MCP Connect',
    description:
      'Connect to an external MCP server by URL. Once connected, its tools become available via mcp_tools and mcp_call.',
    promptGuidelines: MCP_TOOL_GUIDELINES,
    parameters: Type.Object({
      name: Type.String({ description: 'A short name for this server (e.g., "github", "slack")' }),
      url: Type.String({ description: 'URL of the MCP server' }),
      apiKey: Type.Optional(
        Type.String({ description: 'API key or bearer token for servers that require explicit auth. Sent as Authorization: Bearer <key>.' }),
      ),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: 'Custom HTTP headers for servers that need specific auth headers.',
        }),
      ),
      transport: Type.Optional(
        Type.Union([Type.Literal('auto'), Type.Literal('streamable-http'), Type.Literal('sse')], {
          description: 'Transport type. Default: auto.',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { name, url, apiKey, headers: customHeaders, transport: transportType } = params as {
        name: string
        url: string
        apiKey?: string
        headers?: Record<string, string>
        transport?: string
      }
      const sessionId = getSessionId(ctx)

      const edgeBaseUrl = getEdgeBaseUrl()

      const transportHeaders: Record<string, string> = { ...customHeaders }
      if (apiKey?.trim()) {
        transportHeaders['Authorization'] = `Bearer ${apiKey.trim()}`
      }

      const connectBody: Record<string, unknown> = {
        name: name.trim(),
        url: url.trim(),
        callbackHost: edgeBaseUrl,
      }

      if (Object.keys(transportHeaders).length > 0 || transportType) {
        connectBody.transport = {
          ...(Object.keys(transportHeaders).length > 0 ? { headers: transportHeaders } : {}),
          ...(transportType ? { type: transportType } : {}),
        }
      }

      const response = await fetch(
        `${edgeBaseUrl}/internal/sessions/${encodeURIComponent(sessionId)}/mcp/connect`,
        {
          method: 'POST',
          headers: createHeaders(),
          body: JSON.stringify(connectBody),
        },
      )

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        throw new Error(`Failed to connect to MCP server: ${response.status} ${errorBody}`)
      }

      const result = (await response.json()) as {
        ok: boolean
        id: string
        state: string
        authUrl?: string
      }

      if (result.authUrl) {
        return {
          content: [
            {
              type: 'text',
              text: `MCP server "${name}" requires authentication.\n\nPlease open this URL to authorize:\n${result.authUrl}\n\nOnce authorized, the server will be ready to use. Run mcp_servers to check the status.`,
            },
          ],
          details: { id: result.id, name, url, state: result.state, authUrl: result.authUrl },
        }
      }

      if (result.state === 'authenticating') {
        return {
          content: [
            {
              type: 'text',
              text: `MCP server "${name}" requires authentication but the auth URL was not returned. This can happen if the initial connection timed out. Try disconnecting with mcp_disconnect and reconnecting.`,
            },
          ],
          details: { id: result.id, name, url, state: result.state },
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `Connected to MCP server "${name}" (${url}). State: ${result.state}. Use mcp_tools to see available tools.`,
          },
        ],
        details: { id: result.id, name, url, state: result.state },
      }
    },
  })

  pi.registerTool({
    name: 'mcp_disconnect',
    label: 'MCP Disconnect',
    description: 'Disconnect from a connected MCP server.',
    promptGuidelines: MCP_TOOL_GUIDELINES,
    parameters: Type.Object({
      name: Type.String({ description: 'Name of the MCP server to disconnect' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { name } = params as { name: string }
      const sessionId = getSessionId(ctx)

      const response = await fetch(
        `${getEdgeBaseUrl()}/internal/sessions/${encodeURIComponent(sessionId)}/mcp/disconnect`,
        {
          method: 'POST',
          headers: createHeaders(),
          body: JSON.stringify({ name: name.trim() }),
        },
      )

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        throw new Error(`Failed to disconnect: ${response.status} ${errorBody}`)
      }

      return {
        content: [{ type: 'text', text: `Disconnected from MCP server "${name}".` }],
        details: { name },
      }
    },
  })

  pi.registerTool({
    name: 'mcp_servers',
    label: 'MCP Servers',
    description: 'List connected MCP servers.',
    promptGuidelines: MCP_TOOL_GUIDELINES,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx)

      const response = await fetch(
        `${getEdgeBaseUrl()}/internal/sessions/${encodeURIComponent(sessionId)}/mcp/servers`,
        { headers: createHeaders() },
      )

      if (!response.ok) {
        throw new Error(`Failed to list MCP servers: ${response.status}`)
      }

      const data = (await response.json()) as { servers: McpServer[] }

      if (data.servers.length === 0) {
        return {
          content: [{ type: 'text', text: 'No MCP servers connected.' }],
          details: { count: 0 },
        }
      }

      const lines = data.servers.map(
        (s) => `- **${s.name}** (${s.id}) — ${s.state}${s.url ? ` — ${s.url}` : ''}`,
      )

      return {
        content: [
          { type: 'text', text: `${data.servers.length} connected MCP server${data.servers.length === 1 ? '' : 's'}:\n${lines.join('\n')}` },
        ],
        details: { count: data.servers.length, servers: data.servers },
      }
    },
  })

  pi.registerTool({
    name: 'mcp_tools',
    label: 'MCP Tools',
    description: 'List all tools available from connected MCP servers.',
    promptGuidelines: MCP_TOOL_GUIDELINES,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx)

      const response = await fetch(
        `${getEdgeBaseUrl()}/internal/sessions/${encodeURIComponent(sessionId)}/mcp/tools`,
        { headers: createHeaders() },
      )

      if (!response.ok) {
        throw new Error(`Failed to list MCP tools: ${response.status}`)
      }

      const data = (await response.json()) as { tools: McpTool[] }

      if (data.tools.length === 0) {
        return {
          content: [
            { type: 'text', text: 'No MCP tools available. Connect to an MCP server first.' },
          ],
          details: { count: 0 },
        }
      }

      const lines = data.tools.map(
        (t) => `- **${t.name}** (server: ${t.serverId})${t.description ? ` — ${t.description}` : ''}`,
      )

      return {
        content: [
          { type: 'text', text: `${data.tools.length} MCP tool${data.tools.length === 1 ? '' : 's'} available:\n${lines.join('\n')}` },
        ],
        details: { count: data.tools.length, tools: data.tools },
      }
    },
  })

  pi.registerTool({
    name: 'mcp_call',
    label: 'MCP Call Tool',
    description:
      'Call a tool on a connected MCP server. Use mcp_tools first to discover available tools and their parameters.',
    promptGuidelines: MCP_TOOL_GUIDELINES,
    parameters: Type.Object({
      serverId: Type.String({ description: 'ID of the MCP server' }),
      name: Type.String({ description: 'Name of the tool to call' }),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: 'Arguments to pass to the tool',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { serverId, name, arguments: args } = params as {
        serverId: string
        name: string
        arguments?: Record<string, unknown>
      }
      const sessionId = getSessionId(ctx)

      const response = await fetch(
        `${getEdgeBaseUrl()}/internal/sessions/${encodeURIComponent(sessionId)}/mcp/call`,
        {
          method: 'POST',
          headers: createHeaders(),
          body: JSON.stringify({
            serverId: serverId.trim(),
            name: name.trim(),
            arguments: args ?? {},
          }),
        },
      )

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        throw new Error(`MCP tool call failed: ${response.status} ${errorBody}`)
      }

      const data = (await response.json()) as {
        ok: boolean
        result: { content?: Array<{ type: string; text?: string }> }
      }

      const textContent = data.result?.content
        ?.filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('\n')

      return {
        content: [{ type: 'text', text: textContent || '(no text output from tool)' }],
        details: {
          serverId,
          name,
          arguments: args,
          result: data.result,
        },
      }
    },
  })
}
