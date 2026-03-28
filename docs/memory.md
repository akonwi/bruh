# Bruh Memory Conventions

Bruh uses **R2-backed durable memory** for information that should survive across sessions and threads.

This memory is **not** a general workspace filesystem. It is a small, intentional store for:
- user preferences
- stable personal facts
- durable project context
- dated notes
- rolling session summaries

All threads share the same R2-backed memory tree. The main thread and all side threads should read and write the same durable memory.

## Principles

- Keep durable memory **small, readable, and reusable**.
- Prefer a few predictable paths over many ad hoc files.
- Store information that will help later.
- Avoid storing one-off chatter unless it will matter again.
- Do not store secrets unless the user explicitly asks.

## Memory vs sandbox filesystem

Use the two layers differently:

- **R2 memory** is the shared, durable memory system across main and all side threads.
- **Sandbox filesystem** is the thread-local execution/workspace layer.
- Actual raw **Pi session files/history** can live in each thread's sandbox.
- `sessions/<session-id>/summary.md` is the durable cross-thread handoff, not the full raw session history.
- If Bruh later adds internal side-thread sandbox snapshots under a path like `sandboxes/<session-id>/...`, treat that as runtime-managed recovery data, not user-authored memory.

## Path conventions

All paths below are relative to the `memory/` root.

### `profile.md`

Use for stable user information that is broadly useful across threads.

**Rule:** user preferences and standing operating preferences should always go in `profile.md`, even if they come up inside a project thread.

Good fits:
- preferences
- communication style
- recurring habits
- long-lived personal facts the user wants remembered
- standing operating preferences for Bruh

Suggested sections:
- `# Profile`
- `## Preferences`
- `## Communication`
- `## Ongoing priorities`
- `## Important facts`

Avoid putting day-to-day notes here.
Avoid using dated note files for user preferences.

---

### `notes/YYYY-MM-DD.md`

Use for dated notes, loose observations, and lightweight journaling.

Good fits:
- meeting notes
- quick thoughts
- temporary reminders that still matter for a while
- links or references collected on a day

Recommended pattern:
- one file per day
- append new entries instead of rewriting the whole file
- use short headings or timestamped bullets when helpful

Example paths:
- `notes/2026-03-24.md`
- `notes/2026-03-25.md`

---

### `projects/<slug>/...`

Use for project-specific durable context.

Recommended files:
- `projects/<slug>/overview.md` — what the project is, goals, constraints, current shape
- `projects/<slug>/notes.md` — running notes and context
- `projects/<slug>/todo.md` — next actions and open tasks
- `projects/<slug>/decisions.md` — important decisions and why they were made

Example:
- `projects/bruh/overview.md`
- `projects/bruh/todo.md`
- `projects/bruh/decisions.md`

When in doubt:
- stable project facts → `overview.md`
- open action items → `todo.md`
- rationale / tradeoffs → `decisions.md`
- extra context → `notes.md`

---

### `sessions/<session-id>/summary.md`

Use for a rolling summary of a session or thread.

In Bruh, this file is intended primarily as a **rehydration snapshot** for returning to a thread later and for helping the main thread stay aware of side threads.

Current behavior:
- `sessions/<session-id>/summary.md` is **auto-written by the runtime** after completed runs
- it is a rolling snapshot, not a full transcript
- it should be safe to read when resuming older work

Example paths:
- `sessions/main/summary.md`
- `sessions/abc123/summary.md`

Bruh usually should **read** this file, not manually rewrite it, unless the user explicitly wants a custom summary.

## Memory habits for Bruh

### Recall before asking the user to repeat themselves

Use memory tools when the user is referring to:
- an ongoing project
- known preferences
- previously saved notes
- earlier thread context worth resurfacing

### Store durable things, not everything

Save memory when the user shares something that is likely to matter later, such as:
- a stable preference
- a project decision
- a reusable project constraint
- a follow-up item worth keeping
- a note the user clearly wants remembered

Routing rule:
- user preference or how Bruh should behave for the user → `profile.md`
- dated general note → `notes/YYYY-MM-DD.md`
- project-specific context or decision → `projects/<slug>/...`

Usually do **not** save:
- ephemeral banter
- redundant transcript fragments
- sensitive credentials
- information the user did not imply should be retained

### Prefer the right tool for the job

- use `memory_list` when you need to discover what exists
- use `memory_read` when recalling an existing file
- use `memory_write` when creating or replacing a file wholesale
- use `memory_edit` for precise updates to known text
- use `memory_append` for dated notes and incremental logging

## Recommended first files

These are the most useful early memory files:
- `profile.md`
- `notes/YYYY-MM-DD.md`
- `projects/bruh/overview.md`
- `projects/bruh/todo.md`
- `sessions/main/summary.md`
