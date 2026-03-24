import { cors } from 'hono/cors';
import { Hono } from 'hono';
import { SessionDO } from './session-do';
import type { Env } from './session';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Last-Event-ID'],
}));

app.get('/health', (c) => {
  return c.json({ ok: true, service: 'edge', status: 'bootstrapped' });
});

app.post('/sessions', async (c) => {
  const sessionId = crypto.randomUUID();
  const stub = getSessionStub(c.env, sessionId);
  return stub.fetch('https://session/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
});

app.get('/sessions/:sessionId', async (c) => {
  const stub = getSessionStub(c.env, c.req.param('sessionId'));
  return stub.fetch('https://session/state');
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

export { SessionDO };
export default app;
