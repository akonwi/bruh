# Bruh TODO

Concrete implementation tracker for the Pi-on-Cloudflare rebuild.

## Status legend

- [ ] not started
- [~] in progress / partially done
- [x] done

---

## 0. Planning + repo direction

- [x] Decide to pivot away from MoltWorker/OpenClaw
- [x] Choose repo layout:
  - `edge/`
  - `runtime/`
  - `web/`
- [x] Write north-star architecture doc in `docs/README.md`
- [ ] Decide what to do with legacy `server/` code
  - options: archive, keep temporarily, or delete later
- [x] Update root README to reflect the new direction

---

## 1. Root workspace setup

- [ ] Create root `package.json` workspace covering `edge`, `runtime`, and `web`
- [ ] Add shared root scripts for install/dev/build/typecheck
- [ ] Add root `.gitignore` cleanup for new apps
- [ ] Add root README links to `docs/README.md` and this TODO

---

## 2. Web app scaffold (`web/`)

- [ ] Create `web/` app with Vite + React + TypeScript
- [ ] Bootstrap shadcn with:
  - `bunx shadcn create --preset buFzo92`
- [ ] Add Base UI
- [ ] Add Tailwind v4 setup
- [ ] Port/adapt theme conventions from `../stone/...`
  - [ ] colors/tokens
  - [ ] typography
  - [ ] radius/border conventions
  - [ ] dark mode provider
  - [ ] `cn()` utility
- [ ] Create app shell
- [ ] Create chat page skeleton
- [ ] Create empty session list UI
- [ ] Add transport layer for session HTTP + SSE
- [ ] Add reconnect/resume behavior for SSE stream

---

## 3. Edge scaffold (`edge/`)

- [ ] Create Cloudflare Worker app
- [ ] Add Wrangler config
- [ ] Add bindings:
  - [ ] Durable Objects
  - [ ] R2 bucket
- [ ] Add auth middleware placeholder for single-user access
- [ ] Add health endpoint
- [ ] Add internal runtime auth mechanism (shared secret)

---

## 4. Session Durable Objects

- [ ] Create `SessionDO`
- [ ] Define session metadata model
- [ ] Define outbound event envelope with `sessionId` + `seq`
- [ ] Add event buffering/replay in `SessionDO`
- [ ] Add SSE stream endpoint: `GET /sessions/:id/stream`
- [ ] Add command intake endpoints routed through DO:
  - [ ] `POST /sessions`
  - [ ] `GET /sessions`
  - [ ] `GET /sessions/:id`
  - [ ] `POST /sessions/:id/prompt`
  - [ ] `POST /sessions/:id/steer`
  - [ ] `POST /sessions/:id/follow-up`
  - [ ] `POST /sessions/:id/abort`
- [ ] Decide whether we need a `SessionIndexDO` immediately or later

---

## 5. Runtime scaffold (`runtime/`)

- [ ] Create Node runtime app
- [ ] Add Dockerfile suitable for Cloudflare sandbox/container
- [ ] Add Hono/Fastify server
- [ ] Add health endpoint
- [ ] Add internal endpoints for edge-to-runtime calls
- [ ] Add runtime config loader
- [ ] Decide runtime filesystem layout
  - [ ] working directory
  - [ ] Pi agent dir
  - [ ] temp/data dirs

---

## 6. Pi SDK integration

- [ ] Install `@mariozechner/pi-coding-agent`
- [ ] Build Pi session factory around `createAgentSession()`
- [ ] Configure runtime API keys with `AuthStorage.setRuntimeApiKey(...)`
- [ ] Add `DefaultResourceLoader`
- [ ] Add project-local `.pi/` layout in `runtime/`
  - [ ] `.pi/extensions/`
  - [ ] `.pi/skills/`
  - [ ] `.pi/AGENTS.md`
- [ ] Start with restricted/baseline tool set
- [ ] Subscribe to Pi session events and normalize them for edge streaming
- [ ] Support runtime commands:
  - [ ] prompt
  - [ ] steer
  - [ ] follow-up
  - [ ] abort

---

## 7. End-to-end session flow

- [ ] Create session in edge
- [ ] Start/reuse runtime Pi session from edge command flow
- [ ] Forward runtime events back to `SessionDO`
- [ ] Stream events to web via SSE
- [ ] Render streaming assistant text in UI
- [ ] Render tool activity in UI
- [ ] Handle reconnect with sequence replay

---

## 8. Durable memory / R2 storage

### 8.1 Edge internal storage API
- [ ] Add internal storage auth between runtime and edge
- [ ] Add `GET /internal/storage/object?path=...`
- [ ] Add `PUT /internal/storage/object?path=...`
- [ ] Add `GET /internal/storage/list?prefix=...`
- [ ] Add `POST /internal/storage/edit`
- [ ] Add optimistic concurrency/version checks
- [ ] Define storage error format for conflicts/not found/etc.

### 8.2 Runtime Pi extension for memory
- [ ] Create `runtime/.pi/extensions/memory.ts`
- [ ] Add tool: `memory_read(path)`
- [ ] Add tool: `memory_write(path, content)`
- [ ] Add tool: `memory_edit(path, oldText, newText)`
- [ ] Add tool: `memory_list(prefix?)`
- [ ] Add tool: `memory_append(path, content)`
- [ ] Add clear tool descriptions/guidelines so the model uses them well

### 8.3 Initial memory conventions
- [ ] Define `memory/profile.md`
- [ ] Define `memory/notes/YYYY-MM-DD.md`
- [ ] Define `memory/projects/<slug>/...`
- [ ] Define `memory/sessions/<session-id>/summary.md`
- [ ] Add a simple skill/instructions for when to store durable memory

---

## 9. Basic product UX

- [ ] New session flow in UI
- [ ] Transcript rendering
- [ ] Composer with prompt submit
- [ ] Abort button
- [ ] Session status indicator
- [ ] Session list view
- [ ] Open existing session
- [ ] Empty state / first-run state
- [ ] Error banners for runtime/stream/storage failures

---

## 10. Deployment

- [ ] Deploy `edge/` Worker
- [ ] Deploy `runtime/` in Cloudflare sandbox/container
- [ ] Configure runtime wake/proxy path from edge
- [ ] Configure env vars and secrets
- [ ] Verify SSE works through edge in production
- [ ] Verify multiple sessions can be active concurrently

---

## 11. Validation checklist

- [ ] Create a session from web
- [ ] Send a prompt and receive streaming output
- [ ] Abort an in-flight run
- [ ] Reconnect and recover stream state
- [ ] Run `memory_write`
- [ ] Run `memory_read`
- [ ] Run `memory_edit`
- [ ] Run `memory_append`
- [ ] Run two separate sessions concurrently
- [ ] Confirm one session does not corrupt another's ordering

---

## 12. Later / not now

- [ ] Controlled local workspace file tools
- [ ] Restricted bash/edit/write beyond memory tools
- [ ] Mobile client
- [ ] Browser helpers
- [ ] Notifications
- [ ] Rich dashboards
- [ ] Evaluate WebSockets later if SSE becomes limiting
