import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'

const SEARCH_RESULT_LIMIT = 50
const SEARCH_MAX_FILE_BYTES = 256 * 1024
const SYSTEM_ENTRY_NAMES = new Set(['.pi'])

interface WorkspaceSearchMatch {
  path: string
  line: number
  text: string
}

const WORKSPACE_TOOL_GUIDELINES = [
  'Workspace tools operate on the current thread\'s local workspace, not on shared durable memory.',
  'Use workspace tools for thread-local code, scratch files, project files, and artifacts. Use memory tools for durable facts, preferences, notes, and summaries shared across threads.',
  'Paths are relative to the current thread workspace root. Use workspace_list() to discover files before reading or editing unfamiliar paths.',
]

function normalizeRelativePath(input: string, allowEmpty = false): string {
  const normalized = input.replaceAll('\\', '/').trim().replace(/^\/+/, '')

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

function resolveWorkspacePath(cwd: string, relativePath: string): string {
  return path.join(cwd, relativePath)
}

function formatReadText(content: string): string {
  const truncation = truncateHead(content, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  })

  if (!truncation.truncated) {
    return truncation.content || '(empty file)'
  }

  return `${truncation.content}\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(
    DEFAULT_MAX_BYTES,
  )}. Read a narrower file if you need less context.]`
}

function isSystemEntry(relativePath: string): boolean {
  const [firstSegment] = relativePath.split('/')
  return !!firstSegment && SYSTEM_ENTRY_NAMES.has(firstSegment)
}

function assertUserWorkspacePath(relativePath: string): void {
  if (relativePath && isSystemEntry(relativePath)) {
    throw new Error(`Path is reserved for runtime scaffolding: ${relativePath}`)
  }
}

async function listWorkspaceEntries(cwd: string, relativePath = ''): Promise<{
  path: string
  directories: Array<{ path: string }>
  files: Array<{ path: string; size: number }>
}> {
  const normalized = normalizeRelativePath(relativePath, true)
  assertUserWorkspacePath(normalized)
  const targetPath = normalized ? resolveWorkspacePath(cwd, normalized) : cwd
  const entries = await readdir(targetPath, { withFileTypes: true })

  const directories = [] as Array<{ path: string }>
  const files = [] as Array<{ path: string; size: number }>

  for (const entry of entries) {
    const entryRelativePath = normalized ? `${normalized}/${entry.name}` : entry.name
    if (isSystemEntry(entryRelativePath)) {
      continue
    }

    if (entry.isDirectory()) {
      directories.push({ path: entryRelativePath })
      continue
    }

    if (entry.isFile()) {
      const fileStat = await stat(path.join(targetPath, entry.name))
      files.push({ path: entryRelativePath, size: fileStat.size })
    }
  }

  directories.sort((a, b) => a.path.localeCompare(b.path))
  files.sort((a, b) => a.path.localeCompare(b.path))

  return {
    path: normalized,
    directories,
    files,
  }
}

function formatWorkspaceListText(listing: {
  path: string
  directories: Array<{ path: string }>
  files: Array<{ path: string; size: number }>
}): string {
  const label = listing.path || '/'
  if (listing.directories.length === 0 && listing.files.length === 0) {
    return `Workspace is empty under ${label}.`
  }

  const lines = [`Workspace listing for ${label}`]

  if (listing.directories.length > 0) {
    lines.push('', 'Directories:')
    for (const directory of listing.directories) {
      lines.push(`- ${directory.path}`)
    }
  }

  if (listing.files.length > 0) {
    lines.push('', 'Files:')
    for (const file of listing.files) {
      lines.push(`- ${file.path} (${formatSize(file.size)})`)
    }
  }

  return lines.join('\n')
}

async function collectSearchMatches(
  cwd: string,
  relativePath: string,
  query: string,
  matches: WorkspaceSearchMatch[],
): Promise<void> {
  if (matches.length >= SEARCH_RESULT_LIMIT) {
    return
  }

  const normalized = normalizeRelativePath(relativePath, true)
  if (normalized && isSystemEntry(normalized)) {
    return
  }

  const targetPath = normalized ? resolveWorkspacePath(cwd, normalized) : cwd
  const targetStat = await stat(targetPath)

  if (targetStat.isDirectory()) {
    const entries = await readdir(targetPath, { withFileTypes: true })
    for (const entry of entries) {
      const childRelativePath = normalized ? `${normalized}/${entry.name}` : entry.name
      if (isSystemEntry(childRelativePath)) {
        continue
      }

      await collectSearchMatches(cwd, childRelativePath, query, matches)
      if (matches.length >= SEARCH_RESULT_LIMIT) {
        return
      }
    }

    return
  }

  if (!targetStat.isFile() || targetStat.size > SEARCH_MAX_FILE_BYTES) {
    return
  }

  let content: string
  try {
    content = await readFile(targetPath, 'utf-8')
  } catch {
    return
  }

  if (content.includes('\u0000')) {
    return
  }

  const loweredQuery = query.toLowerCase()
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.toLowerCase().includes(loweredQuery)) {
      continue
    }

    matches.push({
      path: normalized,
      line: index + 1,
      text: lines[index] ?? '',
    })

    if (matches.length >= SEARCH_RESULT_LIMIT) {
      return
    }
  }
}

function formatSearchText(query: string, matches: WorkspaceSearchMatch[], searchedPath: string): string {
  if (matches.length === 0) {
    return `No matches for "${query}" under ${searchedPath || '/'}.`
  }

  const lines = [`Matches for "${query}" under ${searchedPath || '/'}:`]
  for (const match of matches) {
    lines.push(`- ${match.path}:${match.line}: ${match.text}`)
  }

  if (matches.length >= SEARCH_RESULT_LIMIT) {
    lines.push('', `Showing the first ${SEARCH_RESULT_LIMIT} matches.`)
  }

  return lines.join('\n')
}

function getWorkspaceRoot(ctx: ExtensionContext): string {
  return ctx.cwd
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'workspace_list',
    label: 'Workspace List',
    description: 'List directories and files in the current thread workspace.',
    promptGuidelines: WORKSPACE_TOOL_GUIDELINES,
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Optional folder path relative to the workspace root' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workspaceRoot = getWorkspaceRoot(ctx)
      const listing = await listWorkspaceEntries(workspaceRoot, (params as { path?: string }).path)

      return {
        content: [{ type: 'text', text: formatWorkspaceListText(listing) }],
        details: {
          path: listing.path,
          directories: listing.directories,
          files: listing.files,
        },
      }
    },
  })

  pi.registerTool({
    name: 'workspace_read',
    label: 'Workspace Read',
    description: `Read a file from the current thread workspace. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(
      DEFAULT_MAX_BYTES,
    )}.`,
    promptGuidelines: WORKSPACE_TOOL_GUIDELINES,
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to the workspace root' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workspaceRoot = getWorkspaceRoot(ctx)
      const relativePath = normalizeRelativePath((params as { path: string }).path)
      assertUserWorkspacePath(relativePath)
      const targetPath = resolveWorkspacePath(workspaceRoot, relativePath)
      const content = await readFile(targetPath, 'utf-8')

      return {
        content: [{ type: 'text', text: formatReadText(content) }],
        details: {
          path: relativePath,
        },
      }
    },
  })

  pi.registerTool({
    name: 'workspace_write',
    label: 'Workspace Write',
    description: 'Write a file into the current thread workspace, replacing any existing content.',
    promptGuidelines: WORKSPACE_TOOL_GUIDELINES,
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to the workspace root' }),
      content: Type.String({ description: 'Full file contents to write' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workspaceRoot = getWorkspaceRoot(ctx)
      const { path: rawPath, content } = params as { path: string; content: string }
      const relativePath = normalizeRelativePath(rawPath)
      assertUserWorkspacePath(relativePath)
      const targetPath = resolveWorkspacePath(workspaceRoot, relativePath)
      await mkdir(path.dirname(targetPath), { recursive: true })
      await writeFile(targetPath, content, 'utf-8')

      return {
        content: [{ type: 'text', text: `Wrote ${relativePath} (${content.length} chars).` }],
        details: {
          path: relativePath,
        },
      }
    },
  })

  pi.registerTool({
    name: 'workspace_edit',
    label: 'Workspace Edit',
    description:
      'Edit a workspace file by replacing one exact occurrence of oldText with newText. Fails if oldText is missing or ambiguous.',
    promptGuidelines: WORKSPACE_TOOL_GUIDELINES,
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to the workspace root' }),
      oldText: Type.String({ description: 'Exact text to replace. Must occur exactly once.' }),
      newText: Type.String({ description: 'Replacement text' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workspaceRoot = getWorkspaceRoot(ctx)
      const { path: rawPath, oldText, newText } = params as {
        path: string
        oldText: string
        newText: string
      }

      const relativePath = normalizeRelativePath(rawPath)
      assertUserWorkspacePath(relativePath)
      const targetPath = resolveWorkspacePath(workspaceRoot, relativePath)
      const content = await readFile(targetPath, 'utf-8')
      const occurrences = content.split(oldText).length - 1

      if (occurrences === 0) {
        throw new Error(`Text not found in ${relativePath}`)
      }

      if (occurrences > 1) {
        throw new Error(`Text is ambiguous in ${relativePath}`)
      }

      const nextContent = content.replace(oldText, newText)
      await writeFile(targetPath, nextContent, 'utf-8')

      return {
        content: [{ type: 'text', text: `Edited ${relativePath}.` }],
        details: {
          path: relativePath,
        },
      }
    },
  })

  pi.registerTool({
    name: 'workspace_search',
    label: 'Workspace Search',
    description: 'Search for text in files under the current thread workspace.',
    promptGuidelines: WORKSPACE_TOOL_GUIDELINES,
    parameters: Type.Object({
      query: Type.String({ description: 'Text to search for' }),
      path: Type.Optional(Type.String({ description: 'Optional file or folder path relative to the workspace root' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workspaceRoot = getWorkspaceRoot(ctx)
      const { query, path: rawPath } = params as { query: string; path?: string }
      const normalizedQuery = query.trim()
      if (!normalizedQuery) {
        throw new Error('query is required')
      }

      const relativePath = normalizeRelativePath(rawPath ?? '', true)
      assertUserWorkspacePath(relativePath)
      const matches: WorkspaceSearchMatch[] = []

      await collectSearchMatches(workspaceRoot, relativePath, normalizedQuery, matches)

      return {
        content: [{ type: 'text', text: formatSearchText(normalizedQuery, matches, relativePath) }],
        details: {
          query: normalizedQuery,
          path: relativePath,
          matches,
          limited: matches.length >= SEARCH_RESULT_LIMIT,
        },
      }
    },
  })
}
