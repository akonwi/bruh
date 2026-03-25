# Bruh TODO

Concrete implementation tracker for the current Bruh plan.

## Status legend

- [ ] not started
- [~] in progress / partially done
- [x] done

---

## 0. Foundation already built

These core pieces are already in place:

- [x] Pivot away from MoltWorker/OpenClaw
- [x] Create repo layout:
  - `edge/`
  - `runtime/`
  - `web/`
- [x] Build the current Worker + Durable Object + SSE control plane
- [x] Build the current Pi SDK runtime
- [x] Build the web chat UI
- [x] Support:
  - [x] prompt
  - [x] steer
  - [x] follow-up
  - [x] abort
- [x] Add R2-backed memory tools
- [x] Add thread-local workspace roots in the transition runtime
- [x] Add controlled workspace file tools:
  - [x] `workspace_list`
  - [x] `workspace_read`
  - [x] `workspace_write`
  - [x] `workspace_edit`
  - [x] `workspace_search`
- [x] Add main thread semantics at `/`
- [x] Add side thread routes at `/threads/:id`
- [x] Add rolling thread summaries in `memory/sessions/<session-id>/summary.md`
- [x] Define memory conventions for:
  - [x] `profile.md`
  - [x] `notes/YYYY-MM-DD.md`
  - [x] `projects/<slug>/...`
  - [x] `sessions/<session-id>/summary.md`

The current system is a strong foundation, but it is now the **transition architecture**, not the final target.

---

## 1. Sandbox the runtime (next)

Goal: move the current Pi runtime into the **Cloudflare Sandbox SDK** with minimal product churn.

- [x] Add Dockerfile / sandbox packaging for `runtime/`
- [x] Decide how the current runtime server boots inside Sandbox
- [x] Start the existing Pi runtime server inside Sandbox
- [ ] Verify `.pi/` loading works in Sandbox
- [ ] Verify Anthropic auth/model selection works in Sandbox
- [ ] Verify memory extension + summary writes still work in Sandbox
- [x] Forward prompt / steer / follow-up / abort to the sandboxed runtime while preserving the current HTTP contract
- [ ] Preserve runtime event publishing back to edge
- [ ] Validate end-to-end from web through sandboxed runtime

### 1.1 Initial sandbox topology
- [x] Define the canonical sandbox ID for main
- [x] Start with `main` mapped to the canonical root sandbox
- [x] Start with all threads in Sandbox immediately

---

## 2. Make sandbox identity match thread identity

Goal: one execution workspace per thread.

- [ ] Map `main` → canonical root sandbox
- [ ] Map each side thread → dedicated sandbox
- [ ] Ensure each sandbox keeps its own:
  - [ ] Pi session files/history
  - [ ] workspace files
  - [ ] temp/artifacts
  - [ ] background processes
- [ ] Keep R2 memory shared across all threads
- [ ] Keep the same overall tool surface across main and side threads
- [ ] Ensure workspace tools are sandbox-scoped per thread

---

## 3. Thread awareness and registry

Goal: let main understand side threads without loading every raw transcript.

- [x] Add `thread_list` tool — lists side threads with title, status, last activity
- [x] Add `thread_summary` tool — reads rolling summary of a specific thread
- [x] Teach Bruh when to use thread tools in SYSTEM.md
- [x] Ensure every thread keeps an up-to-date `memory/sessions/<thread-id>/summary.md`
- [x] Let main surface side-thread status and summaries cleanly
- [ ] Define a richer thread registry model (later, with Agents)
- [ ] Track additional thread metadata:
  - [ ] sandbox ID
  - [ ] latest summary timestamp
  - [ ] tags / parent thread
- [ ] Decide where the registry lives long-term
  - [ ] Agent state / SQLite

---

## 4. Workspace power inside sandboxes

Goal: grow from memory-only power into real thread-local workspaces.

- [~] Define the sandbox filesystem layout
  - [ ] Pi session files
  - [x] workspace root
  - [x] artifacts/temp dirs
- [~] Add controlled workspace tools
  - [x] read/search
  - [ ] bash
  - [x] write/edit
  - [ ] git helpers
- [ ] Support long-running/background processes when needed
- [ ] Support exposing local services/ports when needed
- [ ] Decide how local artifacts should be surfaced back to the app

---

## 5. Move orchestration to Cloudflare Agents

Goal: replace the current custom thread/session control plane with **Cloudflare Agents**.

- [ ] Design one Agent instance per thread
- [ ] Replace `SessionDO` / `SessionIndexDO` responsibilities with Agents
- [ ] Use base `Agent`, not `AIChatAgent`, for orchestration
- [ ] Persist thread registry and control-plane state in Agent state / SQLite
- [ ] Route clients through Agents-compatible endpoints/connections
- [ ] Keep Pi in Sandbox as the execution engine behind the Agent
- [ ] Move scheduling/wakeup semantics onto Agents
- [ ] Move workflow coordination onto Agents

---

## 6. Capability expansion after Agents

Goal: unlock the capabilities the product actually wants long-term.

- [ ] Web browsing
- [ ] Scheduled jobs
- [ ] Workflows
- [ ] MCP server support
- [ ] MCP client support
- [ ] Custom remote tools
- [ ] Human approvals / handoff patterns
- [ ] Notifications / proactive work

---

## 7. Deployment and production hardening

- [ ] Deploy `edge/`
- [ ] Deploy sandboxed runtime
- [ ] Configure real secrets/env vars
- [ ] Add single-user auth on edge/control plane
- [ ] Verify memory + summaries in production
- [ ] Verify thread-to-sandbox routing in production
- [ ] Verify multiple active threads do not corrupt each other
- [ ] Decide whether/when Pi session files need backup/export beyond sandbox-local storage

---

## 8. Validation checklist

- [ ] Main thread works from web through sandboxed runtime
- [ ] Side thread works from web through its sandboxed runtime
- [ ] `steer` works during active runs
- [ ] `follow-up` works during active runs
- [ ] abort works during active runs
- [ ] reconnect/replay still works
- [ ] `memory_write` works
- [ ] `memory_read` works
- [ ] `memory_edit` works
- [ ] `memory_append` works
- [ ] summaries are written for main and side threads
- [ ] two thread sandboxes can run concurrently without leaking workspace state

---

## 9. Later / not now

- [ ] Mobile client
- [ ] Full extension-generated web UI surfaces
- [ ] Rich dashboards before core agent flows need them
- [ ] Multi-tenant architecture
- [ ] Reproducing Pi's TUI in the browser
