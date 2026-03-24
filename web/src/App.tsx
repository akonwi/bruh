import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  abortSession,
  createSession,
  createSessionStream,
  getSession,
  listSessions,
  sendPrompt,
  type SessionEventEnvelope,
  type SessionState,
} from '@/lib/api'

const SESSION_STORAGE_KEY = 'bruh.activeSessionId'
const USER_EVENT_TYPES = new Set(['session.prompt.accepted', 'runtime.prompt.start'])
const ASSISTANT_COMPLETE_EVENT_TYPES = new Set([
  'assistant.message.complete',
  'assistant.turn.complete',
  'assistant.agent.complete',
])

type StreamStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'
type ChatMessageRole = 'user' | 'assistant' | 'system'
type ChatMessageStatus = 'complete' | 'streaming' | 'aborted' | 'error'

interface ChatMessage {
  id: string
  role: ChatMessageRole
  status: ChatMessageStatus
  text: string
  timestamp: string
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
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function upsertSession(current: SessionState[], session: SessionState): SessionState[] {
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

function getSessionTitle(session: SessionState | null, messages: ChatMessage[]): string {
  if (session?.title?.trim()) return session.title
  const firstUserMessage = messages.find((message) => message.role === 'user')
  if (firstUserMessage) return createChatTitle(firstUserMessage.text)
  return 'New chat'
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
  const [session, setSession] = useState<SessionState | null>(null)
  const [sessions, setSessions] = useState<SessionState[]>([])
  const [events, setEvents] = useState<SessionEventEnvelope[]>([])
  const [prompt, setPrompt] = useState('')
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isLoadingSessions, setIsLoadingSessions] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isAborting, setIsAborting] = useState(false)
  const latestSeqRef = useRef(0)
  const messageEndRef = useRef<HTMLDivElement | null>(null)

  const activateSession = useCallback((nextSession: SessionState | null) => {
    latestSeqRef.current = 0
    setEvents([])
    setSession(nextSession)
    setError(null)

    if (!nextSession) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY)
      return
    }

    window.localStorage.setItem(SESSION_STORAGE_KEY, nextSession.sessionId)
    setSessions((current) => upsertSession(current, nextSession))
  }, [])

  useEffect(() => {
    let cancelled = false

    const boot = async () => {
      setIsLoadingSessions(true)

      try {
        const listedSessions = await listSessions()
        if (cancelled) return

        setSessions(sortSessions(listedSessions))

        const storedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY)
        let initialSession: SessionState | null = null

        if (storedSessionId) {
          initialSession =
            listedSessions.find((entry) => entry.sessionId === storedSessionId) ??
            (await getSession(storedSessionId).catch(() => null))

          if (!initialSession) {
            window.localStorage.removeItem(SESSION_STORAGE_KEY)
          }
        } else {
          initialSession = listedSessions[0] ?? null
        }

        if (cancelled) return
        if (initialSession) {
          activateSession(initialSession)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load sessions')
        }
      } finally {
        if (!cancelled) {
          setIsLoadingSessions(false)
        }
      }
    }

    void boot()

    return () => {
      cancelled = true
    }
  }, [activateSession])

  useEffect(() => {
    if (!session) {
      setStreamStatus('idle')
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

  const handleCreateSession = async () => {
    setIsCreating(true)
    setError(null)

    try {
      const created = await createSession()
      setPrompt('')
      activateSession(created)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create session')
    } finally {
      setIsCreating(false)
    }
  }

  const handleSelectSession = (nextSession: SessionState) => {
    if (session?.sessionId === nextSession.sessionId) return
    activateSession(nextSession)
  }

  const handleSendPrompt = async () => {
    const text = prompt.trim()
    if (!text || isSending || isAborting || (session?.status === 'active')) return

    setIsSending(true)
    setError(null)

    try {
      let targetSession = session

      if (!targetSession) {
        setIsCreating(true)
        targetSession = await createSession()
        activateSession(targetSession)
      }

      await sendPrompt(targetSession.sessionId, text)

      const now = new Date().toISOString()
      const title = targetSession.title ?? createChatTitle(text)
      const optimisticSession: SessionState = {
        ...targetSession,
        status: 'active',
        updatedAt: now,
        title,
      }

      setSession((current) => {
        if (!current || current.sessionId !== optimisticSession.sessionId) {
          return optimisticSession
        }

        return {
          ...current,
          status: 'active',
          updatedAt: now,
          title: current.title ?? title,
        }
      })
      setSessions((current) => upsertSession(current, optimisticSession))
      setPrompt('')
    } catch (promptError) {
      setError(promptError instanceof Error ? promptError.message : 'Failed to send prompt')
    } finally {
      setIsCreating(false)
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

  const activeTitle = useMemo(() => getSessionTitle(session, transcript), [session, transcript])

  const activeModel = useMemo(() => {
    const readyEvent = [...events]
      .reverse()
      .find((event) => event.type === 'runtime.session.ready')

    return typeof readyEvent?.payload.modelId === 'string' ? readyEvent.payload.modelId : null
  }, [events])

  const streamTone = useMemo(() => {
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

  const isSessionActive = session?.status === 'active'
  const lastTranscriptMessage = transcript[transcript.length - 1]
  const showThinking =
    Boolean(session) &&
    isSessionActive &&
    !(lastTranscriptMessage?.role === 'assistant' && lastTranscriptMessage.status === 'streaming')

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: 'end' })
  }, [transcript, showThinking])

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="border-b bg-muted/20 lg:border-r lg:border-b-0">
          <div className="flex h-full max-h-screen flex-col">
            <div className="border-b px-4 py-4 sm:px-5 sm:py-5">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <p className="text-[11px] uppercase tracking-[0.32em] text-muted-foreground">
                    Bruh
                  </p>
                  <div>
                    <h1 className="text-xl font-semibold tracking-tight">Chats</h1>
                    <p className="text-sm text-muted-foreground">
                      Personal Pi runtime with session replay and abort support.
                    </p>
                  </div>
                </div>
                <Button onClick={handleCreateSession} disabled={isCreating} size="sm">
                  {isCreating ? 'Creating…' : 'New chat'}
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
              <div className="mb-3 flex items-center justify-between px-1">
                <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
                  Recent
                </p>
                <span className="text-xs text-muted-foreground">{sessions.length}</span>
              </div>

              {isLoadingSessions && sessions.length === 0 ? (
                <div className="border border-dashed bg-background/70 p-4 text-sm text-muted-foreground">
                  Loading chats…
                </div>
              ) : sessions.length === 0 ? (
                <div className="border border-dashed bg-background/70 p-4 text-sm text-muted-foreground">
                  No chats yet. Start a new one to begin.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {sessions.map((item) => {
                    const isActive = session?.sessionId === item.sessionId
                    const title = item.title?.trim() || `Chat ${shortId(item.sessionId)}`

                    return (
                      <button
                        key={item.sessionId}
                        type="button"
                        onClick={() => handleSelectSession(item)}
                        className={`w-full border p-3 text-left transition-colors ${
                          isActive
                            ? 'border-foreground/15 bg-card shadow-sm'
                            : 'border-border bg-background hover:bg-card'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-sm font-medium leading-5">{title}</p>
                            <p className="mt-2 truncate text-xs text-muted-foreground">
                              {shortId(item.sessionId)}
                            </p>
                          </div>
                          <span
                            className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                              item.status === 'active' ? 'bg-emerald-500' : 'bg-border'
                            }`}
                          />
                        </div>
                        <p className="mt-3 text-xs text-muted-foreground">
                          {formatRelativeTime(item.updatedAt)}
                        </p>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </aside>

        <section className="flex min-h-screen min-w-0 flex-col">
          <header className="border-b bg-background/90 px-4 py-4 backdrop-blur sm:px-6">
            <div className="mx-auto flex w-full max-w-3xl items-start justify-between gap-4">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-xl font-semibold tracking-tight">{activeTitle}</h2>
                  {session ? (
                    <span className="inline-flex items-center gap-2 border px-2 py-1 text-xs text-muted-foreground">
                      <span className={`h-2 w-2 rounded-full ${streamTone}`} />
                      {streamStatus}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  {session ? (
                    <>
                      <span>{session.status === 'active' ? 'Pi is responding…' : 'Ready'}</span>
                      <span>•</span>
                      <span>{shortId(session.sessionId)}</span>
                    </>
                  ) : (
                    <span>Pick a chat or start a new one.</span>
                  )}
                  {activeModel ? (
                    <>
                      <span>•</span>
                      <span className="truncate">{activeModel}</span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
                {!session ? (
                  <div className="flex min-h-[40vh] flex-col items-center justify-center gap-5 border border-dashed bg-card/40 px-6 py-12 text-center">
                    <div className="space-y-2">
                      <p className="text-sm font-medium uppercase tracking-[0.24em] text-muted-foreground">
                        Welcome
                      </p>
                      <h3 className="text-3xl font-semibold tracking-tight">Start a new conversation</h3>
                      <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
                        Create a chat, ask something, and your session will stay replayable through
                        the Durable Object stream.
                      </p>
                    </div>
                    <Button onClick={handleCreateSession} disabled={isCreating} size="lg">
                      {isCreating ? 'Creating…' : 'New chat'}
                    </Button>
                  </div>
                ) : transcript.length === 0 ? (
                  <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 border border-dashed bg-card/40 px-6 py-12 text-center">
                    <h3 className="text-2xl font-semibold tracking-tight">What do you want to work on?</h3>
                    <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
                      Ask a question, inspect the repo, or have Pi help you plan the next change.
                    </p>
                  </div>
                ) : (
                  transcript.map((message) => {
                    if (message.role === 'system') {
                      const tone =
                        message.status === 'error'
                          ? 'border-destructive/30 bg-destructive/5 text-destructive'
                          : 'border-border bg-muted/60 text-muted-foreground'

                      return (
                        <div key={message.id} className="flex justify-center">
                          <div className={`max-w-2xl border px-4 py-3 text-sm ${tone}`}>
                            <p className="whitespace-pre-wrap leading-6">{message.text}</p>
                          </div>
                        </div>
                      )
                    }

                    const isUser = message.role === 'user'
                    const bubbleClasses = isUser
                      ? 'bg-primary text-primary-foreground'
                      : 'border bg-card text-card-foreground'
                    const metaLabel =
                      message.status === 'streaming'
                        ? 'Thinking…'
                        : message.status === 'aborted'
                          ? 'Stopped'
                          : formatMessageTime(message.timestamp)

                    return (
                      <div
                        key={message.id}
                        className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                      >
                        <div className={`max-w-[85%] px-4 py-3 sm:max-w-[78%] ${bubbleClasses}`}>
                          <p className="whitespace-pre-wrap text-sm leading-7 sm:text-[15px]">
                            {message.text}
                          </p>
                          <p
                            className={`mt-2 text-[11px] ${
                              isUser ? 'text-primary-foreground/70' : 'text-muted-foreground'
                            }`}
                          >
                            {metaLabel}
                          </p>
                        </div>
                      </div>
                    )
                  })
                )}

                {showThinking ? (
                  <div className="flex justify-start">
                    <div className="border bg-card px-4 py-3 text-sm text-muted-foreground">
                      Pi is thinking…
                    </div>
                  </div>
                ) : null}

                <div ref={messageEndRef} />
              </div>
            </div>

            <div className="border-t bg-background/95 px-4 py-4 backdrop-blur sm:px-6">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
                {error ? (
                  <div className="border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    {error}
                  </div>
                ) : null}

                <div className="border bg-card shadow-sm">
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    placeholder={
                      session
                        ? 'Message Pi…'
                        : 'Type a message… a new chat will be created when you send it.'
                    }
                    className="min-h-32 w-full resize-none border-0 bg-transparent px-4 py-4 text-sm outline-none placeholder:text-muted-foreground/80 sm:text-[15px]"
                    disabled={isSending || isAborting}
                  />
                  <div className="flex flex-col gap-3 border-t px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-muted-foreground">
                      {isSessionActive
                        ? 'Pi is responding. You can wait or stop the current run.'
                        : 'Press Enter to send. Use Shift+Enter for a newline.'}
                    </p>
                    <div className="flex items-center gap-2 self-end sm:self-auto">
                      <Button
                        variant="outline"
                        onClick={handleAbort}
                        disabled={!session || !isSessionActive || isAborting}
                      >
                        {isAborting ? 'Aborting…' : 'Stop'}
                      </Button>
                      <Button
                        onClick={handleSendPrompt}
                        disabled={!prompt.trim() || isSending || isAborting || isSessionActive}
                      >
                        {isSending ? 'Sending…' : 'Send'}
                      </Button>
                    </div>
                  </div>
                </div>

                {session ? (
                  <details className="border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
                    <summary className="cursor-pointer list-none font-medium text-foreground">
                      Developer details
                    </summary>
                    <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                      <p>
                        <span className="text-muted-foreground">Session:</span> {session.sessionId}
                      </p>
                      <p>
                        <span className="text-muted-foreground">Events:</span> {events.length}
                      </p>
                      <p>
                        <span className="text-muted-foreground">Latest seq:</span>{' '}
                        {latestSeqRef.current}
                      </p>
                      <p>
                        <span className="text-muted-foreground">Model:</span>{' '}
                        {activeModel ?? 'Not ready yet'}
                      </p>
                    </div>
                    <div className="mt-3 max-h-48 overflow-auto border bg-background p-3">
                      <div className="flex flex-col gap-2">
                        {events.slice(-12).map((event) => (
                          <div key={event.seq} className="border bg-card px-3 py-2">
                            <div className="mb-1 flex items-center justify-between gap-2">
                              <span className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                                {event.type}
                              </span>
                              <span className="text-[11px] text-muted-foreground">seq {event.seq}</span>
                            </div>
                            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-foreground">
                              {JSON.stringify(event.payload, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}

export default App
