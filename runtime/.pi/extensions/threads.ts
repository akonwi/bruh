import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'

interface ThreadMetadata {
  sessionId: string
  createdAt: string
  updatedAt: string
  status: string
  title?: string
}

interface StorageObjectPayload {
  path: string
  content: string
  etag: string
  version: string
  size: number
  uploadedAt: string
}

const THREAD_TOOL_GUIDELINES = [
  'Use thread tools to inspect the status and summaries of side threads without loading full transcripts.',
  'thread_list shows all side threads with their title, status, and last activity.',
  'thread_summary reads the rolling summary of a specific thread, useful for understanding what happened there.',
  'These tools help the main thread stay aware of work happening in side threads.',
]

function getEdgeBaseUrl(): string {
  return (process.env.EDGE_BASE_URL?.trim() || 'http://localhost:8790').replace(/\/+$/, '')
}

function getInternalSecret(): string | undefined {
  return process.env.INTERNAL_API_SECRET?.trim() || undefined
}

function createHeaders(includeJson = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (includeJson) {
    headers['Content-Type'] = 'application/json'
  }

  const secret = getInternalSecret()
  if (secret) {
    headers['X-Bruh-Internal-Secret'] = secret
  }

  return headers
}

function formatRelativeTime(isoTimestamp: string): string {
  const now = Date.now()
  const then = new Date(isoTimestamp).getTime()
  const deltaMs = now - then

  if (Number.isNaN(deltaMs) || deltaMs < 0) {
    return isoTimestamp
  }

  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatThreadList(threads: ThreadMetadata[]): string {
  if (threads.length === 0) {
    return 'No side threads exist yet.'
  }

  const lines = [`${threads.length} side thread${threads.length === 1 ? '' : 's'}:`]

  for (const thread of threads) {
    const title = thread.title || 'Untitled'
    const status = thread.status === 'active' ? '● active' : '○ idle'
    const lastActivity = formatRelativeTime(thread.updatedAt)
    lines.push(`- **${title}** (${thread.sessionId}) — ${status}, last active ${lastActivity}`)
  }

  return lines.join('\n')
}

function formatSummaryText(content: string): string {
  const truncation = truncateHead(content, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  })

  if (!truncation.truncated) {
    return truncation.content || '(empty summary)'
  }

  return `${truncation.content}\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(
    DEFAULT_MAX_BYTES,
  )}.]`
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'thread_list',
    label: 'Thread List',
    description: 'List all side threads with their title, status, and last activity. Does not include the main thread.',
    promptGuidelines: THREAD_TOOL_GUIDELINES,
    parameters: Type.Object({}),
    async execute() {
      const response = await fetch(`${getEdgeBaseUrl()}/sessions`, {
        headers: createHeaders(),
      })

      if (!response.ok) {
        throw new Error(`Failed to list threads: ${response.status}`)
      }

      const data = (await response.json()) as { sessions?: ThreadMetadata[] }
      const threads = data.sessions ?? []

      return {
        content: [{ type: 'text', text: formatThreadList(threads) }],
        details: {
          count: threads.length,
          threads: threads.map((t) => ({
            sessionId: t.sessionId,
            title: t.title,
            status: t.status,
            updatedAt: t.updatedAt,
          })),
        },
      }
    },
  })

  pi.registerTool({
    name: 'thread_summary',
    label: 'Thread Summary',
    description:
      'Read the rolling summary of a specific thread. Summaries are auto-maintained snapshots of recent conversation, useful for understanding what happened in a side thread without loading its full transcript.',
    promptGuidelines: THREAD_TOOL_GUIDELINES,
    parameters: Type.Object({
      threadId: Type.String({ description: 'The session/thread ID to read the summary for' }),
    }),
    async execute(_toolCallId, params) {
      const { threadId } = params as { threadId: string }
      const trimmed = threadId.trim()
      if (!trimmed) {
        throw new Error('threadId is required')
      }

      const memoryPath = `memory/sessions/${trimmed}/summary.md`
      const search = new URLSearchParams({ path: memoryPath })
      const response = await fetch(`${getEdgeBaseUrl()}/internal/storage/object?${search.toString()}`, {
        headers: createHeaders(),
      })

      if (response.status === 404) {
        return {
          content: [{ type: 'text', text: `No summary found for thread ${trimmed}. The thread may not have had any completed runs yet.` }],
          details: { threadId: trimmed, found: false },
        }
      }

      if (!response.ok) {
        throw new Error(`Failed to read thread summary: ${response.status}`)
      }

      const data = (await response.json()) as StorageObjectPayload | null
      if (!data?.content) {
        return {
          content: [{ type: 'text', text: `No summary content for thread ${trimmed}.` }],
          details: { threadId: trimmed, found: false },
        }
      }

      return {
        content: [{ type: 'text', text: formatSummaryText(data.content) }],
        details: {
          threadId: trimmed,
          found: true,
          size: data.size,
          updatedAt: data.uploadedAt,
        },
      }
    },
  })
}
