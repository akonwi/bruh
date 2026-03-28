import { useAgentChat } from '@cloudflare/ai-chat/react'
import {
  ArrowSquareOutIcon,
  SpinnerGapIcon,
  StopCircleIcon,
} from '@phosphor-icons/react'
import type { KeyboardEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { McpStatusIndicator } from '@/components/mcp-status'
import { MessageItem } from '@/components/message-item'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { deleteMessage, followUpSession, steerSession } from '@/lib/api'
import type { AgentConnection, McpServerInfo } from '@/lib/types'
import { MAIN_SESSION_ID } from '@/lib/types'
import { cn } from '@/lib/utils'

export function ChatView({
  sessionId,
  agent,
  mcpServerNames,
  mcpServers,
}: {
  sessionId: string
  agent: AgentConnection
  mcpServerNames: Map<string, string>
  mcpServers: McpServerInfo[]
}) {
  const clientTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  const { messages, setMessages, sendMessage, stop, error, status } = useAgentChat({
    agent,
    body: () => ({
      clientTimezone,
      clientNowIso: new Date().toISOString(),
    }),
    // Throttle React state updates from the message stream to prevent
    // "Maximum update depth exceeded" during rapid multi-tool call turns.
    experimental_throttle: 50,
  })
  const [input, setInput] = useState('')
  const [queueMode, setQueueMode] = useState<'steer' | 'follow-up'>('steer')
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

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text) return

    if (isLoading) {
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

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      setMessages((prev) => prev.filter((m) => m.id !== messageId))
      try {
        await deleteMessage(sessionId, messageId)
      } catch (e) {
        console.error('Failed to delete message:', e)
      }
    },
    [sessionId, setMessages],
  )

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
                onDelete={() => handleDeleteMessage(message.id)}
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
              <div className='inline-flex items-center gap-2 border bg-background px-3 py-2 text-sm text-muted-foreground'>
                <SpinnerGapIcon className='size-4 animate-spin' />
                <span>Thinking...</span>
              </div>
            </div>
          ) : null}

          <div ref={messageEndRef} />
        </div>
      </div>

      <div
        className={cn(
          'sticky bottom-0 z-20 shrink-0 bg-background/95 px-2 py-2 backdrop-blur',
          isLoading ? 'border-t-0' : 'border-t',
        )}
      >
        {isLoading ? (
          <div className='absolute inset-x-0 top-0 h-px overflow-hidden'>
            <div className='agent-turn-shimmer h-full w-full' />
          </div>
        ) : null}
        <div className='flex flex-col gap-2'>
          {error ? (
            <div className='border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive'>
              {error.message}
            </div>
          ) : null}

          <div className='border bg-card'>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message bruh…"
              className='max-h-24 min-h-14 overflow-y-scroll resize-none border-0 text-sm sm:text-[15px]'
            />
            <div className='flex items-center justify-between gap-2 border-t px-2 py-1'>
              <div className='min-w-0'>
                {mcpServers.length > 0 ? (
                  <McpStatusIndicator servers={mcpServers} />
                ) : null}
              </div>
              <div className='flex items-center gap-2'>
                {isLoading ? (
                  <>
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
                    <Button variant='outline' onClick={() => stop()}>
                      <StopCircleIcon data-icon='inline-start' />
                      Stop
                    </Button>
                  </>
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
