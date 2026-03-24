import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowSquareOut,
  ClockCounterClockwise,
  Plus,
  SpinnerGap,
  StopCircle,
} from '@phosphor-icons/react'

import { AppSidebar } from '@/components/app-sidebar'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import {
  abortSession,
  createSession,
  createSessionStream,
  getMainSession,
  getSession,
  getSessionEvents,
  listSessions,
  sendPrompt,
  type SessionEventEnvelope,
  type SessionState,
} from '@/lib/api'

const MAIN_SESSION_ID = 'main'
const USER_EVENT_TYPES = new Set(['session.prompt.accepted', 'runtime.prompt.start'])
const ASSISTANT_COMPLETE_EVENT_TYPES = new Set([
  'assistant.message.complete',
  'assistant.turn.complete',
  'assistant.agent.complete',
])

type StreamStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'
type ChatMessageRole = 'user' | 'assistant' | 'system'
type ChatMessageStatus = 'complete' | 'streaming' | 'aborted' | 'error'
type AppRoute =
  | { kind: 'main' }
  | { kind: 'threads' }
  | { kind: 'thread'; sessionId: string }

interface ChatMessage {
  id: string
  role: ChatMessageRole
  status: ChatMessageStatus
  text: string
  timestamp: string
}

function parseRoute(pathname: string): AppRoute {
  if (pathname === '/' || pathname === '') {
    return { kind: 'main' }
  }

  if (pathname === '/threads') {
    return { kind: 'threads' }
  }

  const threadMatch = pathname.match(/^\/threads\/([^/]+)$/)
  if (threadMatch?.[1]) {
    return {
      kind: 'thread',
      sessionId: decodeURIComponent(threadMatch[1]),
    }
  }

  return { kind: 'main' }
}

function getRoutePath(route: AppRoute): string {
  switch (route.kind) {
    case 'main':
      return '/'
    case 'threads':
      return '/threads'
    case 'thread':
      return `/threads/${encodeURIComponent(route.sessionId)}`
  }
}

function createChatTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 72) return normalized
  return `${normalized.slice(0, 72).trimEnd()}…`
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

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp))
}

function formatMessageTime(timestamp: string): string {
  const value = new Date(timestamp)
  if (Number.isNaN(value.getTime())) return ''

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

function sortSessions(sessions: SessionState[]): SessionState[] {
  return [...sessions]
    .filter((session) => session.sessionId !== MAIN_SESSION_ID)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function upsertSession(current: SessionState[], session: SessionState): SessionState[] {
  if (session.sessionId === MAIN_SESSION_ID) {
    return current
  }

  const existingIndex = current.findIndex((entry) => entry.sessionId === session.sessionId)
  const existing = existingIndex >= 0 ? current[existingIndex] : undefined
  const merged: SessionState = existing
    ? {
        ...existing,
        ...session,
        title: session.title ?? existing.title,
      }
    : session

  if (existingIndex === -1) {
    return sortSessions([merged, ...current])
  }

  const next = [...current]
  next[existingIndex] = merged
  return sortSessions(next)
}

function getEventPromptText(event: SessionEventEnvelope): string {
  return typeof event.payload.text === 'string' ? event.payload.text.trim() : ''
}

function getSessionTitleFromEvent(event: SessionEventEnvelope): string | undefined {
  if (!USER_EVENT_TYPES.has(event.type)) return undefined
  const text = getEventPromptText(event)
  return text ? createChatTitle(text) : undefined
}

function getThreadTitle(session: SessionState | null, messages: ChatMessage[]): string {
  if (session?.title?.trim()) return session.title
  const firstUserMessage = messages.find((message) => message.role === 'user')
  if (firstUserMessage) return createChatTitle(firstUserMessage.text)
  return 'Untitled thread'
}

function buildTranscript(events: SessionEventEnvelope[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  let currentAssistant: ChatMessage | null = null

  for (const event of events) {
    if (USER_EVENT_TYPES.has(event.type)) {
      const text = getEventPromptText(event)
      if (!text) continue

      const lastMessage = messages[messages.length - 1]
      if (!(lastMessage?.role === 'user' && lastMessage.text === text)) {
        messages.push({
          id: `user-${event.seq}`,
          role: 'user',
          status: 'complete',
          text,
          timestamp: event.timestamp,
        })
      }

      currentAssistant = null
      continue
    }

    if (event.type === 'assistant.text.delta') {
      const delta = typeof event.payload.delta === 'string' ? event.payload.delta : ''
      if (!delta) continue

      if (!currentAssistant || currentAssistant.status !== 'streaming') {
        currentAssistant = {
          id: `assistant-${event.seq}`,
          role: 'assistant',
          status: 'streaming',
          text: '',
          timestamp: event.timestamp,
        }
        messages.push(currentAssistant)
      }

      currentAssistant.text += delta
      currentAssistant.timestamp = event.timestamp
      continue
    }

    if (ASSISTANT_COMPLETE_EVENT_TYPES.has(event.type)) {
      const text = getEventPromptText(event)
      if (!text) continue

      if (currentAssistant && currentAssistant.status === 'streaming') {
        currentAssistant.text = text
        currentAssistant.status = 'complete'
        currentAssistant.timestamp = event.timestamp
        currentAssistant = null
        continue
      }

      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.role === 'assistant' && lastMessage.text === text) {
        lastMessage.status = 'complete'
        lastMessage.timestamp = event.timestamp
        currentAssistant = null
        continue
      }

      messages.push({
        id: `assistant-${event.seq}`,
        role: 'assistant',
        status: 'complete',
        text,
        timestamp: event.timestamp,
      })
      currentAssistant = null
      continue
    }

    if (event.type === 'runtime.prompt.aborted') {
      if (currentAssistant && currentAssistant.text) {
        currentAssistant.status = 'aborted'
        currentAssistant.timestamp = event.timestamp
      } else {
        messages.push({
          id: `system-${event.seq}`,
          role: 'system',
          status: 'aborted',
          text: 'Response stopped.',
          timestamp: event.timestamp,
        })
      }

      currentAssistant = null
      continue
    }

    if (event.type === 'runtime.error' || event.type === 'runtime.forward.error') {
      const message =
        typeof event.payload.message === 'string'
          ? event.payload.message
          : typeof event.payload.details === 'string' && event.payload.details
            ? event.payload.details
            : 'Something went wrong while running the session.'

      messages.push({
        id: `system-${event.seq}`,
        role: 'system',
        status: 'error',
        text: message,
        timestamp: event.timestamp,
      })
      currentAssistant = null
    }
  }

  return messages.filter((message) => message.text.trim().length > 0)
}

function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname))
  const [session, setSession] = useState<SessionState | null>(null)
  const [sessions, setSessions] = useState<SessionState[]>([])
  const [events, setEvents] = useState<SessionEventEnvelope[]>([])
  const [prompt, setPrompt] = useState('')
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isLoadingSessions, setIsLoadingSessions] = useState(true)
  const [isLoadingConversation, setIsLoadingConversation] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isAborting, setIsAborting] = useState(false)
  const latestSeqRef = useRef(0)
  const pendingSessionRef = useRef<SessionState | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const messageEndRef = useRef<HTMLDivElement | null>(null)
  const isNearBottomRef = useRef(true)

  const clearActiveConversation = useCallback(() => {
    latestSeqRef.current = 0
    setSession(null)
    setEvents([])
    setStreamStatus('idle')
  }, [])

  const navigateTo = useCallback((nextRoute: AppRoute, options?: { replace?: boolean }) => {
    const nextPath = getRoutePath(nextRoute)
    const method = options?.replace ? 'replaceState' : 'pushState'

    if (window.location.pathname !== nextPath) {
      window.history[method](null, '', nextPath)
    }

    setRoute(nextRoute)
  }, [])

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute(window.location.pathname))
    }

    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadThreads = async () => {
      setIsLoadingSessions(true)

      try {
        const listedSessions = await listSessions()
        if (!cancelled) {
          setSessions(sortSessions(listedSessions))
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load threads')
        }
      } finally {
        if (!cancelled) {
          setIsLoadingSessions(false)
        }
      }
    }

    void loadThreads()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    if (route.kind === 'threads') {
      pendingSessionRef.current = null
      clearActiveConversation()
      setIsLoadingConversation(false)
      return () => {
        cancelled = true
      }
    }

    const requestedSessionId = route.kind === 'main' ? MAIN_SESSION_ID : route.sessionId
    const pendingSession =
      pendingSessionRef.current?.sessionId === requestedSessionId ? pendingSessionRef.current : null

    if (pendingSession) {
      pendingSessionRef.current = null
    }

    const loadConversation = async () => {
      setIsLoadingConversation(true)
      setError(null)

      try {
        const nextSession =
          pendingSession ??
          (route.kind === 'main' ? await getMainSession() : await getSession(route.sessionId))

        if (cancelled) return

        latestSeqRef.current = 0
        setEvents([])
        setSession(nextSession)

        if (nextSession.sessionId !== MAIN_SESSION_ID) {
          setSessions((current) => upsertSession(current, nextSession))
        }

        const historical = await getSessionEvents(nextSession.sessionId)
        if (cancelled) return

        latestSeqRef.current = historical.reduce((max, event) => Math.max(max, event.seq), 0)
        setEvents(historical)
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load conversation')
        }
      } finally {
        if (!cancelled) {
          setIsLoadingConversation(false)
        }
      }
    }

    void loadConversation()

    return () => {
      cancelled = true
    }
  }, [route, clearActiveConversation])

  useEffect(() => {
    if (!session) {
      return
    }

    let cancelled = false
    let eventSource: EventSource | null = null
    let reconnectTimer: number | null = null

    const connect = (after: number) => {
      if (cancelled) return
      setStreamStatus(after > 0 ? 'reconnecting' : 'connecting')

      eventSource = createSessionStream(session.sessionId, after)

      eventSource.onopen = () => {
        if (!cancelled) {
          setStreamStatus('connected')
          setError(null)
        }
      }

      eventSource.onmessage = (message) => {
        const event = JSON.parse(message.data) as SessionEventEnvelope
        const derivedTitle = getSessionTitleFromEvent(event)
        latestSeqRef.current = Math.max(latestSeqRef.current, event.seq)

        setEvents((current) => {
          if (current.some((entry) => entry.seq === event.seq)) return current
          return [...current, event].sort((a, b) => a.seq - b.seq)
        })

        setSession((current) => {
          if (!current || current.sessionId !== event.sessionId) return current

          const nextStatus =
            event.type === 'session.status' && typeof event.payload.status === 'string'
              ? (event.payload.status as SessionState['status'])
              : current.status

          return {
            ...current,
            status: nextStatus,
            latestSeq: Math.max(current.latestSeq, event.seq),
            updatedAt: event.timestamp,
            title: current.title ?? derivedTitle,
          }
        })

        if (event.sessionId !== MAIN_SESSION_ID) {
          setSessions((current) => {
            const existing = current.find((entry) => entry.sessionId === event.sessionId)
            const nextStatus =
              event.type === 'session.status' && typeof event.payload.status === 'string'
                ? (event.payload.status as SessionState['status'])
                : existing?.status ?? 'idle'

            return upsertSession(current, {
              sessionId: event.sessionId,
              createdAt: existing?.createdAt ?? event.timestamp,
              updatedAt: event.timestamp,
              latestSeq: Math.max(existing?.latestSeq ?? 0, event.seq),
              status: nextStatus,
              title: existing?.title ?? derivedTitle,
            })
          })
        }
      }

      eventSource.onerror = () => {
        eventSource?.close()
        if (cancelled) return
        setStreamStatus('reconnecting')
        reconnectTimer = window.setTimeout(() => {
          connect(latestSeqRef.current)
        }, 1500)
      }
    }

    connect(latestSeqRef.current)

    return () => {
      cancelled = true
      eventSource?.close()
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
      }
    }
  }, [session?.sessionId])

  const handleNavigateMain = useCallback(() => {
    setPrompt('')
    clearActiveConversation()
    navigateTo({ kind: 'main' })
  }, [clearActiveConversation, navigateTo])

  const handleNavigateThreads = useCallback(() => {
    setPrompt('')
    clearActiveConversation()
    navigateTo({ kind: 'threads' })
  }, [clearActiveConversation, navigateTo])

  const handleCreateThread = async () => {
    setIsCreating(true)
    setError(null)

    try {
      const created = await createSession()
      pendingSessionRef.current = created
      setSessions((current) => upsertSession(current, created))
      setPrompt('')
      clearActiveConversation()
      navigateTo({ kind: 'thread', sessionId: created.sessionId })
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create thread')
    } finally {
      setIsCreating(false)
    }
  }

  const handleOpenThread = useCallback(
    (nextSession: SessionState) => {
      setPrompt('')
      pendingSessionRef.current = nextSession
      clearActiveConversation()
      navigateTo({ kind: 'thread', sessionId: nextSession.sessionId })
    },
    [clearActiveConversation, navigateTo],
  )

  const handleSendPrompt = async () => {
    const text = prompt.trim()
    if (!text || !session || isSending || isAborting || session.status === 'active') return

    setIsSending(true)
    setError(null)

    try {
      await sendPrompt(session.sessionId, text)

      const now = new Date().toISOString()
      const title = session.sessionId === MAIN_SESSION_ID ? 'Main' : session.title ?? createChatTitle(text)

      setSession((current) => {
        if (!current || current.sessionId !== session.sessionId) {
          return current
        }

        return {
          ...current,
          status: 'active',
          updatedAt: now,
          title,
        }
      })

      if (session.sessionId !== MAIN_SESSION_ID) {
        setSessions((current) =>
          upsertSession(current, {
            ...session,
            status: 'active',
            updatedAt: now,
            title,
          }),
        )
      }

      setPrompt('')
    } catch (promptError) {
      setError(promptError instanceof Error ? promptError.message : 'Failed to send prompt')
    } finally {
      setIsSending(false)
    }
  }

  const handleAbort = async () => {
    if (!session) return
    setIsAborting(true)
    setError(null)

    try {
      await abortSession(session.sessionId)
    } catch (abortError) {
      setError(abortError instanceof Error ? abortError.message : 'Failed to abort prompt')
    } finally {
      setIsAborting(false)
    }
  }

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void handleSendPrompt()
  }

  const transcript = useMemo(() => buildTranscript(events), [events])

  const activeTitle = useMemo(() => {
    if (route.kind === 'main') return 'Main'
    if (route.kind === 'threads') return 'Threads'
    return getThreadTitle(session, transcript)
  }, [route.kind, session, transcript])

  const activeModel = useMemo(() => {
    const readyEvent = [...events]
      .reverse()
      .find((event) => event.type === 'runtime.session.ready')

    return typeof readyEvent?.payload.modelId === 'string' ? readyEvent.payload.modelId : null
  }, [events])

  const streamToneClass = useMemo(() => {
    switch (streamStatus) {
      case 'connected':
        return 'bg-emerald-500'
      case 'reconnecting':
      case 'connecting':
        return 'bg-amber-500'
      case 'error':
        return 'bg-red-500'
      default:
        return 'bg-muted-foreground/50'
    }
  }, [streamStatus])

  const activeSection = route.kind === 'main' ? 'main' : 'threads'
  const isSessionActive = session?.status === 'active'
  const lastTranscriptMessage = transcript[transcript.length - 1]
  const showThinking =
    Boolean(session) &&
    isSessionActive &&
    !(lastTranscriptMessage?.role === 'assistant' && lastTranscriptMessage.status === 'streaming')

  const isShowingConversation = route.kind === 'main' || route.kind === 'thread'
  const currentThreadId = route.kind === 'thread' ? route.sessionId : null

  const scrollToBottom = useCallback(() => {
    messageEndRef.current?.scrollIntoView({ block: 'end' })
  }, [])

  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom()
    }
  }, [transcript, showThinking, scrollToBottom])

  useEffect(() => {
    isNearBottomRef.current = true
    scrollToBottom()
  }, [route.kind, session?.sessionId, scrollToBottom])

  return (
    <SidebarProvider>
      <AppSidebar
        activeSection={activeSection}
        onNavigateMain={handleNavigateMain}
        onNavigateThreads={handleNavigateThreads}
        onCreateThread={handleCreateThread}
        isCreating={isCreating}
      />
      <SidebarInset className='overflow-hidden'>
        <header className='flex h-12 shrink-0 items-center gap-2 border-b'>
          <div className='flex items-center gap-2 px-4'>
            <SidebarTrigger className='-ml-1' />
            <Separator orientation='vertical' className='mr-2 !self-auto data-[orientation=vertical]:h-4' />
            <div className='flex items-center gap-2 text-sm'>
              <span className='truncate font-medium'>{activeTitle}</span>
              {isShowingConversation && session ? (
                <span className={cn('size-2 shrink-0 rounded-full', streamToneClass)} />
              ) : null}
            </div>
          </div>
        </header>

        {isShowingConversation ? (
          <div className='flex min-h-0 flex-1 flex-col'>
            <div
              ref={scrollRef}
              className='min-h-0 flex-1 overflow-y-auto'
              onScroll={() => {
                const element = scrollRef.current
                if (!element) return
                isNearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
              }}
            >
              <div className='flex min-h-full flex-col justify-end gap-4 px-2 py-4'>
                {isLoadingConversation && !session ? (
                  <div className='flex min-h-[40vh] flex-col items-center justify-center gap-4 border border-dashed bg-card/70 px-6 py-12 text-center'>
                    <SpinnerGap className='size-6 animate-spin text-muted-foreground' />
                    <p className='text-sm text-muted-foreground'>Loading conversation…</p>
                  </div>
                ) : transcript.length === 0 ? (
                  <div className='flex min-h-[40vh] flex-col items-center justify-center gap-4 border border-dashed bg-card/70 px-6 py-12 text-center'>
                    <h3 className='text-2xl font-semibold tracking-tight'>
                      {route.kind === 'main' ? 'This is your main thread' : 'This thread is ready'}
                    </h3>
                    <p className='max-w-xl text-sm leading-6 text-muted-foreground sm:text-base'>
                      {route.kind === 'main'
                        ? 'Use this as the ongoing rolling conversation with your agent. Compaction can happen behind the scenes.'
                        : 'Ask a focused follow-up here, or jump back to Main from the sidebar header anytime.'}
                    </p>
                  </div>
                ) : (
                  transcript.map((message) => {
                    if (message.role === 'system') {
                      const tone =
                        message.status === 'error'
                          ? 'border-destructive/30 bg-destructive/5 text-destructive'
                          : 'border-border bg-background text-muted-foreground'

                      return (
                        <div key={message.id} className='flex justify-center'>
                          <div className={cn('max-w-2xl border px-4 py-3 text-sm', tone)}>
                            <p className='whitespace-pre-wrap leading-6'>{message.text}</p>
                          </div>
                        </div>
                      )
                    }

                    const isUser = message.role === 'user'
                    const bubbleClasses = isUser
                      ? 'bg-primary text-primary-foreground'
                      : 'border bg-background text-card-foreground shadow-sm'
                    const metaLabel =
                      message.status === 'streaming'
                        ? 'Thinking…'
                        : message.status === 'aborted'
                          ? 'Stopped'
                          : formatMessageTime(message.timestamp)

                    return (
                      <div key={message.id} className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
                        <div className={cn('max-w-[88%] px-3 py-2 sm:max-w-[78%]', bubbleClasses)}>
                          <p className='whitespace-pre-wrap text-sm leading-6 sm:text-[15px]'>
                            {message.text}
                          </p>
                          <p
                            className={cn(
                              'mt-1 text-[11px]',
                              isUser ? 'text-primary-foreground/70' : 'text-muted-foreground',
                            )}
                          >
                            {metaLabel}
                          </p>
                        </div>
                      </div>
                    )
                  })
                )}

                {showThinking ? (
                  <div className='flex justify-start'>
                    <div className='border bg-background px-4 py-3 text-sm text-muted-foreground shadow-sm'>
                      Pi is thinking…
                    </div>
                  </div>
                ) : null}

                <div ref={messageEndRef} />
              </div>
            </div>

            <div className='shrink-0 border-t bg-background/95 px-2 py-2 backdrop-blur'>
              <div className='flex flex-col gap-2'>
                {error ? (
                  <div className='border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive'>
                    {error}
                  </div>
                ) : null}

                <div className='border bg-card shadow-sm'>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    placeholder={route.kind === 'main' ? 'Message Main…' : 'Message this thread…'}
                    className='min-h-24 w-full resize-none border-0 bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground/80 sm:text-[15px]'
                    disabled={!session || isLoadingConversation || isSending || isAborting}
                  />
                  <div className='flex items-center justify-between gap-2 border-t px-2 py-2'>
                    <div className='min-w-0 text-xs text-muted-foreground'>
                      {session ? (
                        <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
                          <span>{session.status === 'active' ? 'Responding' : 'Ready'}</span>
                          <span>•</span>
                          <span>{session.sessionId === MAIN_SESSION_ID ? 'Main' : shortId(session.sessionId)}</span>
                          {activeModel ? (
                            <>
                              <span>•</span>
                              <span className='truncate'>{activeModel}</span>
                            </>
                          ) : null}
                        </div>
                      ) : (
                        <span>{isLoadingConversation ? 'Preparing conversation…' : 'Conversation unavailable'}</span>
                      )}
                    </div>
                    <div className='flex items-center gap-2'>
                      <Button
                        variant='outline'
                        onClick={handleAbort}
                        disabled={!session || !isSessionActive || isAborting}
                      >
                        {isAborting ? (
                          <SpinnerGap className='animate-spin' data-icon='inline-start' />
                        ) : (
                          <StopCircle data-icon='inline-start' />
                        )}
                        {isAborting ? 'Stopping…' : 'Stop'}
                      </Button>
                      <Button
                        onClick={handleSendPrompt}
                        disabled={!session || !prompt.trim() || isSending || isAborting || isSessionActive}
                      >
                        {isSending ? (
                          <SpinnerGap className='animate-spin' data-icon='inline-start' />
                        ) : (
                          <ArrowSquareOut data-icon='inline-start' />
                        )}
                        {isSending ? 'Sending…' : 'Send'}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className='flex min-h-0 flex-1 flex-col'>
            <div className='min-h-0 flex-1 overflow-y-auto'>
              <div className='mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-6 sm:px-6'>
                {error ? (
                  <div className='border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive'>
                    {error}
                  </div>
                ) : null}

                {isLoadingSessions && sessions.length === 0 ? (
                  <div className='border border-dashed bg-card/70 px-4 py-6 text-sm text-muted-foreground'>
                    Loading threads…
                  </div>
                ) : sessions.length === 0 ? (
                  <div className='flex min-h-[40vh] flex-col items-center justify-center gap-4 border border-dashed bg-card/70 px-6 py-12 text-center'>
                    <h3 className='text-2xl font-semibold tracking-tight'>No threads yet</h3>
                    <p className='max-w-xl text-sm leading-6 text-muted-foreground sm:text-base'>
                      Main lives at the root route. Create extra threads here when you want to branch off.
                    </p>
                    <Button onClick={handleCreateThread} disabled={isCreating}>
                      {isCreating ? (
                        <SpinnerGap className='animate-spin' data-icon='inline-start' />
                      ) : (
                        <Plus data-icon='inline-start' />
                      )}
                      {isCreating ? 'Creating…' : 'New thread'}
                    </Button>
                  </div>
                ) : (
                  sessions.map((item) => {
                    const isCurrent = currentThreadId === item.sessionId
                    const title = item.title?.trim() || `Thread ${shortId(item.sessionId)}`

                    return (
                      <button
                        key={item.sessionId}
                        type='button'
                        onClick={() => handleOpenThread(item)}
                        className={cn(
                          'flex w-full flex-col gap-4 border bg-background px-4 py-4 text-left transition-colors hover:bg-card sm:flex-row sm:items-center sm:justify-between',
                          isCurrent && 'border-foreground/15 bg-card shadow-sm',
                        )}
                      >
                        <div className='min-w-0 flex-1'>
                          <div className='flex flex-wrap items-center gap-2'>
                            <p className='line-clamp-2 text-base font-medium leading-6'>{title}</p>
                            {isCurrent ? (
                              <span className='border px-1.5 py-0.5 text-[11px] text-muted-foreground'>
                                Current
                              </span>
                            ) : null}
                            <span
                              className={cn(
                                'inline-flex items-center gap-2 border px-1.5 py-0.5 text-[11px]',
                                item.status === 'active'
                                  ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600'
                                  : 'text-muted-foreground',
                              )}
                            >
                              <span
                                className={cn(
                                  'size-2 rounded-full',
                                  item.status === 'active' ? 'bg-emerald-500' : 'bg-border',
                                )}
                              />
                              {item.status === 'active' ? 'Active' : 'Idle'}
                            </span>
                          </div>

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
                    )
                  })
                )}
              </div>
            </div>

            <div className='shrink-0 border-t bg-background/95 px-4 py-4 backdrop-blur sm:px-6'>
              <div className='mx-auto flex w-full max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
                <p className='text-sm text-muted-foreground'>
                  Open a thread here, or return to Main from the sidebar header.
                </p>
                <Button onClick={handleCreateThread} disabled={isCreating}>
                  {isCreating ? (
                    <SpinnerGap className='animate-spin' data-icon='inline-start' />
                  ) : (
                    <Plus data-icon='inline-start' />
                  )}
                  {isCreating ? 'Creating…' : 'New thread'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App
