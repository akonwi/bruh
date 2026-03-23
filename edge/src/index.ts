import { Hono } from 'hono';

const app = new Hono();

app.get('/health', (c) => {
  return c.json({ ok: true, service: 'edge', status: 'bootstrapped' });
});

app.get('/', (c) => {
  return c.json({
    ok: true,
    service: 'edge',
    message: 'Bruh edge worker scaffold is up.',
  });
});

export default app;
