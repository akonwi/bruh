# Local Sandbox development

This document captures the current **known-good local setup** for Cloudflare Sandbox development in this repo, plus the failure modes we have already seen and the order we use to debug them.

## Known-good baseline

For local Sandbox work on Apple Silicon, the baseline we have successfully validated is:

- **Docker Desktop** running locally
- Docker context set to **`desktop-linux`**
- **Rosetta / x86_64 amd64 emulation** enabled in Docker Desktop
- The repo's current `edge/Dockerfile` left intact, including its custom local-development entrypoint

This is the baseline that worked for:

- the official Cloudflare Sandbox minimal example
- this repo's `edge/` worker
- local Pi CLI / Pi SDK execution inside the sandbox runtime

## Why this baseline exists

Cloudflare Sandbox images are currently centered around **`linux/amd64`** images. On Apple Silicon, local behavior depends on emulation and on the local Docker provider. In our testing, **Docker Desktop + Rosetta** has been the most reliable local path.

Other providers may work, but they are **not** the documented baseline for this repo.

## Quick checks before debugging app code

Confirm the Docker context you are actually using:

```bash
docker context ls
docker version
```

The active context should be **`desktop-linux`** when using the documented baseline.

## Repo-local verification flow

Start the edge worker:

```bash
bun run dev:edge
```

Sanity-check the worker itself:

```bash
curl http://127.0.0.1:8790/health
```

That should return a bootstrapped health payload.

If you need to verify that the worker can actually run Pi inside the sandbox, hit the internal RPC event route:

```bash
SECRET="$(grep '^INTERNAL_API_SECRET=' edge/.dev.vars | cut -d'=' -f2-)"

curl --no-buffer -X POST http://127.0.0.1:8790/internal/pi-sandbox/main/rpc-events \
  -H "content-type: application/json" \
  -H "x-bruh-internal-secret: ${SECRET}" \
  --data '{"message":"Respond with exactly: OK","timeoutMs":120000}'
```

A successful response should stream newline-delimited JSON ending with an `agent_end` event whose `assistantText` is `OK`. That confirms that the worker can launch Pi RPC inside the local Sandbox runtime.

## Recommended control test

When local Sandbox behavior is unclear, use the **official Cloudflare Sandbox minimal example** as the control before debugging this repo.

Expected successful checks in that example are:

```bash
curl http://127.0.0.1:8787/run
curl http://127.0.0.1:8787/file
```

Interpretation:

- If the official minimal example fails, the problem is likely **local Sandbox runtime / Docker environment**, not this app.
- If the official minimal example works but this repo fails, focus on **repo-specific integration or image behavior**.

## Known local oddities that may be non-fatal

During successful local runs, Wrangler may still log transient messages like:

```text
Error checking if container is ready: Container is not listening to port 3000
```

A few startup-time occurrences of that message are currently **not enough by themselves** to declare local Sandbox boot failure.

Treat it as noise **only if** the worker endpoints and sandbox-backed requests succeed afterward.

## Known fallback for proxy-sidecar failures

If you hit errors like these:

- `Fatal error: setsockoptint: protocol not available`
- `Network connection lost`
- `No such container`

try exporting the known egress-image workaround before `wrangler dev`:

```bash
export MINIFLARE_CONTAINER_EGRESS_IMAGE='cloudflare/proxy-everything:3cb1195@sha256:78c7910f4575a511d928d7824b1cbcaec6b7c4bf4dbb3fafaeeae3104030e73c'
```

On the current documented Docker Desktop + Rosetta baseline, we have seen successful local runs **with and without** this override. Treat it as a fallback for sidecar-specific failures, not a required default.

## Important repo-specific note: custom sandbox entrypoint

`edge/Dockerfile` intentionally overrides the published image entrypoint during local development:

```dockerfile
ENTRYPOINT ["/usr/local/bin/bun", "/container-server/dist/index.js"]
```

That workaround exists because, in this local environment, the published `/container-server/sandbox` entrypoint exited immediately instead of keeping the control server alive.

Do **not** remove or simplify that entrypoint casually. If you want to revisit it, first re-validate:

1. the official minimal example
2. this repo's `/health` route
3. Pi execution via the internal RPC event route

## Debugging order

When local Sandbox behavior regresses, debug in this order:

1. **Docker baseline**
   - Docker Desktop running
   - `desktop-linux` context active
   - Rosetta enabled
2. **Official minimal example**
3. **This repo's edge worker**
4. **Pi-specific runtime behavior inside the sandbox**

Keeping that order helps separate environment problems from app problems.
