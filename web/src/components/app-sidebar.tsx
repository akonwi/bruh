import {
  ChatsTeardrop,
  ClockCounterClockwise,
  House,
  Lightning,
  Plus,
  WarningCircle,
} from '@phosphor-icons/react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

export type AppSection = 'main' | 'threads'

export interface SessionState {
  sessionId: string
  title?: string
  createdAt: string
  updatedAt: string
}

interface McpServerInfo {
  name: string
  state: string
  server_url: string
  error: string | null
}

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  activeSection: AppSection
  activeThreadId: string | null
  onNavigateMain: () => void
  onOpenThread: (sessionId: string) => void
  onCreateThread: () => void
  isCreating: boolean
  sessions: SessionState[]
  mcpServers: McpServerInfo[]
  mcpToolCount: number
}

function SidebarHeaderContent({
  onNavigateMain,
}: {
  onNavigateMain: () => void
}) {
  const { state } = useSidebar()
  const collapsed = state === 'collapsed'

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size='lg' tooltip='Main' onClick={onNavigateMain}>
          <div className='flex aspect-square size-8 items-center justify-center bg-sidebar-primary text-sidebar-primary-foreground'>
            <House weight='fill' />
          </div>
          {!collapsed ? (
            <div className='grid flex-1 text-left text-sm leading-tight'>
              <span className='truncate font-semibold'>Main</span>
              <span className='truncate text-xs text-sidebar-foreground/70'>
                Bruh
              </span>
            </div>
          ) : null}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

const stateColors: Record<string, string> = {
  ready: 'bg-emerald-500',
  authenticating: 'bg-amber-500',
  connecting: 'bg-amber-500',
  connected: 'bg-amber-500',
  discovering: 'bg-amber-500',
  failed: 'bg-destructive',
}

function McpServerItem({ server }: { server: McpServerInfo }) {
  const dotColor = stateColors[server.state] ?? 'bg-muted-foreground/50'
  const isFailed = server.state === 'failed'

  return (
    <div className='flex items-center gap-2 px-2 py-1'>
      <span className={cn('size-1.5 shrink-0 rounded-full', dotColor)} />
      <span
        className={cn(
          'min-w-0 truncate text-xs',
          isFailed ? 'text-destructive' : 'text-sidebar-foreground/70',
        )}
      >
        {server.name}
      </span>
      {isFailed ? (
        <WarningCircle className='size-3 shrink-0 text-destructive' />
      ) : null}
    </div>
  )
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
  if (diffMinutes < 60) return `${diffMinutes}m`
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h`
  const diffDays = Math.round(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d`
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp))
}

function sortSessions(sessions: SessionState[]): SessionState[] {
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function AppSidebar({
  activeSection,
  activeThreadId,
  onNavigateMain,
  onOpenThread,
  onCreateThread,
  isCreating,
  sessions,
  mcpServers,
  mcpToolCount,
  ...props
}: AppSidebarProps) {
  const { state } = useSidebar()
  const collapsed = state === 'collapsed'
  const sortedSessions = sortSessions(sessions)
  const hasThreads = sessions.length > 0

  return (
    <Sidebar collapsible='icon' {...props}>
      <SidebarHeader>
        <SidebarHeaderContent onNavigateMain={onNavigateMain} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className='flex items-center gap-1.5'>
            <ChatsTeardrop className='size-3.5' />
            <span>Threads</span>
          </SidebarGroupLabel>
          <SidebarGroupAction
            onClick={onCreateThread}
            disabled={isCreating}
            title='New thread'
          >
            <Plus />
            <span className='sr-only'>New thread</span>
          </SidebarGroupAction>
          <SidebarMenu>
            {hasThreads && (
              <SidebarMenuSub>
                {sortedSessions.map((session) => (
                  <SidebarMenuSubItem key={session.sessionId}>
                    <SidebarMenuSubButton
                      isActive={activeThreadId === session.sessionId}
                      onClick={() => onOpenThread(session.sessionId)}
                    >
                      <span className='truncate'>
                        {session.title?.trim() || shortId(session.sessionId)}
                      </span>
                      <span className='ml-auto flex shrink-0 items-center gap-1 text-[10px] text-sidebar-foreground/50'>
                        <ClockCounterClockwise className='size-2.5' />
                        {formatRelativeTime(session.updatedAt)}
                      </span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            )}

            <SidebarMenuItem></SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {!collapsed && mcpServers.length > 0 ? (
          <SidebarGroup>
            <SidebarGroupLabel className='flex items-center gap-1.5'>
              <Lightning className='size-3' />
              <span>MCP Servers</span>
              {mcpToolCount > 0 ? (
                <span className='text-[10px] text-sidebar-foreground/50'>
                  ({mcpToolCount} tools)
                </span>
              ) : null}
            </SidebarGroupLabel>
            <div className='flex flex-col gap-0.5'>
              {mcpServers.map((server) => (
                <McpServerItem key={server.name} server={server} />
              ))}
            </div>
          </SidebarGroup>
        ) : null}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
