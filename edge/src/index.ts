import { cors } from 'hono/cors';
import { Hono } from 'hono';
import { SessionIndexDO } from './session-index-do';
import { SessionDO } from './session-do';
import type { Env, SessionIndexEntry, SessionMetadata } from './session';

const app = new Hono<{ Bindings: Env }>();
const MAIN_SESSION_ID = 'main';

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Last-Event-ID'],
}));

app.get('/health', (c) => {
  return c.json({ ok: true, service: 'edge', status: 'bootstrapped' });
});

app.post('/sessions', async (c) => {
  const session = await initSession(c.env, crypto.randomUUID());
  await registerSession(c.env, session);
  return c.json(session);
});

app.get('/main-session', async (c) => {
  const session = await initSession(c.env, MAIN_SESSION_ID, 'Main');
  return c.json(session);
});

app.get('/sessions', async (c) => {
  const response = await getSessionIndexStub(c.env).fetch('https://session-index/sessions');
  if (!response.ok) {
    return response;
  }

  const { sessions: entries } = (await response.json()) as { sessions: SessionIndexEntry[] };
  const sessions = (
    await Promise.all(
      entries
        .filter(({ sessionId }) => sessionId !== MAIN_SESSION_ID)
        .map(async ({ sessionId }) => {
        const sessionResponse = await getSessionStub(c.env, sessionId).fetch('https://session/state');
        if (!sessionResponse.ok) {
          return null;
        }
        return (await sessionResponse.json()) as SessionMetadata;
      }),
    )
  )
    .filter((session): session is SessionMetadata => session !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return c.json({ sessions });
});

app.get('/sessions/:sessionId', async (c) => {
  const session = await initSession(c.env, c.req.param('sessionId'));
  await registerSession(c.env, session);
  return c.json(session);
});

app.get('/sessions/:sessionId/events', async (c) => {
  const sessionId = c.req.param('sessionId');
  const after = c.req.query('after');
  const targetUrl = new URL('https://session/events');
  if (after) targetUrl.searchParams.set('after', after);

  return getSessionStub(c.env, sessionId).fetch(targetUrl.toString(), { method: 'GET' });
});

app.get('/sessions/:sessionId/stream', async (c) => {
  const sessionId = c.req.param('sessionId');
  const after = c.req.query('after');
  const targetUrl = new URL('https://session/stream');
  if (after) targetUrl.searchParams.set('after', after);

  const request = new Request(targetUrl.toString(), {
    method: 'GET',
    headers: c.req.raw.headers,
  });

  return getSessionStub(c.env, sessionId).fetch(request);
});

app.post('/sessions/:sessionId/prompt', async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = await c.req.text();

  return getSessionStub(c.env, sessionId).fetch('https://session/prompt', {
    method: 'POST',
    headers: { 'Content-Type': c.req.header('content-type') ?? 'application/json' },
    body,
  });
});

app.post('/sessions/:sessionId/abort', async (c) => {
  const sessionId = c.req.param('sessionId');
  return getSessionStub(c.env, sessionId).fetch('https://session/abort', {
    method: 'POST',
  });
});

app.post('/internal/sessions/:sessionId/events', async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = await c.req.text();

  return getSessionStub(c.env, sessionId).fetch('https://session/events', {
    method: 'POST',
    headers: { 'Content-Type': c.req.header('content-type') ?? 'application/json' },
    body,
  });
});

app.get('/', (c) => {
  return c.json({
    ok: true,
    service: 'edge',
    message: 'Bruh edge worker scaffold is up.',
    routes: {
      createSession: 'POST /sessions',
      getMainSession: 'GET /main-session',
      listSessions: 'GET /sessions',
      getSession: 'GET /sessions/:sessionId',
      streamSession: 'GET /sessions/:sessionId/stream',
      promptSession: 'POST /sessions/:sessionId/prompt',
      abortSession: 'POST /sessions/:sessionId/abort',
      ingestEvents: 'POST /internal/sessions/:sessionId/events',
    },
  });
});

function getSessionStub(env: Env, sessionId: string): DurableObjectStub {
  const id = env.SESSION_DO.idFromName(sessionId);
  return env.SESSION_DO.get(id);
}

async function initSession(env: Env, sessionId: string, title?: string): Promise<SessionMetadata> {
  const response = await getSessionStub(env, sessionId).fetch('https://session/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, title }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to initialize session: ${response.status} ${body}`.trim());
  }

  return (await response.json()) as SessionMetadata;
}

function getSessionIndexStub(env: Env): DurableObjectStub {
  const id = env.SESSION_INDEX_DO.idFromName('sessions');
  return env.SESSION_INDEX_DO.get(id);
}

async function registerSession(env: Env, session: SessionMetadata): Promise<void> {
  if (session.sessionId === MAIN_SESSION_ID) {
    return;
  }

  const response = await getSessionIndexStub(env).fetch('https://session-index/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.sessionId,
      createdAt: session.createdAt,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to register session index entry: ${response.status} ${body}`.trim());
  }
}

export { SessionDO, SessionIndexDO };
export default app;
