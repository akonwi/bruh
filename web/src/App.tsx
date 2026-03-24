import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  createSession,
  createSessionStream,
  getSession,
  sendPrompt,
  type SessionEventEnvelope,
  type SessionState,
} from '@/lib/api'

const SESSION_STORAGE_KEY = 'bruh.activeSessionId'

type StreamStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

function App() {
  const [session, setSession] = useState<SessionState | null>(null)
  const [events, setEvents] = useState<SessionEventEnvelope[]>([])
  const [prompt, setPrompt] = useState('')
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const latestSeqRef = useRef(0)

  useEffect(() => {
    const existingSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY)
    if (!existingSessionId) return

    void getSession(existingSessionId)
      .then((loaded) => {
        setSession(loaded)
      })
      .catch(() => {
        window.localStorage.removeItem(SESSION_STORAGE_KEY)
      })
  }, [])

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
        latestSeqRef.current = Math.max(latestSeqRef.current, event.seq)
        setEvents((current) => {
          if (current.some((entry) => entry.seq === event.seq)) return current
          return [...current, event].sort((a, b) => a.seq - b.seq)
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
      latestSeqRef.current = 0
      setEvents([])
      setSession(created)
      window.localStorage.setItem(SESSION_STORAGE_KEY, created.sessionId)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create session')
    } finally {
      setIsCreating(false)
    }
  }

  const handleSendPrompt = async () => {
    if (!session || !prompt.trim()) return
    setIsSending(true)
    setError(null)
    try {
      await sendPrompt(session.sessionId, prompt.trim())
      setPrompt('')
    } catch (promptError) {
      setError(promptError instanceof Error ? promptError.message : 'Failed to send prompt')
    } finally {
      setIsSending(false)
    }
  }

  const statusTone = useMemo(() => {
    switch (streamStatus) {
      case 'connected':
        return 'text-emerald-600 dark:text-emerald-400'
      case 'reconnecting':
      case 'connecting':
        return 'text-amber-600 dark:text-amber-400'
      case 'error':
        return 'text-red-600 dark:text-red-400'
      default:
        return 'text-muted-foreground'
    }
  }, [streamStatus])

  const assistantText = useMemo(() => {
    const deltaText = events
      .filter((event) => event.type === 'assistant.text.delta')
      .map((event) => String(event.payload.delta ?? ''))
      .join('')

    if (deltaText) return deltaText

    const finalTextEvent = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === 'assistant.message.complete' ||
          event.type === 'assistant.turn.complete' ||
          event.type === 'assistant.agent.complete',
      )

    return finalTextEvent ? String(finalTextEvent.payload.text ?? '') : ''
  }, [events])

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-10">
        <header className="flex flex-col gap-4 border-b pb-6">
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Bruh</p>
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="max-w-3xl space-y-3">
              <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">
                Session DO + SSE skeleton
              </h1>
              <p className="text-sm leading-6 text-muted-foreground sm:text-base">
                This is the first real local checkpoint: create a session, attach to its Durable
                Object stream, send prompts through the edge layer, and stream Anthropic-backed Pi
                output back into the UI.
              </p>
            </div>
            <Button onClick={handleCreateSession} disabled={isCreating}>
              {isCreating ? 'Creating…' : session ? 'New session' : 'Create session'}
            </Button>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <article className="flex flex-col gap-4 border bg-card p-4">
            <div className="flex flex-col gap-2 border-b pb-4">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium">Session</span>
                <code className="rounded-none bg-muted px-2 py-1 text-xs">
                  {session?.sessionId ?? 'none'}
                </code>
              </div>
              <p className={`text-xs uppercase tracking-[0.2em] ${statusTone}`}>
                stream: {streamStatus}
              </p>
              {session ? (
                <p className="text-sm text-muted-foreground">
                  latest sequence: <span className="font-medium text-foreground">{latestSeqRef.current}</span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Create a session to open a Durable Object-backed SSE stream.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium">Prompt</label>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Ask Pi something…"
                className="min-h-28 rounded-none border bg-background px-3 py-2 text-sm outline-none ring-0 transition focus:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
                disabled={!session || isSending}
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Prompts are forwarded through the SessionDO to the local Pi runtime.
                </p>
                <Button onClick={handleSendPrompt} disabled={!session || !prompt.trim() || isSending}>
                  {isSending ? 'Sending…' : 'Send prompt'}
                </Button>
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>
          </article>

          <article className="flex min-h-[32rem] flex-col gap-4 border bg-card p-4">
            <div className="border-b pb-4">
              <h2 className="text-lg font-medium">Assistant output</h2>
              <p className="text-sm text-muted-foreground">
                Streaming text assembled from delta events, with a fallback to completed assistant
                messages if deltas are sparse.
              </p>
            </div>
            <div className="min-h-40 border bg-background p-4 text-sm leading-7 whitespace-pre-wrap">
              {assistantText || 'No assistant text yet.'}
            </div>

            <div className="border-t pt-4">
              <h3 className="text-sm font-medium">Event stream</h3>
              <p className="mb-3 text-sm text-muted-foreground">
                Replayed and live events from the session Durable Object.
              </p>
              <div className="max-h-[22rem] overflow-auto pr-1">
                {events.length === 0 ? (
                  <div className="flex min-h-40 items-center justify-center border border-dashed text-sm text-muted-foreground">
                    No events yet.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {events.map((event) => (
                      <div key={event.seq} className="border bg-background p-3">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                            {event.type}
                          </p>
                          <span className="text-xs text-muted-foreground">seq {event.seq}</span>
                        </div>
                        <pre className="overflow-x-auto text-xs leading-6 text-foreground whitespace-pre-wrap break-words">
                          {JSON.stringify(event.payload, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </article>
        </section>
      </div>
    </main>
  )
}

export default App
