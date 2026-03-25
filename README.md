# Bruh

Bruh is a personal AI agent platform built around **Pi** on Cloudflare.

## Goal

Build a system where:
- **Bruh** is the ongoing **main thread** at `/`
- the main thread lives in a canonical **root Cloudflare sandbox**
- ad-hoc **side threads** can be spawned for focused work
- each side thread gets its own sandboxed workspace and Pi session history
- all threads share the same durable **R2-backed memory**
- Cloudflare **Agents** later becomes the orchestration layer for schedules, workflows, browsing, MCP, and richer stateful capabilities

## Current direction

Bruh is being built in two major steps:

1. **Sandbox the Pi runtime**
   - move the current runtime into the **Cloudflare Sandbox SDK**
   - keep the existing web app and edge orchestration working while that migration happens

2. **Move orchestration to Cloudflare Agents**
   - replace the custom edge session/control plane with **Agents**
   - keep **Pi inside the sandbox** as the execution engine
   - use Agents for thread state, schedules, workflows, browsing, MCP, and other Cloudflare-native capabilities

## Product model

### Main thread
- `/` is the canonical ongoing relationship with Bruh
- the main thread maps to the canonical **root sandbox**
- the sandbox filesystem can keep the actual low-level **Pi session history** and local workspace state for main

### Side threads
- `/threads/:id` are focused branches of the same agent, not separate personas
- each thread should eventually map to its own **sandbox**
- side threads share the same durable memory and overall tool surface as main
- workspace/file/process state stays isolated per thread

### Shared durable memory
Durable memory stays in **R2**, not in the sandbox filesystem.

That includes:
- `memory/profile.md`
- `memory/notes/YYYY-MM-DD.md`
- `memory/projects/<slug>/...`
- `memory/sessions/<thread-id>/summary.md`

The summary files are the durable handoff between threads. The raw Pi session files live in each thread's sandbox.

### Main awareness of side threads
Bruh should be aware of side threads through:
- thread metadata / registry
- durable thread summaries
- shared memory

The long-term goal is for main to understand the state of side threads without needing to load every raw transcript.

## Architecture direction

### Execution layer
- **Pi SDK** runs inside Cloudflare **Sandbox**
- sandbox filesystem holds:
  - Pi session files
  - workspace files
  - temporary artifacts
  - running background processes

### Durable memory layer
- **R2** stores shared durable memory and thread summaries
- this memory is shared across main and all side threads

### Orchestration layer
- **Current:** Worker + Durable Objects + SSE
- **Later:** Cloudflare **Agents** as the control plane

When Agents is introduced, it should use the base **`Agent`** model for orchestration, not `AIChatAgent`, because Pi already owns the chat/session loop.

### UI layer
- `web/` stays a lightweight React app
- routes remain:
  - `/` → Main
  - `/threads` → thread index
  - `/threads/:id` → thread chat

## Repo layout

```txt
bruh/
  edge/     # current Worker/DO control plane and R2 APIs
  runtime/  # Pi runtime that will move into Cloudflare Sandbox
  web/      # React/Vite UI
  docs/     # planning docs and progress tracking
```

## Near-term migration order

1. **Sandbox the current runtime**
2. **Map sandbox identity to thread identity**
   - `main` → root sandbox
   - side thread → dedicated sandbox
3. **Add controlled workspace power**
4. **Replace orchestration with Cloudflare Agents**
5. **Add browsing, workflows, scheduling, MCP, and related capabilities**

## Local runtime commands

- `bun run dev:runtime` → start the sandbox-backed runtime Worker on `localhost:8788`
- `bun run dev:runtime:local` → start the old local Node runtime directly

The sandbox-backed dev flow now matches the architecture direction. The local Node mode remains available as a fallback while the migration is in progress.

## Docs

- Architecture / north star: [docs/README.md](./docs/README.md)
- Memory conventions: [docs/memory.md](./docs/memory.md)
- Progress tracker: [docs/TODO.md](./docs/TODO.md)
