import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { PiSessionRegistry } from './pi-registry.js';

const config = await loadConfig();
const registry = new PiSessionRegistry(config);
const app = new Hono();

app.get('/health', (c) => {
  return c.json({
    ok: true,
    service: 'runtime',
    status: 'bootstrapped',
    hasAnthropicKey: true,
  });
});

app.post('/internal/sessions/:sessionId/prompt', async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = await c.req.json<{ text?: string }>();
  const text = body.text?.trim();

  if (!text) {
    return c.json({ error: 'text is required' }, 400);
  }

  await registry.enqueuePrompt(sessionId, text);
  return c.json({ ok: true, sessionId, queued: true }, 202);
});

app.get('/', (c) => {
  return c.json({
    ok: true,
    service: 'runtime',
    message: 'Bruh Pi runtime scaffold is up.',
  });
});

serve({
  fetch: app.fetch,
  port: config.port,
});

console.log(`[runtime] listening on http://localhost:${config.port}`);
