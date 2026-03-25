import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAgent } from 'agents/react'
import { useAgentChat } from '@cloudflare/ai-chat/react'
import type { UIMessage } from 'ai'
import {
  ArrowSquareOut,
  CaretRight,
  CheckCircle,
  ClockCounterClockwise,
  Plus,
  SpinnerGap,
  StopCircle,
  WarningCircle,
  Wrench,
} from '@phosphor-icons/react'

import { AppSidebar } from '@/components/app-sidebar'
import { MessageMarkdown } from '@/components/message-markdown'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  createSession,
  getMainSession,
  listSessions,
  type SessionState,
} from '@/lib/api'

const MAIN_SESSION_ID = 'main'

type AppRoute =
  | { kind: 'main' }
  | { kind: 'threads' }
  | { kind: 'thread'; sessionId: string }

function parseRoute(pathname: string): AppRoute {
  if (pathname === '/' || pathname === '') return { kind: 'main' }
  if (pathname === '/threads') return { kind: 'threads' }
  const threadMatch = pathname.match(/^\/threads\/([^/]+)$/)
  if (threadMatch?.[1]) return { kind: 'thread', sessionId: decodeURIComponent(threadMatch[1]) }
  return { kind: 'main' }
}

function getRoutePath(route: AppRoute): string {
  switch (route.kind) {
    case 'main': return '/'
    case 'threads': return '/threads'
    case 'thread': return `/threads/${encodeURIComponent(route.sessionId)}`
  }
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

function formatRelativeTime(timestamp: string): string {
  const value = new Date(timestamp).getTime()
  if (Number.isNaN(value)) return 'Recently'
  const diffMs = Date.now() - value
  const diffMinutes = Math.round(diffMs / 60000)
  if (diffMinutes <= 0) return 'Just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.round(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp))
}

function formatMessageTime(timestamp: string | Date | undefined): string {
  if (!timestamp) return ''
  const value = new Date(timestamp)
  if (Number.isNaN(value.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(value)
}

function formatToolName(toolName: string): string {
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

// --- Chat view using useAgentChat ---

function ChatView({ sessionId }: { sessionId: string }) {
  const agent = useAgent({ agent: 'BruhAgent', name: sessionId })
  const { messages, sendMessage, stop, error, status } = useAgentChat({ agent })
  const [input, setInput] = useState('')
  const isLoading = status === 'streaming' || status === 'submitted'

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

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || isLoading) return
    sendMessage({ role: 'user', content: text, parts: [{ type: 'text', text }] })
    setInput('')
  }, [input, isLoading, sendMessage])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
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
          isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className='flex min-h-full flex-col justify-end gap-4 px-2 py-4'>
          {messages.length === 0 ? (
            <div className='flex min-h-[40vh] flex-col items-center justify-center gap-4 border border-dashed bg-card/70 px-6 py-12 text-center'>
              <h3 className='text-2xl font-semibold tracking-tight'>
                {sessionId === MAIN_SESSION_ID ? 'This is your main thread' : 'This thread is ready'}
              </h3>
              <p className='max-w-xl text-sm leading-6 text-muted-foreground sm:text-base'>
                {sessionId === MAIN_SESSION_ID
                  ? 'Use this as the ongoing rolling conversation with your agent.'
                  : 'Ask a focused follow-up here, or jump back to Main from the sidebar.'}
              </p>
            </div>
          ) : (
            messages.map((message) => <MessageItem key={message.id} message={message} />)
          )}

          {isLoading && !messages.some(m => m.role === 'assistant' && m.parts?.some(p => p.type === 'text' && p.text)) ? (
            <div className='flex justify-start'>
              <div className='inline-flex items-center gap-2 border bg-background px-3 py-2 text-sm text-muted-foreground shadow-sm'>
                <SpinnerGap className='size-4 animate-spin' />
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
              placeholder={sessionId === MAIN_SESSION_ID ? 'Message Main…' : 'Message this thread…'}
              className='min-h-24 resize-none border-0 text-sm sm:text-[15px]'
            />
            <div className='flex items-center justify-between gap-2 border-t px-2 py-2'>
              <div className='min-w-0 text-xs text-muted-foreground'>
                {isLoading ? <span>Bruh is responding…</span> : null}
              </div>
              {isLoading ? (
                <Button variant='outline' onClick={stop}>
                  <StopCircle data-icon='inline-start' />
                  Stop
                </Button>
              ) : (
                <Button onClick={handleSend} disabled={!input.trim()}>
                  <ArrowSquareOut data-icon='inline-start' />
                  Send
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Message rendering ---

function MessageItem({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user'

  return (
    <>
      {message.parts?.map((part, i) => {
        if (part.type === 'text' && part.text.trim()) {
          const bubbleClasses = isUser
            ? 'bg-primary text-primary-foreground'
            : 'border bg-background text-card-foreground shadow-sm'

          return (
            <div key={i} className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
              <div className={cn('max-w-[88%] px-3 py-2 sm:max-w-[78%]', bubbleClasses)}>
                <MessageMarkdown content={part.text} tone={isUser ? 'user' : 'assistant'} />
                <p className={cn('mt-1 text-[11px]', isUser ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
                  {formatMessageTime(message.createdAt)}
                </p>
              </div>
            </div>
          )
        }

        if (part.type === 'tool-invocation') {
          return <ToolPart key={i} part={part} />
        }

        return null
      })}
    </>
  )
}

function ToolPart({ part }: { part: Extract<UIMessage['parts'][number], { type: 'tool-invocation' }> }) {
  const isRunning = part.state === 'call' || part.state === 'partial-call'
  const isError = part.state === 'result' && typeof part.result === 'string' && part.result.startsWith('Error:')
  const isDone = part.state === 'result'

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

  const resultText = isDone && part.result != null
    ? typeof part.result === 'string' ? part.result : JSON.stringify(part.result, null, 2)
    : null

  return (
    <div className='flex justify-start'>
      <details className={cn('group w-full max-w-[88%] border shadow-sm sm:max-w-[78%]', panelTone)}>
        <summary className='flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 [&::-webkit-details-marker]:hidden'>
          <div className='min-w-0 flex items-center gap-2'>
            {isRunning ? (
              <SpinnerGap className={cn('size-4 shrink-0 animate-spin', iconTone)} />
            ) : isError ? (
              <WarningCircle weight='fill' className={cn('size-4 shrink-0', iconTone)} />
            ) : (
              <CheckCircle weight='fill' className={cn('size-4 shrink-0', iconTone)} />
            )}
            <p className='truncate text-sm font-medium text-foreground'>
              {truncateInline(formatToolName(part.toolName))}
            </p>
          </div>
          <CaretRight className='size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90' />
        </summary>
        <div className='border-t bg-background/80 px-3 py-3 text-xs text-foreground'>
          <div className='mb-2 flex items-center gap-2 text-muted-foreground'>
            <Wrench className='size-3.5' />
            <span>{formatToolName(part.toolName)}</span>
          </div>
          {resultText ? (
            <pre className='overflow-x-auto whitespace-pre-wrap break-words leading-5'>{resultText}</pre>
          ) : part.args ? (
            <pre className='overflow-x-auto whitespace-pre-wrap break-words leading-5 text-muted-foreground'>
              {JSON.stringify(part.args, null, 2)}
            </pre>
          ) : (
            <p className='text-muted-foreground'>{isRunning ? 'Running…' : 'No output'}</p>
          )}
        </div>
      </details>
    </div>
  )
}

// --- Main App ---

function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname))
  const [sessions, setSessions] = useState<SessionState[]>([])
  const [isLoadingSessions, setIsLoadingSessions] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const navigateTo = useCallback((nextRoute: AppRoute, options?: { replace?: boolean }) => {
    const nextPath = getRoutePath(nextRoute)
    const method = options?.replace ? 'replaceState' : 'pushState'
    if (window.location.pathname !== nextPath) window.history[method](null, '', nextPath)
    setRoute(nextRoute)
  }, [])

  useEffect(() => {
    const handlePopState = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  // Load thread list
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setIsLoadingSessions(true)
      try {
        const listed = await listSessions()
        if (!cancelled) setSessions(sortSessions(listed))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load threads')
      } finally {
        if (!cancelled) setIsLoadingSessions(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  // Init main session on first load
  useEffect(() => {
    void getMainSession().catch(() => {})
  }, [])

  const handleNavigateMain = useCallback(() => navigateTo({ kind: 'main' }), [navigateTo])
  const handleNavigateThreads = useCallback(() => navigateTo({ kind: 'threads' }), [navigateTo])

  const handleCreateThread = async () => {
    setIsCreating(true)
    setError(null)
    try {
      const created = await createSession()
      setSessions((current) => sortSessions([...current, created]))
      navigateTo({ kind: 'thread', sessionId: created.sessionId })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create thread')
    } finally {
      setIsCreating(false)
    }
  }

  const handleOpenThread = useCallback((session: SessionState) => {
    navigateTo({ kind: 'thread', sessionId: session.sessionId })
  }, [navigateTo])

  const sessionId = route.kind === 'main' ? MAIN_SESSION_ID : route.kind === 'thread' ? route.sessionId : null
  const activeSection = route.kind === 'main' ? 'main' : 'threads'
  const activeTitle = route.kind === 'main' ? 'Main' : route.kind === 'threads' ? 'Threads' : `Thread ${shortId(route.sessionId)}`

  return (
    <SidebarProvider className='h-svh max-h-svh overflow-hidden'>
      <AppSidebar
        activeSection={activeSection}
        onNavigateMain={handleNavigateMain}
        onNavigateThreads={handleNavigateThreads}
        onCreateThread={handleCreateThread}
        isCreating={isCreating}
      />
      <SidebarInset className='h-svh min-h-0 max-h-svh overflow-hidden'>
        <header className='sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 backdrop-blur'>
          <div className='flex items-center gap-2 px-4'>
            <SidebarTrigger className='-ml-1' />
            <Separator orientation='vertical' className='mr-2 !self-auto data-[orientation=vertical]:h-4' />
            <span className='truncate text-sm font-medium'>{activeTitle}</span>
          </div>
        </header>

        {sessionId ? (
          <ChatView sessionId={sessionId} />
        ) : (
          <ThreadList
            sessions={sessions}
            isLoading={isLoadingSessions}
            isCreating={isCreating}
            error={error}
            onOpen={handleOpenThread}
            onCreate={handleCreateThread}
          />
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}

// --- Thread list view ---

function ThreadList({
  sessions,
  isLoading,
  isCreating,
  error,
  onOpen,
  onCreate,
}: {
  sessions: SessionState[]
  isLoading: boolean
  isCreating: boolean
  error: string | null
  onOpen: (session: SessionState) => void
  onCreate: () => void
}) {
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div className='min-h-0 flex-1 overflow-y-auto'>
        <div className='mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-6 sm:px-6'>
          {error ? (
            <div className='border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive'>{error}</div>
          ) : null}

          {isLoading && sessions.length === 0 ? (
            <div className='border border-dashed bg-card/70 px-4 py-6 text-sm text-muted-foreground'>Loading threads…</div>
          ) : sessions.length === 0 ? (
            <div className='flex min-h-[40vh] flex-col items-center justify-center gap-4 border border-dashed bg-card/70 px-6 py-12 text-center'>
              <h3 className='text-2xl font-semibold tracking-tight'>No threads yet</h3>
              <p className='max-w-xl text-sm leading-6 text-muted-foreground sm:text-base'>
                Main lives at the root route. Create extra threads here when you want to branch off.
              </p>
              <Button onClick={onCreate} disabled={isCreating}>
                {isCreating ? <SpinnerGap className='animate-spin' data-icon='inline-start' /> : <Plus data-icon='inline-start' />}
                {isCreating ? 'Creating…' : 'New thread'}
              </Button>
            </div>
          ) : (
            sessions.map((item) => (
              <button
                key={item.sessionId}
                type='button'
                onClick={() => onOpen(item)}
                className='flex w-full flex-col gap-4 border bg-background px-4 py-4 text-left transition-colors hover:bg-card sm:flex-row sm:items-center sm:justify-between'
              >
                <div className='min-w-0 flex-1'>
                  <p className='line-clamp-2 text-base font-medium leading-6'>
                    {item.title?.trim() || `Thread ${shortId(item.sessionId)}`}
                  </p>
                  <div className='mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground'>
                    <span>{shortId(item.sessionId)}</span>
                    <span>•</span>
                    <span className='inline-flex items-center gap-1.5'>
                      <ClockCounterClockwise />
                      {formatRelativeTime(item.updatedAt)}
                    </span>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className='shrink-0 border-t bg-background/95 px-4 py-4 backdrop-blur sm:px-6'>
        <div className='mx-auto flex w-full max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
          <p className='text-sm text-muted-foreground'>Open a thread here, or return to Main from the sidebar.</p>
          <Button onClick={onCreate} disabled={isCreating}>
            {isCreating ? <SpinnerGap className='animate-spin' data-icon='inline-start' /> : <Plus data-icon='inline-start' />}
            {isCreating ? 'Creating…' : 'New thread'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default App
