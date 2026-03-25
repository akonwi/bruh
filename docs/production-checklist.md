# Production Checklist

## Architecture for production

```
┌─────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│  web/   │────▶│  edge/ (Worker)       │────▶│  runtime/ (Sandbox) │
│  static │     │  BruhAgent (DO)       │     │  Pi SDK in container│
│  site   │     │  R2 memory bucket     │     │                     │
└─────────┘     └──────────────────────┘     └─────────────────────┘
```

In the first production deploy, runtime stays as a standalone Node process (not sandboxed) until Docker/container infra is sorted. The edge Worker + BruhAgent deploys directly.

---

## Pre-deploy: Cloudflare resources

### R2 bucket
- [ ] Create the production R2 bucket:
  ```bash
  npx wrangler r2 bucket create bruh-memory
  ```

### Domain (optional but recommended)
- [ ] Decide on a domain for the edge Worker (e.g., `bruh.yourdomain.com`)
- [ ] Add DNS record and Worker route if using a custom domain
- [ ] If using MCP OAuth, a real domain is required for callbacks

---

## Edge deployment (`edge/`)

### Secrets
Set these via `wrangler secret put` from the `edge/` directory:

- [ ] `INTERNAL_API_SECRET` — shared secret between edge and runtime
  ```bash
  cd edge && npx wrangler secret put INTERNAL_API_SECRET
  ```
- [ ] `RUNTIME_BASE_URL` — URL where the runtime is reachable
  ```bash
  cd edge && npx wrangler secret put RUNTIME_BASE_URL
  ```

### Optional secrets (MCP)
- [ ] `MCP_SERVERS` — JSON array of pre-configured MCP servers (when ready)
- [ ] Any `authEnvVar` tokens referenced by MCP_SERVERS configs

### Wrangler config review
- [ ] Verify `edge/wrangler.jsonc` has correct:
  - [ ] `name` (Worker name)
  - [ ] `compatibility_date`
  - [ ] `r2_buckets` bucket name matches the created bucket
  - [ ] `migrations` include all three tags (v1, v2, v3)

### Deploy
```bash
cd edge && npx wrangler deploy
```

### Verify
```bash
curl https://your-edge-domain/health
# Should return { "ok": true, "service": "edge", "status": "bootstrapped" }
```

---

## Runtime deployment (`runtime/`)

### Option A: Standalone Node process (simplest first deploy)

Run the runtime as a regular Node service somewhere reachable by the edge Worker.

#### Build
```bash
cd runtime && bun run build
```

#### Environment variables
- [ ] `ANTHROPIC_API_KEY` — required
- [ ] `ANTHROPIC_MODEL` — optional, defaults to `claude-opus-4-6`
- [ ] `EDGE_BASE_URL` — URL of the deployed edge Worker (e.g., `https://bruh.yourdomain.com`)
- [ ] `INTERNAL_API_SECRET` — must match the edge secret
- [ ] `PORT` — defaults to `8788`

#### Start
```bash
cd runtime && node dist/server.js
```

### Option B: Cloudflare Sandbox (later)

Requires Docker for the container build.

```bash
cd runtime && DOCKER_API_VERSION=1.43 npx wrangler deploy --config wrangler.jsonc
```

#### Sandbox-specific secrets
Set from `runtime/` directory:
- [ ] `ANTHROPIC_API_KEY`
- [ ] `EDGE_BASE_URL`
- [ ] `INTERNAL_API_SECRET`

---

## Web deployment (`web/`)

### Build
```bash
cd web && bun run build
```

This outputs static files to `web/dist/`.

### API configuration
The web app needs to know where the edge and runtime APIs are.

For production (non-dev), the app uses:
- `VITE_API_BASE` — edge API base URL
- `VITE_RUNTIME_API_BASE` — runtime API base URL (if runtime is separate from edge)

Set these at build time:
```bash
VITE_API_BASE=https://bruh.yourdomain.com \
VITE_RUNTIME_API_BASE=https://bruh.yourdomain.com \
bun run build:web
```

If both edge and runtime are behind the same domain (e.g., edge proxies to runtime), you can set both to the same URL.

### Deploy
Deploy `web/dist/` to any static hosting:
- Cloudflare Pages
- Vercel
- Netlify
- S3 + CloudFront
- Or serve from the edge Worker itself

### SPA routing
If deploying to Cloudflare Pages or similar, add a `_redirects` or routing rule so all paths serve `index.html` (SPA fallback):
```
/*  /index.html  200
```

---

## Post-deploy verification

### Edge
- [ ] `GET /health` returns OK
- [ ] `GET /main-session` returns session metadata
- [ ] `POST /sessions` creates a new thread

### Runtime
- [ ] `GET /health` returns OK (from runtime URL)
- [ ] Runtime can reach edge at `EDGE_BASE_URL`

### End-to-end
- [ ] Open web app
- [ ] Main thread loads at `/`
- [ ] Send a prompt — assistant responds
- [ ] Memory tools work (test `memory_list`)
- [ ] Workspace tools work (test `workspace_list`)
- [ ] Create a side thread — verify it appears in sidebar
- [ ] Thread summary gets written after a completed run
- [ ] Steer and follow-up work during active runs
- [ ] Abort works
- [ ] Reconnect/replay works (refresh the page mid-conversation)
- [ ] Schedule a task — verify it fires

### MCP (once on a real domain)
- [ ] `mcp_connect` to an OAuth server returns an auth URL
- [ ] Complete OAuth flow in browser
- [ ] `mcp_tools` shows discovered tools
- [ ] `mcp_call` invokes a tool successfully

---

## Security considerations

- [ ] Set `INTERNAL_API_SECRET` to a strong random value
- [ ] Add single-user auth on the edge Worker (e.g., Cloudflare Access, basic auth middleware, or a simple bearer token check on public routes)
- [ ] Ensure the runtime is not publicly accessible — only the edge should reach it
- [ ] Do not expose `ANTHROPIC_API_KEY` to the web app
- [ ] Review CORS settings before production (currently `origin: '*'`)

---

## Production topology decision

### Simplest: edge + runtime on same machine
- Deploy edge Worker to Cloudflare
- Run runtime as a Node process on a VPS/container
- Edge calls runtime via `RUNTIME_BASE_URL`
- Web served from Pages or the same edge Worker

### Later: edge + sandboxed runtime
- Edge Worker on Cloudflare
- Runtime Worker with Sandbox containers on Cloudflare
- Each thread gets its own sandbox
- More powerful but needs Docker build pipeline

---

## Rollback plan

If something breaks:
- Edge: `npx wrangler rollback` from `edge/`
- Runtime: restart the previous version of `node dist/server.js`
- Web: redeploy the previous `dist/` build
- R2 data is persistent and not affected by Worker rollbacks
- BruhAgent SQL state persists across deploys (event history, thread registry)
