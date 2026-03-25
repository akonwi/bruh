import { getSandbox, proxyToSandbox, type Sandbox as SandboxInstance } from '@cloudflare/sandbox'

export { Sandbox } from '@cloudflare/sandbox'

interface Env {
  Sandbox: DurableObjectNamespace<SandboxInstance>
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_MODEL?: string
  EDGE_BASE_URL?: string
  INTERNAL_API_SECRET?: string
  CF_ACCESS_CLIENT_ID?: string
  CF_ACCESS_CLIENT_SECRET?: string
}

const MAIN_SANDBOX_ID = 'main'
const RUNTIME_PORT = 3000
const RUNTIME_COMMAND = 'node dist/server.js'
const RUNTIME_WORKDIR = '/app'
const RUNTIME_PROJECT_CWD = '/workspace'
const RUNTIME_AGENT_DIR = '/workspace/.data/pi-agent'
const LOCAL_EDGE_BASE_URL = 'http://host.docker.internal:8790'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        service: 'runtime-sandbox',
        status: 'bootstrapped',
        hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY?.trim()),
      })
    }

    if (url.pathname === '/debug/ports') {
      const sandbox = getSandbox(env.Sandbox, 'main', { normalizeId: true })
      const r = await sandbox.exec(
        `pgrep -a node; echo "---"; netstat -tlnp 2>/dev/null | grep 3000 || cat /proc/net/tcp6 | awk 'NR>1 {print $2}' | while read addr; do echo "$addr"; done | grep -i "0BB8" || echo "port 3000 not in tcp6"`,
        { cwd: RUNTIME_WORKDIR },
      )
      return Response.json({ stdout: r.stdout, stderr: r.stderr })
    }




    const proxyResponse = await proxyToSandbox(request, env)
    if (proxyResponse) {
      return proxyResponse
    }

    if (!env.ANTHROPIC_API_KEY?.trim()) {
      return Response.json(
        {
          error: 'ANTHROPIC_API_KEY is required for the sandboxed Bruh runtime',
        },
        { status: 500 },
      )
    }

    try {
      const sandboxId = getRuntimeSandboxId(request)
      const sandbox = getSandbox(env.Sandbox, sandboxId, {
        normalizeId: true,
        keepAlive: sandboxId === MAIN_SANDBOX_ID,
        sleepAfter: sandboxId === MAIN_SANDBOX_ID ? '24h' : '30m',
        containerTimeouts: {
          instanceGetTimeoutMS: 120_000,
          portReadyTimeoutMS: 120_000,
          waitIntervalMS: 1_000,
        },
      })

      const port = await ensureRuntimeProcess(sandbox, env)
      return sandbox.containerFetch(request, port)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown runtime error'
      console.error('[runtime-sandbox] request failed:', message)
      return Response.json({ error: message }, { status: 502 })
    }
  },
}

function getRuntimeSandboxId(request: Request): string {
  const url = new URL(request.url)
  const sessionMatch = url.pathname.match(/^\/internal\/sessions\/([^/]+)\//)
  if (sessionMatch?.[1]) {
    return decodeURIComponent(sessionMatch[1])
  }

  return MAIN_SANDBOX_ID
}


async function ensureRuntimeProcess(sandbox: SandboxInstance, env: Env): Promise<number> {
  // Read the port the server will use (written by the server on startup)
  const readPort = async (): Promise<number> => {
    try {
      const result = await sandbox.exec(`cat /tmp/runtime-port.txt`, { cwd: RUNTIME_WORKDIR })
      const port = parseInt(result.stdout.trim(), 10)
      if (port > 0) return port
    } catch {}
    return RUNTIME_PORT
  }

  // Check if the runtime is already healthy
  const currentPort = await readPort()
  try {
    const healthResult = await sandbox.exec(
      `curl -sf http://localhost:${currentPort}/health`,
      { cwd: RUNTIME_WORKDIR },
    )
    if (healthResult.exitCode === 0) {
      return currentPort
    }
  } catch {
    // Not healthy, continue to start
  }

  // Kill any existing server processes from inside the container
  await sandbox.exec(
    `fuser -k 3000/tcp 2>/dev/null; kill -9 $(pgrep -f "server.js") 2>/dev/null; sleep 5`,
    { cwd: RUNTIME_WORKDIR },
  ).catch(() => {})
  await new Promise(r => setTimeout(r, 6000))

  const runtimeEnv = buildRuntimeEnv(env)

  // Start server with output captured, env vars via SDK's env option
  const cmd = 'node /app/dist/server.js >> /tmp/runtime-stdout.txt 2>> /tmp/runtime-stderr.txt'
  await sandbox.startProcess(
    `sh -c '${cmd}'`,
    { cwd: RUNTIME_WORKDIR, env: runtimeEnv, processId: `pi-runtime-${Date.now()}` },
  )

  // Poll until healthy — Pi SDK takes time to initialize (~30-90s)
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(r => setTimeout(r, 2000))
    // Re-read port in case it changed
    const checkPort = await readPort()
    try {
      const check = await sandbox.exec(
        `curl -sf http://localhost:${checkPort}/health`,
        { cwd: RUNTIME_WORKDIR },
      )
      if (check.exitCode === 0) {
        return checkPort
      }
    } catch {
      // Not ready yet
    }
  }

  const diagnostics = await sandbox.exec(
    `cat /tmp/runtime-stderr.txt 2>/dev/null | head -20; pgrep -a node 2>/dev/null | head -5`,
    { cwd: RUNTIME_WORKDIR },
  ).catch(() => ({ stdout: '(unavailable)' }))
  throw new Error(`Runtime process did not become healthy within 120s.\n${diagnostics.stdout}`.trim())
}

function buildRuntimeEnv(env: Env): Record<string, string> {
  const vars: Record<string, string> = {
    PORT: String(RUNTIME_PORT),
    NODE_ENV: 'production',
    BRUH_RUNTIME_CWD: RUNTIME_PROJECT_CWD,
    BRUH_RUNTIME_AGENT_DIR: RUNTIME_AGENT_DIR,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL?.trim() || 'claude-opus-4-6',
    EDGE_BASE_URL: env.EDGE_BASE_URL?.trim() || LOCAL_EDGE_BASE_URL,
  }

  if (env.ANTHROPIC_API_KEY?.trim()) vars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY.trim()
  if (env.INTERNAL_API_SECRET?.trim()) vars.INTERNAL_API_SECRET = env.INTERNAL_API_SECRET.trim()
  if (env.CF_ACCESS_CLIENT_ID?.trim()) vars.CF_ACCESS_CLIENT_ID = env.CF_ACCESS_CLIENT_ID.trim()
  if (env.CF_ACCESS_CLIENT_SECRET?.trim()) vars.CF_ACCESS_CLIENT_SECRET = env.CF_ACCESS_CLIENT_SECRET.trim()

  return vars
}
