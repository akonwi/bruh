# Bruh North Star

## Goal

Build a personal AI agent platform around **Pi** on Cloudflare that feels like:
- one ongoing relationship with **Bruh** in the **main thread**
- focused side threads for ad-hoc projects and parallel work
- shared durable memory across all threads
- sandboxed workspaces for real execution power
- Cloudflare-native orchestration for future capabilities like schedules, workflows, browsing, and MCP

The immediate next step is to move the Pi runtime into the **Cloudflare Sandbox SDK**. After that, the long-term control plane should move from the current custom Worker + Durable Object orchestration to **Cloudflare Agents**.

See also:
- [Memory conventions](./memory.md)
- [Progress tracker](./TODO.md)

---

## Product requirements

### 1) Main thread = Bruh
- `/` is the canonical ongoing thread
- the main thread lives in the canonical **root sandbox**
- the sandbox filesystem can keep Bruh's actual **Pi session history** and working state

### 2) Side threads are focused branches
- `/threads/:id` are focused branches of the same agent, not separate personas
- side threads should eventually get their own **sandboxed workspace** and Pi session history
- they should share the same durable memory and overall tool surface as main

### 3) Shared durable memory
All threads share the same R2-backed memory layer.

That includes:
- user preferences
- durable facts
- dated notes
- project memory
- session/thread summaries

### 4) Future agent capabilities
The platform should support:
- web browsing
- workflows
- scheduled jobs
- MCP/custom tools
- richer cloud-native orchestration over time

---

## Operating model

### Main thread
The main thread is the user's home conversation with Bruh.

It should:
- feel continuous over time
- own the canonical root sandbox
- have access to all shared memory
- be able to inspect the status and summaries of side threads

### Side threads
Side threads are ad-hoc branches for:
- projects
- investigations
- experiments
- temporary focused chats

They should:
- inherit Bruh's identity and shared memory
- have the same overall capability surface
- keep their own sandbox-local workspace, files, processes, and Pi session history

### How main should know about side threads
Main should not need every raw side-thread transcript.

Instead, side-thread awareness should come from:
- thread metadata / registry
- shared durable memory
- `memory/sessions/<thread-id>/summary.md`

Those summaries become the durable handoff between branches.

---

## Storage model

Different kinds of state belong in different places.

| Concern | Home | Notes |
|---|---|---|
| durable memory | **R2** | shared across main and all side threads |
| preferences / profile | **R2** | `memory/profile.md` |
| dated notes | **R2** | `memory/notes/YYYY-MM-DD.md` |
| project memory | **R2** | `memory/projects/<slug>/...` |
| thread summaries | **R2** | `memory/sessions/<thread-id>/summary.md` |
| actual Pi session history | **sandbox filesystem** | local to the thread's sandbox |
| workspace files / repos / temp artifacts | **sandbox filesystem** | local to the thread's sandbox |
| running services / background processes | **sandbox filesystem** | local to the thread's sandbox |
| thread registry / schedules / workflows | **Agents state / SQLite later** | durable orchestration layer |

### Important distinction
- **R2** is the durable cross-thread memory system
- **sandbox filesystem** is the thread-local execution/workspace system

This keeps durable memory clean while still letting Pi use a real filesystem and local process model.

---

## Repo layout

```txt
bruh/
  edge/     # current Worker/DO control plane and R2 APIs
  runtime/  # Pi runtime that will move into Cloudflare Sandbox
  web/      # React/Vite UI
  docs/     # planning docs and progress tracking
```

Notes:
- keep the repo light
- avoid introducing extra packages until the boundaries are stable
- small shared protocol types can stay inline until the architecture settles

---

## Architecture plan

### Current implemented foundation
The current system already has a solid foundation:
- Worker + Durable Object session orchestration
- SSE event streaming and replay
- Pi SDK runtime
- R2-backed memory tools
- thread-local workspace roots in the transition runtime
- controlled workspace file tools
- main thread at `/`
- side threads at `/threads/:id`
- steer / follow-up / abort
- web chat UX

That foundation remains useful, but it is now the **transition architecture**, not the final destination.

### 1) `edge/` — current transitional control plane
Current responsibilities:
- session/thread routing
- event buffering and replay
- SSE stream endpoints
- forwarding commands to runtime
- R2-backed internal storage APIs

Near-term role:
- stay in place while the runtime moves into Sandbox
- continue to provide the current chat product without a big rewrite

Long-term role:
- most thread orchestration responsibilities should move into **Cloudflare Agents**

### 2) `runtime/` — Pi execution engine
Responsibilities:
- host Pi via `createAgentSession()`
- load `.pi/` extensions and prompts
- execute prompt / steer / follow-up / abort
- publish normalized events
- write thread summaries to R2

Near-term direction:
- move this runtime into **Cloudflare Sandbox SDK**
- preserve the current HTTP/event contract as much as possible during migration

Long-term role:
- Pi remains the execution engine inside each thread's sandbox

### 3) `web/` — product UI
Responsibilities:
- main thread UI
- side thread UI
- transcript and tool activity
- composer and controls
- thread list and navigation

The route model stays:
- `/` → Main
- `/threads` → thread index
- `/threads/:id` → thread chat

---

## Target execution topology

### Root sandbox for main
The main thread should map to the canonical **root sandbox**.

That sandbox keeps:
- main's Pi session history
- main's local workspace state
- main's local artifacts/processes

### Dedicated sandbox per side thread
Each side thread should eventually map to its own sandbox.

That gives each thread:
- isolated workspace files
- isolated processes and local services
- isolated Pi session history
- clean room for project-specific work

### Why not share one sandbox across all threads?
Because once workspace tools exist, sharing a sandbox would also share:
- cwd
- files
- processes
- temp artifacts
- local services

That would make focused threads leak into each other. The right isolation boundary is **one sandbox per thread**.

---

## Tool model

### Shared tool surface
All threads should feel like the same agent with the same general capabilities.

Shared/global capabilities include:
- durable memory tools
- thread-awareness tools
- future browsing tools
- future workflow/schedule tools
- future MCP/custom remote tools

### Thread-local workspace tools
Workspace tools should exist in every thread, but operate inside that thread's sandbox.

Examples:
- read/search files
- bash
- write/edit files
- git helpers
- local servers/background processes

So the product promise is:
- **same capabilities**
- **different local workspaces**

---

## Transport model

### Current transport
The current implementation uses:
- HTTP commands
- SSE streaming
- replayable event envelopes

This remains the near-term transport while the runtime is sandboxed.

### Later transport/orchestration
When orchestration moves to Agents, the transport may evolve to use:
- Agent HTTP/SSE
- Agent WebSockets
- Agent state sync

But Pi itself should still remain the execution engine behind that control plane.

---

## Cloudflare Agents plan

After the runtime is successfully sandboxed and thread-to-sandbox mapping is stable, move orchestration to **Cloudflare Agents**.

### What Agents should own later
- thread registry / metadata
- durable per-thread control-plane state
- schedules and wakeups
- workflows
- browser-driven capabilities
- MCP server/client integrations
- richer live client sync

### What Agents should not replace
Agents should not replace Pi's chat/session engine.

Pi already owns:
- prompt handling
- tool-use loop
- steer / follow-up semantics
- session history behavior

So the likely later shape is:
- **Agents** = control plane
- **Pi in Sandbox** = execution plane

### Important design choice
Use the base **`Agent`** model later, not `AIChatAgent`.

Reason:
- `AIChatAgent` overlaps too much with Pi's own message/session model
- Bruh should avoid having two competing chat/session engines

---

## Delivery phases

### Phase 0 — foundation (done / mostly done)
- repo scaffolding
- web chat app
- Worker + DO session orchestration
- Pi SDK runtime
- R2 memory tools
- thread summaries and steer/follow-up

### Phase 1 — sandbox the runtime (next)
- package `runtime/` for Cloudflare Sandbox
- run the existing Pi runtime inside Sandbox
- keep current edge/web flow intact while migrating
- verify Pi, Anthropic, memory tools, and summaries all work in Sandbox

### Phase 2 — align sandbox identity with thread identity
- `main` → root sandbox
- side thread → dedicated sandbox
- isolate workspace files/processes/Pi session history per thread
- keep R2 memory shared across all threads

### Phase 3 — add workspace power
- controlled workspace file tools
- shell/search/git helpers
- background processes and local services when needed

### Phase 4 — migrate orchestration to Agents
- replace custom thread/session orchestration with Cloudflare Agents
- use one Agent instance per thread
- keep Pi in Sandbox as the execution engine

### Phase 5 — add cloud-native capabilities
- browsing
- schedules
- workflows
- MCP/custom tool surfaces
- richer approvals / notifications / automation

---

## Current decision summary

- **Pi SDK** over Pi emulation
- **R2-backed memory** as the durable cross-thread memory layer
- **sandbox filesystem** for actual Pi session history and workspace state
- **root sandbox for main**
- **dedicated sandbox per side thread**
- **same memory, same tool surface, isolated local workspaces**
- **current Worker + DO control plane is transitional**
- **Cloudflare Agents is the long-term orchestration layer**
- use base **`Agent`**, not `AIChatAgent`, when that migration happens

---

## North-star outcome

The end result should feel like:
- one personal Pi-powered agent named **Bruh**
- a canonical main thread with a real home workspace
- side threads that act like focused branches, not separate bots
- shared durable memory across the whole system
- sandboxed execution power where workspace tools can safely grow
- Cloudflare-native orchestration for scheduling, workflows, browsing, and MCP
