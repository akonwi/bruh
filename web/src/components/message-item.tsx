import {
  CaretRightIcon,
  CheckCircleIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
  WrenchIcon,
} from '@phosphor-icons/react'
import {
  type DynamicToolUIPart,
  getToolName,
  isToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai'

import { MessageMarkdown } from '@/components/message-markdown'
import { cn } from '@/lib/utils'

// --- Formatting helpers ---

function formatMessageTime(timestamp: string | Date | undefined): string {
  if (!timestamp) return ''
  const value = new Date(timestamp)
  if (Number.isNaN(value.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

export function formatToolName(
  toolName: string,
  mcpServerNames?: Map<string, string>,
): string {
  // MCP tools are namespaced as "tool_{serverId}_{toolName}" by the SDK
  if (mcpServerNames && mcpServerNames.size > 0) {
    for (const [id, name] of mcpServerNames) {
      const prefixed = `tool_${id}_`
      const bare = `${id}_`
      if (toolName.startsWith(prefixed)) {
        const rest = toolName.slice(prefixed.length)
        return `${name}: ${rest.replaceAll('_', ' ')}`
      }
      if (toolName.startsWith(bare)) {
        const rest = toolName.slice(bare.length)
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

function getMessageCreatedAt(message: UIMessage): string | Date | undefined {
  if (!('createdAt' in message)) return undefined
  const value = (message as UIMessage & { createdAt?: unknown }).createdAt
  if (typeof value === 'string' || value instanceof Date) return value
  return undefined
}

// --- Components ---

export function MessageItem({
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
          return (
            <ToolPart key={i} part={part} mcpServerNames={mcpServerNames} />
          )
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
