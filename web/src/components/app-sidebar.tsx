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


export type AppView = 'base' | 'threads'

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  activeView: AppView
  onViewChange: (view: AppView) => void
  onCreateSession: () => void
  isCreating: boolean

}

function SidebarHeaderContent({
  onViewChange,
}: {
  onViewChange: (view: AppView) => void
}) {
  const { state } = useSidebar()
  const collapsed = state === 'collapsed'

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size='lg'
          tooltip='Bruh'
          onClick={() => onViewChange('base')}
        >
          <div className='flex aspect-square size-8 items-center justify-center bg-sidebar-primary text-sidebar-primary-foreground'>
            <House weight='fill' />
          </div>
          {!collapsed ? (
            <div className='grid flex-1 text-left text-sm leading-tight'>
              <span className='truncate font-semibold'>Bruh</span>
            </div>
          ) : null}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

export function AppSidebar({
  activeView,
  onViewChange,
  onCreateSession,
  isCreating,
  ...props
}: AppSidebarProps) {
  return (
    <Sidebar collapsible='icon' {...props}>
      <SidebarHeader>
        <SidebarHeaderContent onViewChange={onViewChange} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip='Threads'
                isActive={activeView === 'threads'}
                onClick={() => onViewChange('threads')}
              >
                <ChatsTeardrop />
                <span>Threads</span>
              </SidebarMenuButton>
              <SidebarMenuAction
                onClick={onCreateSession}
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
