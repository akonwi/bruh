import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'

interface StorageObjectPayload {
  path: string
  content: string
  etag: string
  version: string
  size: number
  uploadedAt: string
  contentType?: string
}

interface StorageListFile {
  path: string
  etag: string
  version: string
  size: number
  uploadedAt: string
}

interface StorageListPayload {
  prefix: string
  directories: string[]
  files: StorageListFile[]
  truncated: boolean
  cursor?: string
}

interface StorageWritePayload {
  ok: true
  path: string
  etag: string
  version: string
  size: number
  uploadedAt: string
}

const MEMORY_TOOL_GUIDELINES = [
  'Use memory tools for durable notes, profile information, project context, and summaries that should survive across threads.',
  'Memory paths are relative to the memory root. User preferences and standing operating preferences always belong in profile.md. Use notes/YYYY-MM-DD.md for dated notes and projects/<slug>/... for project context.',
  'Session summaries live at sessions/<session-id>/summary.md and are usually auto-maintained by the runtime; read them to rehydrate a thread and only overwrite them intentionally.',
  'Use memory_list() to browse the memory tree before reading or editing unknown paths.',
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

function normalizeRelativePath(input: string, allowEmpty = false): string {
  const normalized = input.replaceAll('\\', '/').trim().replace(/^\/+/, '').replace(/^memory\//, '')

  if (!normalized) {
    if (allowEmpty) return ''
    throw new Error('Path is required.')
  }

  const segments = normalized.split('/')
  for (const segment of segments) {
    if (!segment) {
      throw new Error('Paths may not contain empty segments.')
    }

    if (segment === '.' || segment === '..') {
      throw new Error('Paths may not contain relative path segments.')
    }
  }

  return normalized
}

function normalizeRelativePrefix(input?: string): string {
  const normalized = normalizeRelativePath(input ?? '', true)
  if (!normalized) return ''
  return normalized.endsWith('/') ? normalized : `${normalized}/`
}

function toMemoryKey(relativePath: string): string {
  return relativePath ? `memory/${relativePath}` : 'memory/'
}

function fromMemoryKey(key: string): string {
  if (key === 'memory/' || key === 'memory') {
    return ''
  }

  return key.replace(/^memory\//, '')
}

function formatListText(prefix: string, listing: StorageListPayload): string {
  const directoryLines = listing.directories.map((entry) => `- ${fromMemoryKey(entry)}`)
  const fileLines = listing.files.map((entry) => `- ${fromMemoryKey(entry.path)} (${formatSize(entry.size)})`)
  const label = prefix || '/'

  if (directoryLines.length === 0 && fileLines.length === 0) {
    return `Memory is empty under ${label}.`
  }

  const lines = [`Memory listing for ${label}`]
  if (directoryLines.length > 0) {
    lines.push('', 'Directories:', ...directoryLines)
  }
  if (fileLines.length > 0) {
    lines.push('', 'Files:', ...fileLines)
  }
  if (listing.truncated && listing.cursor) {
    lines.push('', `More results are available. Continue listing with prefix ${label}.`)
  }

  return lines.join('\n')
}

function formatReadText(path: string, object: StorageObjectPayload): string {
  const truncation = truncateHead(object.content, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  })

  if (!truncation.truncated) {
    return truncation.content || '(empty file)'
  }

  return `${truncation.content}\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(
    DEFAULT_MAX_BYTES,
  )}. Read a narrower memory file if you need less context.]`
}

async function requestEdge<T>(
  path: string,
  init?: RequestInit,
  options?: { allow404?: boolean },
): Promise<{ status: number; data: T | null }> {
  const response = await fetch(`${getEdgeBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...createHeaders(init?.body !== undefined),
      ...(init?.headers as Record<string, string> | undefined),
    },
  })

  if (options?.allow404 && response.status === 404) {
    return { status: 404, data: null }
  }

  const data = (await response.json().catch(() => null)) as { error?: string } | T | null

  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Edge request failed with status ${response.status}`

    throw new Error(message)
  }

  return { status: response.status, data: data as T }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'memory_list',
    label: 'Memory List',
    description:
      'List durable memory directories and files stored in R2-backed storage. Prefixes are relative to the memory root.',
    promptGuidelines: MEMORY_TOOL_GUIDELINES,
    parameters: Type.Object({
      prefix: Type.Optional(Type.String({ description: 'Optional folder prefix, like projects/ or notes/' })),
    }),
    async execute(_toolCallId, params) {
      const prefix = normalizeRelativePrefix((params as { prefix?: string }).prefix)
      const keyPrefix = toMemoryKey(prefix)
      const search = new URLSearchParams()
      if (keyPrefix) search.set('prefix', keyPrefix)

      const { data } = await requestEdge<StorageListPayload>(`/internal/storage/list?${search.toString()}`)
      const listing = data ?? {
        prefix: keyPrefix,
        directories: [],
        files: [],
        truncated: false,
      }

      return {
        content: [{ type: 'text', text: formatListText(prefix, listing) }],
        details: {
          prefix,
          directories: listing.directories.map(fromMemoryKey),
          files: listing.files.map((file) => ({
            path: fromMemoryKey(file.path),
            size: file.size,
            etag: file.etag,
            uploadedAt: file.uploadedAt,
          })),
        },
      }
    },
  })

  pi.registerTool({
    name: 'memory_read',
    label: 'Memory Read',
    description: `Read a durable memory file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(
      DEFAULT_MAX_BYTES,
    )} (whichever is hit first).`,
    promptGuidelines: MEMORY_TOOL_GUIDELINES,
    parameters: Type.Object({
      path: Type.String({ description: 'Memory file path, like profile.md or projects/bruh/todo.md' }),
    }),
    async execute(_toolCallId, params) {
      const path = normalizeRelativePath((params as { path: string }).path)
      const key = toMemoryKey(path)
      const search = new URLSearchParams({ path: key })
      const { data } = await requestEdge<StorageObjectPayload>(`/internal/storage/object?${search.toString()}`)

      if (!data) {
        throw new Error(`Memory file not found: ${path}`)
      }

      return {
        content: [{ type: 'text', text: formatReadText(path, data) }],
        details: {
          path,
          etag: data.etag,
          size: data.size,
          uploadedAt: data.uploadedAt,
        },
      }
    },
  })

  pi.registerTool({
    name: 'memory_write',
    label: 'Memory Write',
    description: 'Write a durable memory file, replacing any existing content.',
    promptGuidelines: MEMORY_TOOL_GUIDELINES,
    parameters: Type.Object({
      path: Type.String({ description: 'Memory file path, like profile.md or projects/bruh/todo.md' }),
      content: Type.String({ description: 'Full file contents to write' }),
    }),
    async execute(_toolCallId, params) {
      const { path: rawPath, content } = params as { path: string; content: string }
      const path = normalizeRelativePath(rawPath)
      const key = toMemoryKey(path)
      const search = new URLSearchParams({ path: key })
      const { data } = await requestEdge<StorageWritePayload>(`/internal/storage/object?${search.toString()}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      })

      return {
        content: [{ type: 'text', text: `Wrote ${path} (${content.length} chars).` }],
        details: {
          path,
          etag: data?.etag,
          size: data?.size,
          uploadedAt: data?.uploadedAt,
        },
      }
    },
  })

  pi.registerTool({
    name: 'memory_edit',
    label: 'Memory Edit',
    description:
      'Edit a durable memory file by replacing one exact occurrence of oldText with newText. Fails if oldText is missing or ambiguous.',
    promptGuidelines: MEMORY_TOOL_GUIDELINES,
    parameters: Type.Object({
      path: Type.String({ description: 'Memory file path, like profile.md or projects/bruh/todo.md' }),
      oldText: Type.String({ description: 'Exact text to replace. Must occur exactly once.' }),
      newText: Type.String({ description: 'Replacement text' }),
    }),
    async execute(_toolCallId, params) {
      const { path: rawPath, oldText, newText } = params as {
        path: string
        oldText: string
        newText: string
      }
      const path = normalizeRelativePath(rawPath)
      const key = toMemoryKey(path)
      const { data } = await requestEdge<StorageWritePayload>('/internal/storage/edit', {
        method: 'POST',
        body: JSON.stringify({
          path: key,
          oldText,
          newText,
        }),
      })

      return {
        content: [{ type: 'text', text: `Edited ${path}.` }],
        details: {
          path,
          etag: data?.etag,
          size: data?.size,
          uploadedAt: data?.uploadedAt,
        },
      }
    },
  })

  pi.registerTool({
    name: 'memory_append',
    label: 'Memory Append',
    description: 'Append text to a durable memory file. Creates the file if it does not exist.',
    promptGuidelines: MEMORY_TOOL_GUIDELINES,
    parameters: Type.Object({
      path: Type.String({ description: 'Memory file path, like notes/2026-03-24.md' }),
      content: Type.String({ description: 'Text to append' }),
    }),
    async execute(_toolCallId, params) {
      const { path: rawPath, content } = params as { path: string; content: string }
      const path = normalizeRelativePath(rawPath)
      const key = toMemoryKey(path)
      const search = new URLSearchParams({ path: key })
      const existing = await requestEdge<StorageObjectPayload>(
        `/internal/storage/object?${search.toString()}`,
        undefined,
        { allow404: true },
      )

      const existingContent = existing.data?.content ?? ''
      const nextContent = `${existingContent}${content}`
      const write = await requestEdge<StorageWritePayload>(`/internal/storage/object?${search.toString()}`, {
        method: 'PUT',
        body: JSON.stringify({
          content: nextContent,
          ifMatch: existing.data?.etag,
        }),
      })

      return {
        content: [{ type: 'text', text: `Appended ${content.length} chars to ${path}.` }],
        details: {
          path,
          etag: write.data?.etag,
          size: write.data?.size,
          uploadedAt: write.data?.uploadedAt,
        },
      }
    },
  })
}
