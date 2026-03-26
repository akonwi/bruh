# Architecture Decisions

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
