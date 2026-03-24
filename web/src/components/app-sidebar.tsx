import { ChatsTeardrop, House, Plus } from '@phosphor-icons/react'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'

export type AppSection = 'main' | 'threads'

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  activeSection: AppSection
  onNavigateMain: () => void
  onNavigateThreads: () => void
  onCreateThread: () => void
  isCreating: boolean
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

export function AppSidebar({
  activeSection,
  onNavigateMain,
  onNavigateThreads,
  onCreateThread,
  isCreating,
  ...props
}: AppSidebarProps) {
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

      <SidebarRail />
    </Sidebar>
  )
}
