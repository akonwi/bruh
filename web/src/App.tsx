import { useAgent } from 'agents/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { AppSidebar } from '@/components/app-sidebar'
import { ChatView } from '@/components/chat-view'
import { Separator } from '@/components/ui/separator'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { useSystemTheme } from '@/hooks/use-theme'
import {
  createSession,
  deleteSession,
  getMainSession,
  listSessions,
  renameSession,
  type SessionState,
} from '@/lib/api'
import {
  type AppRoute,
  getRoutePath,
  MAIN_SESSION_ID,
  type McpState,
  parseRoute,
  shortId,
  sortSessions,
} from '@/lib/types'

function App() {
  const [route, setRoute] = useState<AppRoute>(() =>
    parseRoute(window.location.pathname),
  )
  const [sessions, setSessions] = useState<SessionState[]>([])
  const [isCreating, setIsCreating] = useState(false)
  useSystemTheme()

  const navigateTo = useCallback(
    (nextRoute: AppRoute, options?: { replace?: boolean }) => {
      const nextPath = getRoutePath(nextRoute)
      const method = options?.replace ? 'replaceState' : 'pushState'
      if (window.location.pathname !== nextPath)
        window.history[method](null, '', nextPath)
      setRoute(nextRoute)
    },
    [],
  )

  useEffect(() => {
    const handlePopState = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  // Load thread list
  useEffect(() => {
    void listSessions()
      .then((listed) => setSessions(sortSessions(listed)))
      .catch(() => {})
  }, [])

  // Init main session on first load
  useEffect(() => {
    void getMainSession().catch(() => {})
  }, [])

  const handleNavigateMain = useCallback(
    () => navigateTo({ kind: 'main' }),
    [navigateTo],
  )

  const handleCreateThread = async () => {
    setIsCreating(true)
    try {
      const created = await createSession()
      setSessions((current) => sortSessions([...current, created]))
      navigateTo({ kind: 'thread', sessionId: created.sessionId })
    } catch (e) {
      console.error('Failed to create thread:', e)
    } finally {
      setIsCreating(false)
    }
  }

  const handleOpenThread = useCallback(
    (sessionId: string) => {
      navigateTo({ kind: 'thread', sessionId })
    },
    [navigateTo],
  )

  const handleRenameThread = useCallback(
    async (sessionId: string, title: string) => {
      const updated = await renameSession(sessionId, title)
      setSessions((current) =>
        sortSessions(
          current.map((session) =>
            session.sessionId === sessionId ? updated : session,
          ),
        ),
      )
    },
    [],
  )

  const handleDeleteThread = useCallback(
    async (sessionId: string) => {
      await deleteSession(sessionId)

      const listed = await listSessions().catch(() => null)
      if (listed) {
        setSessions(sortSessions(listed))
      } else {
        setSessions((current) =>
          sortSessions(
            current.filter((session) => session.sessionId !== sessionId),
          ),
        )
      }

      if (route.kind === 'thread' && route.sessionId === sessionId) {
        navigateTo({ kind: 'main' }, { replace: true })
      }
    },
    [navigateTo, route],
  )

  const sessionId = route.kind === 'main' ? MAIN_SESSION_ID : route.sessionId
  const activeSection = route.kind === 'main' ? 'main' : 'threads'
  const activeThreadId = route.kind === 'thread' ? route.sessionId : null
  const activeThread =
    route.kind === 'thread'
      ? sessions.find((session) => session.sessionId === route.sessionId)
      : null
  const activeTitle =
    route.kind === 'main'
      ? 'Main'
      : activeThread?.title?.trim() || `Thread ${shortId(route.sessionId)}`

  // Agent connection — lives here so MCP state is available to ChatView
  const [mcpState, setMcpState] = useState<McpState>({ servers: {}, tools: [] })

  const handleMcpUpdate = useCallback(
    (state: unknown) => setMcpState(state as McpState),
    [],
  )

  const handleAgentMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data as string) as {
        type?: string
        notification?: {
          type: string
          title: string
          body: string
        }
      }
      if (data.type === 'notification' && data.notification) {
        const { notification } = data
        const isError = notification.type === 'scheduled-task-failed'
        if (isError) {
          toast.error(notification.title, {
            description: notification.body,
            duration: Infinity,
          })
        } else {
          toast.success(notification.title, {
            description: notification.body,
            duration: Infinity,
          })
        }
      }
    } catch {
      // Not a JSON message we handle
    }
  }, [])

  const agent = useAgent({
    agent: 'BruhAgent',
    name: sessionId ?? MAIN_SESSION_ID,
    onMcpUpdate: handleMcpUpdate,
    onMessage: handleAgentMessage,
  })

  const mcpServers = useMemo(
    () => Object.values(mcpState.servers),
    [mcpState.servers],
  )
  const mcpServerNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const [id, server] of Object.entries(mcpState.servers)) {
      map.set(id, server.name)
    }
    return map
  }, [mcpState.servers])

  return (
    <SidebarProvider className='h-svh max-h-svh overflow-hidden'>
      <AppSidebar
        activeSection={activeSection}
        activeThreadId={activeThreadId}
        onNavigateMain={handleNavigateMain}
        onOpenThread={handleOpenThread}
        onRenameThread={handleRenameThread}
        onDeleteThread={handleDeleteThread}
        onCreateThread={handleCreateThread}
        isCreating={isCreating}
        sessions={sessions}
      />
      <SidebarInset className='h-svh min-h-0 max-h-svh overflow-hidden'>
        <header className='sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 backdrop-blur'>
          <div className='flex items-center gap-2 px-4'>
            <SidebarTrigger className='-ml-1' />
            <Separator
              orientation='vertical'
              className='mr-2 !self-auto data-[orientation=vertical]:h-4'
            />
            <span className='truncate text-sm font-medium'>{activeTitle}</span>
          </div>
        </header>

        <ChatView
          sessionId={sessionId}
          agent={agent}
          mcpServerNames={mcpServerNames}
          mcpServers={mcpServers}
        />
      </SidebarInset>
      <Toaster position='top-right' />
    </SidebarProvider>
  )
}

export default App
