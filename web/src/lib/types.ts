import type { useAgent } from 'agents/react'

export const MAIN_SESSION_ID = 'main'

export interface McpServerInfo {
  name: string
  state: string
  server_url: string
  error: string | null
}

export interface McpState {
  servers: Record<string, McpServerInfo>
  tools: Array<{ name: string; serverId: string }>
}

export type AppRoute = { kind: 'main' } | { kind: 'thread'; sessionId: string }

export type AgentConnection = ReturnType<typeof useAgent<unknown>>

export function parseRoute(pathname: string): AppRoute {
  if (pathname === '/' || pathname === '') return { kind: 'main' }
  const threadMatch = pathname.match(/^\/threads\/([^/]+)$/)
  if (threadMatch?.[1])
    return { kind: 'thread', sessionId: decodeURIComponent(threadMatch[1]) }
  return { kind: 'main' }
}

export function getRoutePath(route: AppRoute): string {
  switch (route.kind) {
    case 'main':
      return '/'
    case 'thread':
      return `/threads/${encodeURIComponent(route.sessionId)}`
  }
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

export function sortSessions<
  T extends { sessionId: string; updatedAt: string },
>(sessions: T[]): T[] {
  return [...sessions]
    .filter((s) => s.sessionId !== MAIN_SESSION_ID)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
