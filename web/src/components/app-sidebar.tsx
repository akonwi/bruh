import {
  ChatsTeardropIcon,
  ClockCounterClockwiseIcon,
  HouseIcon,
  PlusIcon,
} from '@phosphor-icons/react'

import { useEffect, useRef, useState } from 'react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
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


export type AppSection = 'main' | 'threads'

export interface SessionState {
  sessionId: string
  title?: string
  createdAt: string
  updatedAt: string
}

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  activeSection: AppSection
  activeThreadId: string | null
  onNavigateMain: () => void
  onOpenThread: (sessionId: string) => void
  onRenameThread: (sessionId: string, title: string) => Promise<void>
  onDeleteThread: (sessionId: string) => Promise<void>
  onCreateThread: () => void
  isCreating: boolean
  sessions: SessionState[]
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
            <HouseIcon weight='fill' />
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
  activeThreadId,
  onNavigateMain,
  onOpenThread,
  onRenameThread,
  onDeleteThread,
  onCreateThread,
  isCreating,
  sessions,
  ...props
}: AppSidebarProps) {
  const sortedSessions = sortSessions(sessions)
  const hasThreads = sessions.length > 0
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!editingThreadId) return
    const raf = requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
    return () => cancelAnimationFrame(raf)
  }, [editingThreadId])

  useEffect(() => {
    if (!editingThreadId) return

    const handlePointerDown = (event: PointerEvent) => {
      const input = renameInputRef.current
      if (!input) return
      if (event.target instanceof Node && !input.contains(event.target)) {
        cancelRename()
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [editingThreadId])

  const startRename = (session: SessionState) => {
    setEditingThreadId(session.sessionId)
    setEditingTitle(session.title?.trim() || '')
  }

  const cancelRename = () => {
    setEditingThreadId(null)
    setEditingTitle('')
    setIsRenaming(false)
  }

  const saveRename = async (session: SessionState) => {
    if (isRenaming) return
    const nextTitle = editingTitle.trim()
    const prevTitle = session.title?.trim() || ''
    if (!nextTitle || nextTitle === prevTitle) {
      cancelRename()
      return
    }

    setIsRenaming(true)
    try {
      await onRenameThread(session.sessionId, nextTitle)
      cancelRename()
    } catch (error) {
      console.error('Failed to rename thread:', error)
      setIsRenaming(false)
    }
  }

  const handleDeleteThread = async (session: SessionState) => {
    const confirmed = window.confirm(
      `Delete thread "${session.title?.trim() || shortId(session.sessionId)}"? This cannot be undone.`,
    )
    if (!confirmed) return

    setDeletingThreadId(session.sessionId)
    try {
      await onDeleteThread(session.sessionId)
      if (editingThreadId === session.sessionId) {
        cancelRename()
      }
    } catch (error) {
      console.error('Failed to delete thread:', error)
    } finally {
      setDeletingThreadId((current) =>
        current === session.sessionId ? null : current,
      )
    }
  }

  return (
    <Sidebar collapsible='icon' {...props}>
      <SidebarHeader>
        <SidebarHeaderContent onNavigateMain={onNavigateMain} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className='flex items-center gap-1.5'>
            <ChatsTeardropIcon className='size-3.5' />
            <span>Threads</span>
          </SidebarGroupLabel>
          <SidebarGroupAction
            onClick={onCreateThread}
            disabled={isCreating}
            title='New thread'
          >
            <PlusIcon />
            <span className='sr-only'>New thread</span>
          </SidebarGroupAction>
          <SidebarMenu>
            {hasThreads && (
              <SidebarMenuSub>
                {sortedSessions.map((session) => {
                  const isEditing = editingThreadId === session.sessionId
                  const isDeleting = deletingThreadId === session.sessionId

                  return (
                    <SidebarMenuSubItem key={session.sessionId}>
                      <ContextMenu>
                        <ContextMenuTrigger>
                          <SidebarMenuSubButton
                            isActive={activeThreadId === session.sessionId}
                            onClick={() => {
                              if (!isEditing && !isDeleting)
                                onOpenThread(session.sessionId)
                            }}
                          >
                            {isEditing ? (
                              <Input
                                ref={renameInputRef}
                                value={editingTitle}
                                onChange={(e) => setEditingTitle(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault()
                                    void saveRename(session)
                                  }
                                }}
                                onBlur={() => cancelRename()}
                                disabled={isRenaming || isDeleting}
                                className='h-6 text-xs'
                                autoFocus
                              />
                            ) : (
                              <>
                                <span className='truncate'>
                                  {session.title?.trim() || shortId(session.sessionId)}
                                </span>
                                <span className='ml-auto flex shrink-0 items-center gap-1 text-[10px] text-sidebar-foreground/50'>
                                  <ClockCounterClockwiseIcon className='size-2.5' />
                                  {formatRelativeTime(session.updatedAt)}
                                </span>
                              </>
                            )}
                          </SidebarMenuSubButton>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            onClick={() => startRename(session)}
                            disabled={isRenaming || isEditing || isDeleting}
                          >
                            Rename
                          </ContextMenuItem>
                          <ContextMenuItem
                            variant='destructive'
                            onClick={() => {
                              void handleDeleteThread(session)
                            }}
                            disabled={isRenaming || isDeleting}
                          >
                            Delete
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    </SidebarMenuSubItem>
                  )
                })}
              </SidebarMenuSub>
            )}

            <SidebarMenuItem></SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter />

      <SidebarRail />
    </Sidebar>
  )
}
