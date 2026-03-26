import { getAgentByName, routeAgentRequest } from 'agents'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { BruhAgent } from './bruh-agent'

export { Sandbox } from '@cloudflare/sandbox'

import type { Env, SessionIndexEntry, SessionMetadata } from './session'
import {
  buildStorageListPayload,
  normalizeStoragePath,
  normalizeStoragePrefix,
  toStorageObjectPayload,
} from './storage'

const app = new Hono<{ Bindings: Env }>()
const MAIN_SESSION_ID = 'main'
const REGISTRY_AGENT_NAME = '__registry__'

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Last-Event-ID', 'X-Bruh-Internal-Secret'],
  }),
)

app.use('/internal/*', async (c, next) => {
  const configuredSecret = c.env.INTERNAL_API_SECRET?.trim()
  if (!configuredSecret) {
    await next()
    return
  }

  const providedSecret = c.req.header('x-bruh-internal-secret')?.trim()
  if (providedSecret !== configuredSecret) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  await next()
})

app.get('/health', (c) => {
  return c.json({ ok: true, service: 'edge', status: 'bootstrapped' })
})

// --- Session management ---

app.post('/sessions', async (c) => {
  const sessionId = crypto.randomUUID()
  const session = await initSession(c.env, sessionId)
  await registerThread(c.env, session)
  return c.json(session)
})

app.get('/main-session', async (c) => {
  const session = await initSession(c.env, MAIN_SESSION_ID, 'Main')
  return c.json(session)
})

app.get('/sessions', async (c) => {
  const registryStub = await getAgentByName(
    c.env.BRUH_AGENT,
    REGISTRY_AGENT_NAME,
  )
  const response = await registryStub.fetch(
    new Request('https://agent/threads'),
  )
  if (!response.ok) return response

  const { sessions: entries } = (await response.json()) as {
    sessions: SessionIndexEntry[]
  }
  const sessions = (
    await Promise.all(
      entries
        .filter(({ sessionId }) => sessionId !== MAIN_SESSION_ID)
        .map(async ({ sessionId }) => {
          const stub = await getAgentByName(c.env.BRUH_AGENT, sessionId)
          const stateResponse = await stub.fetch(
            new Request('https://agent/state'),
          )
          if (!stateResponse.ok) return null
          return (await stateResponse.json()) as SessionMetadata
        }),
    )
  )
    .filter((session): session is SessionMetadata => session !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return c.json({ sessions })
})

app.get('/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const session = await initSession(c.env, sessionId)
  await registerThread(c.env, session)
  return c.json(session)
})

app.patch('/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  if (sessionId === MAIN_SESSION_ID) {
    return c.json({ error: 'main session cannot be renamed' }, 400)
  }

  const body = (await c.req.json().catch(() => ({}))) as { title?: string }
  const title = body.title?.trim()
  if (!title) {
    return c.json({ error: 'title is required' }, 400)
  }

  const stub = await getAgentByName(c.env.BRUH_AGENT, sessionId)
  return stub.fetch(
    new Request('https://agent/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  )
})

app.post('/sessions/:sessionId/refresh-context', async (c) => {
  const sessionId = c.req.param('sessionId')
  const stub = await getAgentByName(c.env.BRUH_AGENT, sessionId)
  return stub.fetch(
    new Request('https://agent/refresh-context', {
      method: 'POST',
    }),
  )
})

// --- SSE streaming (legacy event system for current web app) ---

app.get('/sessions/:sessionId/events', async (c) => {
  const sessionId = c.req.param('sessionId')
  const after = c.req.query('after')
  const targetUrl = new URL('https://agent/events')
  if (after) targetUrl.searchParams.set('after', after)
  const stub = await getAgentByName(c.env.BRUH_AGENT, sessionId)
  return stub.fetch(targetUrl.toString(), { method: 'GET' })
})

app.get('/sessions/:sessionId/stream', async (c) => {
  const sessionId = c.req.param('sessionId')
  const after = c.req.query('after')
  const targetUrl = new URL('https://agent/stream')
  if (after) targetUrl.searchParams.set('after', after)
  const request = new Request(targetUrl.toString(), {
    method: 'GET',
    headers: c.req.raw.headers,
  })
  const stub = await getAgentByName(c.env.BRUH_AGENT, sessionId)
  return stub.fetch(request)
})

// --- Prompt / steer / follow-up / abort (now handled directly by AIChatAgent) ---

app.post('/sessions/:sessionId/prompt', async (c) => {
  const sessionId = c.req.param('sessionId')
  const body = await c.req.text()
  const stub = await getAgentByName(c.env.BRUH_AGENT, sessionId)
  return stub.fetch(
    new Request('https://agent/prompt', {
      method: 'POST',
      headers: {
        'Content-Type': c.req.header('content-type') ?? 'application/json',
      },
      body,
    }),
  )
})

app.post('/sessions/:sessionId/steer', async (c) => {
  const sessionId = c.req.param('sessionId')
  const body = await c.req.text()
  const stub = await getAgentByName(c.env.BRUH_AGENT, sessionId)
  return stub.fetch(
    new Request('https://agent/steer', {
      method: 'POST',
      headers: {
        'Content-Type': c.req.header('content-type') ?? 'application/json',
      },
      body,
    }),
  )
})

app.post('/sessions/:sessionId/follow-up', async (c) => {
  const sessionId = c.req.param('sessionId')
  const body = await c.req.text()
  const stub = await getAgentByName(c.env.BRUH_AGENT, sessionId)
  return stub.fetch(
    new Request('https://agent/follow-up', {
      method: 'POST',
      headers: {
        'Content-Type': c.req.header('content-type') ?? 'application/json',
      },
      body,
    }),
  )
})

app.post('/sessions/:sessionId/abort', async (c) => {
  const sessionId = c.req.param('sessionId')
  const stub = await getAgentByName(c.env.BRUH_AGENT, sessionId)
  return stub.fetch(new Request('https://agent/abort', { method: 'POST' }))
})

// --- R2 storage routes ---

app.get('/internal/storage/object', async (c) => {
  try {
    const path = normalizeStoragePath(c.req.query('path') ?? '')
    const object = await c.env.MEMORY_BUCKET.get(path)
    if (!object) return c.json({ error: 'not_found', path }, 404)
    const content = await object.text()
    return c.json(toStorageObjectPayload(object, content))
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Invalid storage path',
      },
      400,
    )
  }
})

app.put('/internal/storage/object', async (c) => {
  try {
    const path = normalizeStoragePath(c.req.query('path') ?? '')
    const body = (await c.req.json().catch(() => ({}))) as {
      content?: string
      contentType?: string
      ifMatch?: string
    }

    if (typeof body.content !== 'string') {
      return c.json({ error: 'content must be a string' }, 400)
    }

    const result = await c.env.MEMORY_BUCKET.put(path, body.content, {
      httpMetadata: {
        contentType: body.contentType?.trim() || 'text/plain; charset=utf-8',
      },
      onlyIf: body.ifMatch ? { etagMatches: body.ifMatch } : undefined,
    })

    if (!result) return c.json({ error: 'precondition_failed', path }, 409)

    return c.json({
      ok: true,
      path,
      etag: result.etag,
      version: result.version,
      size: result.size,
      uploadedAt: result.uploaded.toISOString(),
    })
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Invalid write request',
      },
      400,
    )
  }
})

app.get('/internal/storage/list', async (c) => {
  try {
    const prefix = normalizeStoragePrefix(c.req.query('prefix'))
    const limit = Number(c.req.query('limit') ?? '100')
    const cursor = c.req.query('cursor') ?? undefined
    const recursive = c.req.query('recursive') === '1'

    const result = await c.env.MEMORY_BUCKET.list({
      prefix,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 100,
      cursor,
      delimiter: recursive ? undefined : '/',
    })

    return c.json(buildStorageListPayload(prefix, result))
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Invalid list request',
      },
      400,
    )
  }
})

app.get('/api-info', (c) => {
  return c.json({
    ok: true,
    service: 'edge',
    message: 'Bruh edge worker with Agents.',
  })
})

// --- Agent helpers ---

async function initSession(
  env: Env,
  sessionId: string,
  title?: string,
): Promise<SessionMetadata> {
  const stub = await getAgentByName(env.BRUH_AGENT, sessionId)
  const response = await stub.fetch(
    new Request('https://agent/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, title }),
    }),
  )

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Failed to initialize session: ${response.status} ${body}`.trim(),
    )
  }

  return (await response.json()) as SessionMetadata
}

async function registerThread(
  env: Env,
  session: SessionMetadata,
): Promise<void> {
  if (session.sessionId === MAIN_SESSION_ID) return

  const registryStub = await getAgentByName(env.BRUH_AGENT, REGISTRY_AGENT_NAME)
  const response = await registryStub.fetch(
    new Request('https://agent/register-thread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        createdAt: session.createdAt,
      }),
    }),
  )

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Failed to register thread: ${response.status} ${body}`.trim(),
    )
  }
}

export { BruhAgent }
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const agentResponse = await routeAgentRequest(request, env)
    if (agentResponse) return agentResponse

    const honoResponse = await app.fetch(request, env, ctx)
    if (honoResponse.status !== 404) return honoResponse

    return env.ASSETS ? env.ASSETS.fetch(request) : honoResponse
  },
}
