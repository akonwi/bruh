import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();
const port = Number(process.env.PORT || 8788);

app.get('/health', (c) => {
  return c.json({ ok: true, service: 'runtime', status: 'bootstrapped' });
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
  port,
});

console.log(`[runtime] listening on http://localhost:${port}`);
