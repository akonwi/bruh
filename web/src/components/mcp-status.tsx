import { WarningCircleIcon } from '@phosphor-icons/react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { McpServerInfo } from '@/lib/types'
import { cn } from '@/lib/utils'

const STATE_COLORS: Record<string, string> = {
  ready: 'bg-emerald-500',
  authenticating: 'bg-amber-500',
  connecting: 'bg-amber-500',
  connected: 'bg-amber-500',
  discovering: 'bg-amber-500',
  failed: 'bg-destructive',
}

function getAggregateColor(servers: McpServerInfo[]): string {
  const hasError = servers.some((s) => s.state === 'failed')
  if (hasError) return 'bg-destructive'
  const allReady = servers.every((s) => s.state === 'ready')
  if (allReady) return 'bg-emerald-500'
  return 'bg-amber-500'
}

export function McpStatusIndicator({ servers }: { servers: McpServerInfo[] }) {
  return (
    <Popover>
      <PopoverTrigger className='flex items-center gap-1.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors'>
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            getAggregateColor(servers),
          )}
        />
        <span>MCP</span>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-64 p-2'>
        <div className='flex flex-col gap-1'>
          {servers.map((server) => {
            const dotColor =
              STATE_COLORS[server.state] ?? 'bg-muted-foreground/50'
            const isFailed = server.state === 'failed'
            return (
              <div
                key={server.name}
                className='flex items-center gap-2 rounded px-2 py-1.5 text-xs'
              >
                <span
                  className={cn('size-1.5 shrink-0 rounded-full', dotColor)}
                />
                <span className='min-w-0 truncate font-medium'>
                  {server.name}
                </span>
                <span
                  className={cn(
                    'ml-auto shrink-0',
                    isFailed ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {server.state}
                </span>
                {isFailed ? (
                  <WarningCircleIcon className='size-3 shrink-0 text-destructive' />
                ) : null}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
