import { ChatsTeardrop, House, Lightning, Moon, Plus, Sun, WarningCircle } from '@phosphor-icons/react'
import type { Theme } from '@/hooks/use-theme'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

export type AppSection = 'main' | 'threads'

interface McpServerInfo {
  name: string
  state: string
  server_url: string
  error: string | null
}

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  activeSection: AppSection
  onNavigateMain: () => void
  onNavigateThreads: () => void
  onCreateThread: () => void
  isCreating: boolean
  mcpServers: McpServerInfo[]
  mcpToolCount: number
  theme: Theme
  onThemeChange: (theme: Theme) => void
}

function SidebarHeaderContent({ onNavigateMain }: { onNavigateMain: () => void }) {
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
              <span className='truncate text-xs text-sidebar-foreground/70'>Bruh</span>
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
      <span className={cn('min-w-0 truncate text-xs', isFailed ? 'text-destructive' : 'text-sidebar-foreground/70')}>
        {server.name}
      </span>
      {isFailed ? (
        <WarningCircle className='size-3 shrink-0 text-destructive' />
      ) : null}
    </div>
  )
}

export function AppSidebar({
  activeSection,
  onNavigateMain,
  onNavigateThreads,
  onCreateThread,
  isCreating,
  mcpServers,
  mcpToolCount,
  theme,
  onThemeChange,
  ...props
}: AppSidebarProps) {
  const { state } = useSidebar()
  const collapsed = state === 'collapsed'

  const cycleTheme = () => {
    const order: Theme[] = ['system', 'light', 'dark']
    const next = order[(order.indexOf(theme) + 1) % order.length]
    onThemeChange(next)
  }

  return (
    <Sidebar collapsible='icon' {...props}>
      <SidebarHeader>
        <SidebarHeaderContent onNavigateMain={onNavigateMain} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip='Threads'
                isActive={activeSection === 'threads'}
                onClick={onNavigateThreads}
              >
                <ChatsTeardrop />
                <span>Threads</span>
              </SidebarMenuButton>
              <SidebarMenuAction
                onClick={onCreateThread}
                disabled={isCreating}
                title='New thread'
              >
                <Plus />
                <span className='sr-only'>New thread</span>
              </SidebarMenuAction>
            </SidebarMenuItem>
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
                <span className='text-[10px] text-sidebar-foreground/50'>({mcpToolCount} tools)</span>
              ) : null}
            </SidebarGroupLabel>
            <div className='flex flex-col gap-0.5'>
              {mcpServers.map((server) => (
                <McpServerItem key={server.name} server={server} />
              ))}
            </div>
          </SidebarGroup>
        ) : null}

        {!collapsed ? (
          <div className='flex items-center justify-between px-2 py-1'>
            <button
              onClick={cycleTheme}
              className='flex items-center gap-2 text-xs text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors'
            >
              {theme === 'dark' ? <Moon className='size-3.5' /> : <Sun className='size-3.5' />}
              <span className='capitalize'>{theme}</span>
            </button>
          </div>
        ) : (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip={`Theme: ${theme}`} onClick={cycleTheme}>
                {theme === 'dark' ? <Moon /> : <Sun />}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
