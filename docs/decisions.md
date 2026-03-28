# Architecture Decisions

> Note: some sections below reflect earlier pre-Pi architecture work. On branch `pi-sandbox`, the sections under **Pi sandbox branch decisions** supersede older decisions where they conflict.

## Pi sandbox branch decisions

### Prompt controls stay server-driven for now

**Decision:** Keep `steer` and `follow-up` on the current Pi branch wired through the server-side `AIChatAgent` continuation machinery. Do not proactively refactor them to a client-driven flow yet.

**Why:** We currently have a single first-party web client, the server-driven path is working, and the continuation APIs already handle the hard parts of resumable chat turns. Refactoring now would mostly be paying migration cost early rather than reducing an active problem.

### Why each internal API is currently used

#### `__DO_NOT_USE_WILL_BREAK__agentContext`
Used only to capture the **live connection for the current `onChatMessage(...)` turn**.

We need that connection later when `/steer` or `/follow-up` asks the server to queue another turn against the same active chat session. There is not currently a comparably direct public API that exposes "the connection that owns the current chat turn" from inside `onChatMessage(...)`.

Public alternatives were considered, but none are clearly better right now:
- `getWebSocket()` is public, but it is not the same abstraction as "current chat connection for this turn" in our current setup.
- Manual connection tracking via `onConnect(...)` is possible, but it would add our own connection bookkeeping and lifecycle cleanup without materially improving current behavior.

This is the **most fragile dependency** in the current design, and the first one we should remove if a future SDK change forces a refactor.

#### `_enqueueAutoContinuation(...)`
Used to ask `AIChatAgent` to **run another chat turn and stream it back through the existing resumable chat transport**.

This is exactly what `steer` and `follow-up` need after their control message has been persisted. The continuation helper already knows how to:
- queue the next turn
- coalesce rapid adjacent continuations
- wait for prerequisites to settle
- re-enter `onChatMessage(...)`
- attach the continuation to the existing chat stream machinery

This still carries private-API risk, but it is solving a real framework concern rather than a missing connection lookup.

#### `_lastBody`
Used to preserve the most recent request body for the continuation turn.

That matters because our chat body carries request-scoped metadata such as:
- `clientTimezone`
- `clientNowIso`

When a continuation runs, we want it to inherit the same context shape as a normal user-driven chat turn.

#### `_lastClientTools`
Used to preserve the client-tool context that `AIChatAgent` expects to carry across continuation turns.

The current Pi path is not heavily dependent on client-side tool execution, but carrying this forward keeps the continuation path aligned with the framework's expected chat lifecycle.

### Escape hatch if a future version breaks `agentContext`

If a future SDK release removes or breaks `__DO_NOT_USE_WILL_BREAK__agentContext`, the lowest-risk fallback is to move prompt controls to the client.

#### Follow-up
Make follow-up purely client state:
1. while the assistant is streaming, store the pending follow-up text in React state
2. once the turn returns to idle, send that text as a normal user message

This removes the need for the server to recover the active connection just to schedule a second turn.

#### Steer
Treat steer as **interrupt + resend**:
1. client stops the active turn
2. once the turn is stopped, client sends the steer text as a normal user message

Today that can still use the `[STEER] ...` convention already understood by the Pi path. Later, if we want, that can become a more explicit structured control message.

#### Abort
Abort is already conceptually client-driven. The client stop action is the natural control surface.

### Refactor threshold

**Decision:** Do not spend time removing these internal APIs unless a version change or runtime regression forces it.

**Why:** For a single known client, the current server-driven design is simpler than preemptively building a second control-flow architecture. If the dependency becomes painful, remove `agentContext` first by moving `follow-up` and `steer` orchestration into client state.

### Deferred: side-thread sandbox snapshots

**Decision:** Defer sandbox snapshot/restore work for now, but keep it as an available future enhancement for side threads.

**Why:** Side threads on this branch are intentionally ephemeral and currently use `sleepAfter: '24h'`. Most of the time that is acceptable. The main value of snapshotting would be exceptional recovery: if a side-thread sandbox sleeps or gets recreated and the user wants to resume local workspace state without rebuilding it manually.

Current intended shape if we add it later:
- apply it to **side threads only**, not the main thread
- treat it as a **best-effort workspace restore**, not a new source of truth
- keep backups in the existing durable memory bucket under a dedicated path such as `sandboxes/<session-id>/...`, not a separate bucket
- keep only the **latest** recent snapshot per side thread with short retention
- restore only on a **cold side-thread resume**, not on every request
- prefer snapshotting the side thread workspace (likely `/workspace`) so `.pi-sessions` and local artifacts come back together

Important constraint:
- there should not be competing truths to reconcile. Durable memory and durable thread state remain the authoritative app state, and sandbox snapshots are only there to recreate the same thread-local filesystem state more conveniently after sleep/restart.

## Cloudflare-native, no separate runtime

**Decision:** Run the agent loop directly in a Cloudflare Durable Object using `AIChatAgent` from the Agents SDK + AI SDK v6 `streamText`. No separate Node.js runtime or Pi SDK.

**Why:** An earlier design ran the Pi SDK inside a Cloudflare Sandbox container as a separate runtime process. This added significant complexity (Docker builds, process management, port conflicts, env var propagation) without proportional benefit. Pi's extension loading system (jiti, filesystem scanning) was the main source of friction.

The current approach uses the AI SDK's `tool()` function for tool definitions and `streamText` for the agent loop. This is lighter, more portable, and runs entirely within the Cloudflare Workers runtime.

## AIChatAgent over base Agent

**Decision:** Extend `AIChatAgent` (not base `Agent`) for the chat DO.

**Why:** `AIChatAgent` provides message persistence, resumable streaming, WebSocket broadcasting, and the `onChatMessage` hook — all of which we'd otherwise build ourselves. The earlier plan to use base `Agent` was motivated by Pi owning the chat loop, but with Pi removed, `AIChatAgent` is the right fit.

## Multi-provider via AI SDK

**Decision:** Use `@ai-sdk/anthropic` and `@ai-sdk/openai` provider packages. Select based on which API key is present in env vars (Anthropic preferred).

**Why:** The AI SDK provides a unified `streamText`/`generateText` interface across providers. Adding a new provider is one import + one env var.

## Memory in R2, messages in SQLite

**Decision:** Durable memory (profile, notes, projects, summaries) lives in R2. Conversation messages live in the DO's built-in SQLite.

**Why:** R2 is shared across all thread instances and survives DO resets. SQLite is per-DO-instance and handles the high-frequency message read/write pattern well. Session summaries bridge the two: they're written to R2 so other threads can read them.

## One sandbox per session

**Decision:** Each agent session gets its own Sandbox container, keyed by a short session ID.

**Why:** Sandbox filesystems are isolated per container. Sharing a container across threads would leak workspace state. Per-session sandboxes give each thread its own bash, filesystem, and git environment.

## Tools as stateless functions

**Decision:** All tools (memory, sandbox, scheduling, threads, MCP) are stateless functions defined inline in `getTools()`. No extension loading, no filesystem scanning, no jiti.

**Why:** The tool definitions are simple — they call R2, the Sandbox SDK, or the Agents SDK scheduling API. There's no benefit to a plugin/extension system for a personal agent with a known, stable tool surface.

## MCP tools auto-exposed via getAITools()

**Decision:** Connected MCP server tools are merged into the model's tool set automatically via `this.mcp.getAITools()`. No manual `mcp_call` wrapper needed.

**Why:** The Agents SDK's MCP client discovers tools from connected servers and converts them to AI SDK format. The model can call them directly like any other tool. Management tools (`mcp_connect`, `mcp_disconnect`, `mcp_servers`, `mcp_tools`) handle the connection lifecycle.

## Scheduled tasks execute as agent prompts

**Decision:** Scheduled tasks run `generateText` (not `streamText`) with a standalone prompt. Only the assistant's response is added to the message transcript.

**Why:** There's no connected client when a schedule fires, so streaming is pointless. The task runs as an ephemeral agent call with access to all tools, and the result appears as an assistant message (prefixed with ⏰) so the user sees what happened.

## Default MCP servers via env vars

**Decision:** Known MCP servers (like GitHub) auto-connect on agent start if their token env var is present.

**Why:** For a personal agent with predictable integrations, config-driven setup is better than requiring the user to connect servers manually each time. The `DEFAULT_MCP_SERVERS` list in `bruh-agent.ts` is easy to extend.

## Web app uses useAgentChat

**Decision:** The React SPA connects to the agent via WebSocket using `useAgent` + `useAgentChat` from the Agents SDK.

**Why:** `AIChatAgent` is designed for this — it handles message broadcasting, stream resumption, and state sync over WebSocket. The earlier SSE-based event system was replaced entirely.
