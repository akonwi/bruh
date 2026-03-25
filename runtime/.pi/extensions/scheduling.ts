import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'

interface ScheduleResponse {
  ok: boolean
  scheduleId: string
  message: string
  type: string
}

interface ScheduleItem {
  id: string
  type: string
  callback: string
  payload: unknown
  scheduledAt?: string
}

const SCHEDULE_TOOL_GUIDELINES = [
  'Use scheduling tools to set reminders or timed tasks that fire in the current thread.',
  'Scheduled tasks appear as events in the thread transcript when they fire.',
  'Use schedule_set to create a reminder. Use schedule_list to see pending schedules. Use schedule_cancel to remove one.',
]

function getEdgeBaseUrl(): string {
  return (process.env.EDGE_BASE_URL?.trim() || 'http://localhost:8790').replace(/\/+$/, '')
}

function getInternalSecret(): string | undefined {
  return process.env.INTERNAL_API_SECRET?.trim() || undefined
}

function createHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  const secret = getInternalSecret()
  if (secret) {
    headers['X-Bruh-Internal-Secret'] = secret
  }

  return headers
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

function formatScheduleList(schedules: ScheduleItem[]): string {
  if (schedules.length === 0) {
    return 'No pending scheduled tasks.'
  }

  const lines = [`${schedules.length} pending schedule${schedules.length === 1 ? '' : 's'}:`]
  for (const s of schedules) {
    const when = s.scheduledAt ? new Date(s.scheduledAt).toLocaleString() : s.type
    const message = typeof s.payload === 'string' ? s.payload : JSON.stringify(s.payload)
    lines.push(`- [${s.id}] ${message} — ${when}`)
  }

  return lines.join('\n')
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'schedule_set',
    label: 'Schedule Reminder',
    description:
      'Schedule a reminder or task in the current thread. When it fires, it appears as an event in the thread transcript.',
    promptGuidelines: SCHEDULE_TOOL_GUIDELINES,
    parameters: Type.Object({
      message: Type.String({ description: 'What to remind about or what task to note' }),
      delayMinutes: Type.Optional(
        Type.Number({ description: 'Minutes from now to fire. Use this OR scheduledAt.' }),
      ),
      scheduledAt: Type.Optional(
        Type.String({
          description: 'ISO 8601 timestamp for when to fire. Use this OR delayMinutes.',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { message, delayMinutes, scheduledAt } = params as {
        message: string
        delayMinutes?: number
        scheduledAt?: string
      }

      const trimmedMessage = message.trim()
      if (!trimmedMessage) {
        throw new Error('message is required')
      }

      const sessionId = ctx.cwd.split('/').pop() || 'main'

      const body: Record<string, unknown> = { message: trimmedMessage }
      if (scheduledAt) {
        body.scheduledAt = scheduledAt
      } else if (delayMinutes && delayMinutes > 0) {
        body.delaySeconds = Math.round(delayMinutes * 60)
      } else {
        throw new Error('Either delayMinutes or scheduledAt is required')
      }

      const response = await fetch(
        `${getEdgeBaseUrl()}/internal/sessions/${encodeURIComponent(sessionId)}/schedule`,
        {
          method: 'POST',
          headers: createHeaders(),
          body: JSON.stringify(body),
        },
      )

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        throw new Error(`Failed to schedule: ${response.status} ${errorBody}`)
      }

      const result = (await response.json()) as ScheduleResponse
      const whenText = scheduledAt
        ? `at ${new Date(scheduledAt).toLocaleString()}`
        : `in ${formatDuration(Math.round((delayMinutes ?? 0) * 60))}`

      return {
        content: [
          {
            type: 'text',
            text: `Scheduled: "${trimmedMessage}" ${whenText} (id: ${result.scheduleId})`,
          },
        ],
        details: {
          scheduleId: result.scheduleId,
          message: trimmedMessage,
        },
      }
    },
  })

  pi.registerTool({
    name: 'schedule_list',
    label: 'List Schedules',
    description: 'List all pending scheduled tasks in the current thread.',
    promptGuidelines: SCHEDULE_TOOL_GUIDELINES,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.cwd.split('/').pop() || 'main'

      const response = await fetch(
        `${getEdgeBaseUrl()}/internal/sessions/${encodeURIComponent(sessionId)}/schedules`,
        { headers: createHeaders() },
      )

      if (!response.ok) {
        throw new Error(`Failed to list schedules: ${response.status}`)
      }

      const data = (await response.json()) as { schedules: ScheduleItem[] }

      return {
        content: [{ type: 'text', text: formatScheduleList(data.schedules) }],
        details: {
          count: data.schedules.length,
          schedules: data.schedules,
        },
      }
    },
  })

  pi.registerTool({
    name: 'schedule_cancel',
    label: 'Cancel Schedule',
    description: 'Cancel a pending scheduled task by its ID.',
    promptGuidelines: SCHEDULE_TOOL_GUIDELINES,
    parameters: Type.Object({
      scheduleId: Type.String({ description: 'ID of the schedule to cancel' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { scheduleId } = params as { scheduleId: string }
      const trimmed = scheduleId.trim()
      if (!trimmed) {
        throw new Error('scheduleId is required')
      }

      const sessionId = ctx.cwd.split('/').pop() || 'main'

      const response = await fetch(
        `${getEdgeBaseUrl()}/internal/sessions/${encodeURIComponent(sessionId)}/cancel-schedule`,
        {
          method: 'POST',
          headers: createHeaders(),
          body: JSON.stringify({ scheduleId: trimmed }),
        },
      )

      if (!response.ok) {
        throw new Error(`Failed to cancel schedule: ${response.status}`)
      }

      const result = (await response.json()) as { ok: boolean; cancelled: boolean }

      return {
        content: [
          {
            type: 'text',
            text: result.cancelled
              ? `Cancelled schedule ${trimmed}.`
              : `Schedule ${trimmed} not found or already fired.`,
          },
        ],
        details: { scheduleId: trimmed, cancelled: result.cancelled },
      }
    },
  })
}
