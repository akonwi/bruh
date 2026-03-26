import { useAgentChat } from '@cloudflare/ai-chat/react'
import {
  ArrowSquareOutIcon,
  CaretRightIcon,
  CheckCircleIcon,
  SpinnerGapIcon,
  StopCircleIcon,
  WarningCircleIcon,
  WrenchIcon,
} from '@phosphor-icons/react'
import { useAgent } from 'agents/react'
import {
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai'
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { AppSidebar } from '@/components/app-sidebar'
import { MessageMarkdown } from '@/components/message-markdown'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Textarea } from '@/components/ui/textarea'
import { useSystemTheme } from '@/hooks/use-theme'
import {
  createSession,
  followUpSession,
  getMainSession,
  listSessions,
  refreshSessionContext,
  renameSession,
  type SessionState,
  steerSession,
} from '@/lib/api'
import { cn } from '@/lib/utils'

const MAIN_SESSION_ID = 'main'

interface McpServerInfo {
  name: string
  state: string
  server_url: string
  error: string | null
}

interface McpState {
  servers: Record<string, McpServerInfo>
  tools: Array<{ name: string; serverId: string }>
}

type AppRoute = { kind: 'main' } | { kind: 'thread'; sessionId: string }

function parseRoute(pathname: string): AppRoute {
  if (pathname === '/' || pathname === '') return { kind: 'main' }
  const threadMatch = pathname.match(/^\/threads\/([^/]+)$/)
  if (threadMatch?.[1])
    return { kind: 'thread', sessionId: decodeURIComponent(threadMatch[1]) }
  return { kind: 'main' }
}

function getRoutePath(route: AppRoute): string {
  switch (route.kind) {
    case 'main':
      return '/'
    case 'thread':
      return `/threads/${encodeURIComponent(route.sessionId)}`
  }
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

function formatMessageTime(timestamp: string | Date | undefined): string {
  if (!timestamp) return ''
  const value = new Date(timestamp)
  if (Number.isNaN(value.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

function formatToolName(
  toolName: string,
  mcpServerNames?: Map<string, string>,
): string {
  // MCP tools are namespaced as "{serverId}_{toolName}" — IDs vary in length
  if (mcpServerNames && mcpServerNames.size > 0) {
    for (const [id, name] of mcpServerNames) {
      if (toolName.startsWith(`${id}_`)) {
        const rest = toolName.slice(id.length + 1)
        return `${name}: ${rest.replaceAll('_', ' ')}`
      }
    }
  }
  return toolName.replaceAll('_', ' ')
}

function truncateInline(value: string, maxLength = 72): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength).trimEnd()}…`
}

function sortSessions(sessions: SessionState[]): SessionState[] {
  return [...sessions]
    .filter((s) => s.sessionId !== MAIN_SESSION_ID)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

type AgentConnection = ReturnType<typeof useAgent<unknown>>

function getMessageCreatedAt(message: UIMessage): string | Date | undefined {
  if (!('createdAt' in message)) return undefined
  const value = (message as UIMessage & { createdAt?: unknown }).createdAt
  if (typeof value === 'string' || value instanceof Date) return value
  return undefined
}

function estimateContextTokens(messages: UIMessage[]): number {
  const chars = messages.reduce(
    (sum, message) => sum + JSON.stringify(message).length,
    0,
  )
  return Math.ceil(chars / 4)
}

// --- Chat view using useAgentChat ---

function ChatView({
  sessionId,
  agent,
  mcpServerNames,
}: {
  sessionId: string
  agent: AgentConnection
  mcpServerNames: Map<string, string>
}) {
  const clientTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  const { messages, sendMessage, stop, clearHistory, error, status } = useAgentChat({
    agent,
    body: () => ({
      clientTimezone,
      clientNowIso: new Date().toISOString(),
    }),
  })
  const [input, setInput] = useState('')
  const [queueMode, setQueueMode] = useState<'steer' | 'follow-up'>('steer')
  const isLoading = status === 'streaming' || status === 'submitted'

  const contextTokenEstimate = useMemo(
    () => estimateContextTokens(messages),
    [messages],
  )
  const contextBudget = sessionId === MAIN_SESSION_ID ? 16_000 : 24_000
  const contextRatio = Math.min(contextTokenEstimate / contextBudget, 1)
  const contextTone =
    contextRatio >= 0.85
      ? 'text-destructive'
      : contextRatio >= 0.8
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground'

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const messageEndRef = useRef<HTMLDivElement | null>(null)
  const isNearBottomRef = useRef(true)

  const scrollToBottom = useCallback(() => {
    messageEndRef.current?.scrollIntoView({ block: 'end' })
  }, [])

  useEffect(() => {
    if (isNearBottomRef.current) scrollToBottom()
  }, [messages, isLoading, scrollToBottom])

  useEffect(() => {
    isNearBottomRef.current = true
    scrollToBottom()
  }, [sessionId, scrollToBottom])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text) return

    if (isLoading) {
      // While streaming, use steer or follow-up
      try {
        if (queueMode === 'steer') {
          await steerSession(sessionId, text)
        } else {
          await followUpSession(sessionId, text)
        }
        setInput('')
      } catch (e) {
        console.error('Failed to send:', e)
      }
      return
    }

    sendMessage({ role: 'user', parts: [{ type: 'text', text }] })
    setInput('')
  }, [input, isLoading, queueMode, sessionId, sendMessage])

  const handleClearHistory = useCallback(() => {
    const ok = window.confirm(
      'Clear this chat history? This cannot be undone for this thread.',
    )
    if (!ok) return
    clearHistory()
  }, [clearHistory])

  const handleRefreshContext = useCallback(async () => {
    const ok = window.confirm(
      'Refresh context for this thread? It will keep only the latest turns and checkpoint prior context.',
    )
    if (!ok) return

    try {
      await refreshSessionContext(sessionId)
      window.location.reload()
    } catch (e) {
      console.error('Failed to refresh context:', e)
    }
  }, [sessionId])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return
    event.preventDefault()
    handleSend()
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div
        ref={scrollRef}
        className='min-h-0 flex-1 overflow-y-auto overscroll-contain'
        onScroll={() => {
          const el = scrollRef.current
          if (!el) return
          isNearBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className='flex min-h-full flex-col justify-end gap-4 px-2 py-4'>
          {messages.length === 0 ? (
            <div className='flex min-h-[40vh] flex-col items-center justify-center gap-4 border border-dashed bg-card/70 px-6 py-12 text-center'>
              <h3 className='text-2xl font-semibold tracking-tight'>
                {sessionId === MAIN_SESSION_ID
                  ? 'This is your main thread'
                  : 'This thread is ready'}
              </h3>
              <p className='max-w-xl text-sm leading-6 text-muted-foreground sm:text-base'>
                {sessionId === MAIN_SESSION_ID
                  ? 'Use this as the ongoing rolling conversation with your agent.'
                  : 'Ask a focused follow-up here, or jump back to Main from the sidebar.'}
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                mcpServerNames={mcpServerNames}
              />
            ))
          )}

          {isLoading &&
          !messages.some(
            (m) =>
              m.role === 'assistant' &&
              m.parts?.some((p) => p.type === 'text' && p.text),
          ) ? (
            <div className='flex justify-start'>
              <div className='inline-flex items-center gap-2 border bg-background px-3 py-2 text-sm text-muted-foreground shadow-sm'>
                <SpinnerGapIcon className='size-4 animate-spin' />
                <span>Thinking...</span>
              </div>
            </div>
          ) : null}

          <div ref={messageEndRef} />
        </div>
      </div>

      <div className='sticky bottom-0 z-20 shrink-0 border-t bg-background/95 px-2 py-2 backdrop-blur'>
        <div className='flex flex-col gap-2'>
          {error ? (
            <div className='border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive'>
              {error.message}
            </div>
          ) : null}

          <div className='border bg-card shadow-sm'>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                sessionId === MAIN_SESSION_ID
                  ? 'Message Main…'
                  : 'Message this thread…'
              }
              className='min-h-24 resize-none border-0 text-sm sm:text-[15px]'
            />
            <div className='flex items-center justify-between gap-2 border-t px-2 py-2'>
              <div className='min-w-0 text-xs text-muted-foreground'>
                <div className='flex flex-wrap items-center gap-2'>
                  {contextRatio >= 0.85 ? (
                    <span className={contextTone}>
                      Context window {'>'}=85% — auto-refreshing context.
                    </span>
                  ) : contextRatio >= 0.8 ? (
                    <span className={contextTone}>
                      Context window {'>'}=80% — nearing limit.
                    </span>
                  ) : null}
                </div>
                {isLoading ? (
                  <div className='mt-1 flex flex-wrap items-center gap-2'>
                    <span>Bruh is responding…</span>
                    <div className='flex items-center gap-1'>
                      <Button
                        size='xs'
                        variant={
                          queueMode === 'steer' ? 'secondary' : 'outline'
                        }
                        onClick={() => setQueueMode('steer')}
                      >
                        Steer
                      </Button>
                      <Button
                        size='xs'
                        variant={
                          queueMode === 'follow-up' ? 'secondary' : 'outline'
                        }
                        onClick={() => setQueueMode('follow-up')}
                      >
                        Follow-up
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
              <div className='flex items-center gap-2'>
                <Button
                  variant='outline'
                  onClick={handleRefreshContext}
                  disabled={isLoading || messages.length === 0}
                >
                  Refresh context
                </Button>
                <Button
                  variant='outline'
                  onClick={handleClearHistory}
                  disabled={isLoading || messages.length === 0}
                >
                  Clear history
                </Button>
                {isLoading ? (
                  <Button variant='outline' onClick={() => stop()}>
                    <StopCircleIcon data-icon='inline-start' />
                    Stop
                  </Button>
                ) : null}
                <Button onClick={handleSend} disabled={!input.trim()}>
                  <ArrowSquareOutIcon data-icon='inline-start' />
                  {isLoading
                    ? queueMode === 'steer'
                      ? 'Steer'
                      : 'Follow-up'
                    : 'Send'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Message rendering ---

function MessageItem({
  message,
  mcpServerNames,
}: {
  message: UIMessage
  mcpServerNames: Map<string, string>
}) {
  const isUser = message.role === 'user'

  return (
    <>
      {message.parts?.map((part: UIMessage['parts'][number], i: number) => {
        if (part.type === 'text' && part.text.trim()) {
          const bubbleClasses = isUser
            ? 'bg-primary text-primary-foreground'
            : 'border bg-background text-card-foreground shadow-sm'

          return (
            <div
              key={i}
              className={cn('flex', isUser ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[88%] px-3 py-2 sm:max-w-[78%]',
                  bubbleClasses,
                )}
              >
                <MessageMarkdown
                  content={part.text}
                  tone={isUser ? 'user' : 'assistant'}
                />
                <p
                  className={cn(
                    'mt-1 text-[11px]',
                    isUser
                      ? 'text-primary-foreground/70'
                      : 'text-muted-foreground',
                  )}
                >
                  {formatMessageTime(getMessageCreatedAt(message))}
                </p>
              </div>
            </div>
          )
        }

        if (isToolUIPart(part)) {
          return <ToolPart key={i} part={part} mcpServerNames={mcpServerNames} />
        }

        return null
      })}
    </>
  )
}

function ToolPart({
  part,
  mcpServerNames,
}: {
  part: ToolUIPart | DynamicToolUIPart
  mcpServerNames: Map<string, string>
}) {
  const rawToolName = getToolName(part)
  const toolName = formatToolName(rawToolName, mcpServerNames)

  // AI SDK v6 tool states: call, partial-call, input-streaming, output-available, output-error, output-denied
  const isRunning =
    part.state === 'input-streaming' ||
    part.state === 'input-available' ||
    part.state === 'approval-requested' ||
    part.state === 'approval-responded'
  const isError =
    part.state === 'output-error' || part.state === 'output-denied'
  const isDone = part.state === 'output-available' || isError

  const panelTone = isRunning
    ? 'border-border bg-muted/35'
    : isError
      ? 'border-destructive/30 bg-destructive/5'
      : 'border-emerald-500/30 bg-emerald-500/5'

  const iconTone = isRunning
    ? 'text-muted-foreground'
    : isError
      ? 'text-destructive'
      : 'text-emerald-600 dark:text-emerald-300'

  const legacyPart = part as {
    args?: unknown
    result?: unknown
  }

  const rawOutput = isError
    ? (part.errorText ?? part.output ?? legacyPart.result)
    : (part.output ?? legacyPart.result)
  const resultText =
    isDone && rawOutput != null
      ? typeof rawOutput === 'string'
        ? rawOutput
        : JSON.stringify(rawOutput, null, 2)
      : null

  const rawInput = part.input ?? legacyPart.args

  return (
    <div className='flex justify-start'>
      <details
        className={cn(
          'group w-full max-w-[88%] border shadow-sm sm:max-w-[78%]',
          panelTone,
        )}
      >
        <summary className='flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 [&::-webkit-details-marker]:hidden'>
          <div className='min-w-0 flex items-center gap-2'>
            {isRunning ? (
              <SpinnerGapIcon
                className={cn('size-4 shrink-0 animate-spin', iconTone)}
              />
            ) : isError ? (
              <WarningCircleIcon
                weight='fill'
                className={cn('size-4 shrink-0', iconTone)}
              />
            ) : (
              <CheckCircleIcon
                weight='fill'
                className={cn('size-4 shrink-0', iconTone)}
              />
            )}
            <p className='truncate text-sm font-medium text-foreground'>
              {truncateInline(toolName)}
            </p>
          </div>
          <CaretRightIcon className='size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90' />
        </summary>
        <div className='border-t bg-background/80 px-3 py-3 text-xs text-foreground'>
          <div className='mb-2 flex items-center gap-2 text-muted-foreground'>
            <WrenchIcon className='size-3.5' />
            <span>{toolName}</span>
          </div>
          {rawInput ? (
            <div className='mb-2'>
              <p className='mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground'>
                Input
              </p>
              <pre className='overflow-x-auto whitespace-pre-wrap break-words leading-5 text-muted-foreground'>
                {typeof rawInput === 'string'
                  ? rawInput
                  : JSON.stringify(rawInput, null, 2)}
              </pre>
            </div>
          ) : null}
          {resultText ? (
            <div>
              <p className='mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground'>
                Output
              </p>
              <pre
                className={cn(
                  'overflow-x-auto whitespace-pre-wrap break-words leading-5',
                  isError && 'text-destructive',
                )}
              >
                {resultText}
              </pre>
            </div>
          ) : isRunning ? (
            <p className='text-muted-foreground'>Running…</p>
          ) : !rawInput ? (
            <p className='text-muted-foreground'>No output</p>
          ) : null}
        </div>
      </details>
    </div>
  )
}

// --- Main App ---

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
      .catch(() => {}) // Silently handle - sidebar shows empty state
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

  // Agent connection — lives here so MCP state is available to sidebar
  const [mcpState, setMcpState] = useState<McpState>({ servers: {}, tools: [] })
  const agent = useAgent({
    agent: 'BruhAgent',
    name: sessionId ?? MAIN_SESSION_ID,
    onMcpUpdate: (state) => setMcpState(state as McpState),
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
        onCreateThread={handleCreateThread}
        isCreating={isCreating}
        sessions={sessions}
        mcpServers={mcpServers}
        mcpToolCount={mcpState.tools.length}
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
        />
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App
