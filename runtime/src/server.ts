import { createServer as createNetServer } from 'node:net';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { PiSessionRegistry } from './pi-registry.js';

let config: Awaited<ReturnType<typeof loadConfig>>;
try {
  config = await loadConfig();
  console.error('[runtime] Config loaded');
} catch (err) {
  console.error('[runtime] Config load failed:', err);
  process.exit(1);
}

let registry: PiSessionRegistry;
try {
  registry = new PiSessionRegistry(config);
  console.error('[runtime] Registry created');
} catch (err) {
  console.error('[runtime] Registry creation failed:', err);
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  console.error('[runtime] Uncaught exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[runtime] Unhandled rejection:', reason);
});

// Check if port is in use
function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once('error', () => { s.close(); resolve(true); });
    s.once('listening', () => { s.close(); resolve(false); });
    s.listen(port);
  });
}

// Try to free the port if it's in use
async function ensurePortFree(port: number): Promise<number> {
  const inUse = await checkPort(port);
  if (!inUse) return port;

  console.error(`[runtime] Port ${port} in use — killing existing process`);
  try {
    execSync(`fuser -k ${port}/tcp 2>/dev/null || kill -9 \$(lsof -t -i:${port}) 2>/dev/null || true`);
    await new Promise(r => setTimeout(r, 3000));
  } catch {}

  const stillInUse = await checkPort(port);
  if (stillInUse) {
    console.error(`[runtime] Could not free port ${port}, will still try`);
  }
  return port;
}

const actualPort = await ensurePortFree(config.port);
writeFileSync('/tmp/runtime-port.txt', String(actualPort));
writeFileSync('/tmp/runtime-pid.txt', String(process.pid));

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
  if (!text) return c.json({ error: 'text is required' }, 400);
  await registry.enqueuePrompt(sessionId, text);
  return c.json({ ok: true, sessionId, queued: true }, 202);
});

app.post('/internal/sessions/:sessionId/steer', async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = await c.req.json<{ text?: string }>();
  const text = body.text?.trim();
  if (!text) return c.json({ error: 'text is required' }, 400);
  const result = await registry.steer(sessionId, text);
  return c.json({ ok: result.queued, sessionId, ...result }, result.queued ? 202 : 409);
});

app.post('/internal/sessions/:sessionId/follow-up', async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = await c.req.json<{ text?: string }>();
  const text = body.text?.trim();
  if (!text) return c.json({ error: 'text is required' }, 400);
  const result = await registry.followUp(sessionId, text);
  return c.json({ ok: result.queued, sessionId, ...result }, result.queued ? 202 : 409);
});

app.post('/internal/sessions/:sessionId/abort', async (c) => {
  const sessionId = c.req.param('sessionId');
  const result = await registry.abort(sessionId);
  return c.json({ ok: true, sessionId, ...result });
});

app.get('/', (c) => {
  return c.json({ ok: true, service: 'runtime', message: 'Bruh Pi runtime scaffold is up.' });
});

serve({ fetch: app.fetch, port: actualPort });
console.error(`[runtime] listening on http://localhost:${actualPort}`);
