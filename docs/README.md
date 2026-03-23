# Bruh North Star

## Goal

Build a personal AI agent platform around **Pi** that runs in a **Cloudflare sandbox/container** and is accessed through a **lightweight web UI**.

This replaces the earlier MoltWorker/OpenClaw experiment. The new direction is to use **Pi natively** via its **SDK**, keep the edge layer thin, and build only the pieces we actually want.

## Product shape

- **Personal**, single-user system
- **Pi-powered** runtime
- **Cloudflare-hosted** edge + sandbox/container runtime
- **Web-first UX** now, mobile later
- Durable object/session orchestration at the edge
- Durable memory/artifacts stored in **R2**

## Guiding principles

1. **Pi-native, not Pi-emulated**
   - Use Pi's SDK directly in the runtime service.
   - Do not remote-control Pi's TUI.
   - Do not build around someone else's bot/gateway assumptions.

2. **Thin edge, real runtime**
   - Cloudflare Worker + Durable Objects coordinate sessions, auth, and streaming.
   - The sandbox/container runtime hosts Pi and does the real agent work.

3. **Simple transport first**
   - Use **HTTP commands + SSE streaming** for v1.
   - WebSockets remain an option later if the product clearly needs richer bidirectional transport.

4. **Session isolation by default**
   - One **Durable Object per session**.
   - Multiple sessions may be active concurrently.
   - Within a session, command ordering stays serialized and predictable.

5. **Durable memory before general filesystem power**
   - First custom storage tools should be **R2-backed object tools**.
   - Keep these separate from any future local workspace file tools.

6. **Safe, composable tools**
   - Start with restricted/default-safe tool behavior.
   - Add custom Pi extensions for memory, storage, safety rails, and later local file editing.

7. **Keep the repo light**
   - Prefer a simple top-level layout:

```txt
bruh/
  edge/
  runtime/
  web/
```

## Repo layout

```txt
bruh/
  edge/     # Cloudflare Worker + Durable Objects + R2 bindings
  runtime/  # Pi SDK host running in a Cloudflare sandbox/container
  web/      # React/Vite app with shadcn + Base UI + Stone-derived theme
  docs/     # Planning docs and progress tracking
```

Notes:
- A root `package.json` workspace is fine.
- Avoid introducing extra shared packages until they are clearly needed.
- Small shared protocol types can live inline at first and be extracted later if necessary.

## Architecture

### 1) `edge/`

Responsibilities:
- authentication
- session creation and lookup
- **Durable Object per session**
- SSE stream endpoint for live agent events
- proxy/forward commands to runtime
- internal storage endpoints backed by **R2**
- optional audit/logging/rate limiting

Key design:
- `SessionDO` owns session coordination
- optional `SessionIndexDO` tracks discoverability / metadata
- edge should stay thin and orchestration-focused

### 2) `runtime/`

Responsibilities:
- host Pi via `createAgentSession()`
- manage Pi sessions and event subscriptions
- load project-local Pi extensions/skills
- execute prompts/steer/follow-up/abort commands
- call edge internal APIs for durable memory/storage

Key design:
- use **Pi SDK**, not RPC, for v1
- use project-local `.pi/extensions/` for custom tools
- inject provider API keys via runtime env and `AuthStorage.setRuntimeApiKey(...)`

### 3) `web/`

Responsibilities:
- lightweight chat UI
- show streaming assistant text
- show tool activity/status
- manage reconnect/resume UX
- session list/create/open UI

UI stack:
- **React + Vite + TypeScript**
- **Base UI**
- **shadcn**
- theme bootstrapped from:
  - `bunx shadcn create --preset buFzo92`
- then adapted to match the theme conventions from `../stone/...`

## Session model

### Durable Object per session

Each session gets its own Durable Object.

The DO is responsible for:
- ordered command intake
- streaming fanout to connected clients
- sequence numbering of outbound events
- short-term event buffering for reconnect/replay
- session metadata like title/status/last activity

### Concurrency model

- **Many sessions may be active at the same time**
- **One active agent run per session**
- Within a session, commands are serialized
- Between sessions, work can proceed independently

### Replay model

All streamed events should have:
- `sessionId`
- `seq`
- `type`
- payload

This enables reconnect and deterministic UI rebuilding.

## Transport

## v1 choice: HTTP + SSE

Commands:
- `POST /sessions`
- `GET /sessions`
- `GET /sessions/:id`
- `POST /sessions/:id/prompt`
- `POST /sessions/:id/steer`
- `POST /sessions/:id/follow-up`
- `POST /sessions/:id/abort`

Streaming:
- `GET /sessions/:id/stream`

Why SSE first:
- simpler than full-duplex WebSockets
- easier to debug
- fits the prompt/stream model well
- plays nicely with Durable Object fanout/replay

WebSockets are still a reasonable future option if product needs become more interactive.

## Memory and storage model

The first high-value custom tools should be **R2-backed memory tools**.

These are not a fake filesystem. They are a small, file-like object storage API used for:
- memory
- notes
- artifacts
- durable summaries
- persistent project records

### Initial storage tools

Expose these as Pi tools via a custom extension:
- `memory_read(path)`
- `memory_write(path, content)`
- `memory_edit(path, oldText, newText)`
- `memory_list(prefix?)`
- `memory_append(path, content)`

These should be the first non-trivial custom tools after basic chat/session plumbing.

### Why separate memory from workspace files

Keep two different concepts:
- **memory tools** → R2-backed, durable, app-defined storage
- **workspace tools** → future local file/project editing in runtime

This separation keeps safety and semantics clean.

### Suggested R2 key layout

```txt
memory/profile.md
memory/facts/user.md
memory/notes/YYYY-MM-DD.md
memory/projects/<slug>/todo.md
memory/projects/<slug>/notes.md
memory/sessions/<session-id>/summary.md
artifacts/<session-id>/...
```

### Concurrency strategy

For v1, use **optimistic concurrency**:
- read object
- capture version/etag
- write with version check
- if conflict occurs, surface it cleanly and let the agent retry

Avoid building a fake POSIX abstraction on top of R2.

## Pi integration strategy

### Use Pi SDK directly

Use:
- `createAgentSession()`
- `DefaultResourceLoader`
- project-local `.pi/extensions/`
- Pi's built-in tools selectively

### Start with restricted/default-safe tools

Start minimal. Then add power deliberately.

Likely sequence:
1. core agent prompt/stream flow
2. memory tools
3. read-only workspace tools
4. controlled bash/edit/write later

### Extensions are the customization layer

Pi extensions should be used for:
- custom memory tools
- storage helpers
- safety rails / permission policies
- future workspace/file helpers
- future integrations

## UI direction

Take architecture inspiration from Pi's `web-ui` package where useful, but build a thinner, product-specific app.

Core UI areas:
- chat transcript
- composer
- tool activity/status
- session list
- settings later

Do **not** attempt to reproduce Pi's TUI in the browser.

## Non-goals for early versions

Do not prioritize these early:
- remote Pi TUI in browser
- browser/CDP emulation
- bot/channel integrations
- pretending R2 is a full filesystem
- multi-tenant design
- heavy dashboards before core chat works

## Delivery phases

### Phase 0 — foundation
- repo scaffolding
- edge/runtime/web skeletons
- shadcn/Base UI theme bootstrap
- basic deploy path for runtime and edge

### Phase 1 — usable chat system
- session creation/listing
- `SessionDO`
- runtime Pi integration
- prompt + stream flow
- basic web chat
- durable session state/events

### Phase 2 — durable memory
- R2 internal storage API in edge
- memory extension in runtime
- read/write/edit/list/append memory tools
- profile + notes + session-summary conventions

### Phase 3 — controlled power
- restricted local workspace tools
- better safety rails
- session replay/resume polish
- project memory patterns

### Phase 4 — optional expansion
- mobile client
- richer tooling
- browser helpers
- notifications

## Current decision summary

- **Pi SDK** over RPC for v1
- **SSE** over WebSockets for v1
- **Durable Object per session**
- **R2-backed memory tools** as an early core feature
- **React + Vite + Base UI + shadcn** for web
- bootstrap theme with `bunx shadcn create --preset buFzo92`
- adapt styling/theme direction from `../stone/...`

## North-star outcome

The end result should feel like:
- a personal Pi-powered agent
- hosted on Cloudflare
- simple, durable, and safe
- with first-class memory and session continuity
- and a light UI built specifically for how we want to use it
