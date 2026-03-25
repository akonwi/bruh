import { getSandbox, proxyToSandbox, type Sandbox as SandboxInstance } from '@cloudflare/sandbox'

export { Sandbox } from '@cloudflare/sandbox'

interface Env {
  Sandbox: DurableObjectNamespace<SandboxInstance>
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_MODEL?: string
  EDGE_BASE_URL?: string
  INTERNAL_API_SECRET?: string
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

    await ensureRuntimeProcess(sandbox, env)
    return sandbox.containerFetch(request, RUNTIME_PORT)
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

async function ensureRuntimeProcess(sandbox: SandboxInstance, env: Env): Promise<void> {
  const matchingProcesses = (await sandbox.listProcesses()).filter((process) =>
    process.command.includes(RUNTIME_COMMAND),
  )

  const runningProcesses = matchingProcesses.filter(
    (process) => process.status === 'running' || process.status === 'starting',
  )

  const [primaryProcess, ...extraProcesses] = runningProcesses
  await Promise.all(extraProcesses.map((process) => process.kill().catch(() => undefined)))

  if (primaryProcess) {
    try {
      await primaryProcess.waitForPort(RUNTIME_PORT, {
        path: '/health',
        status: 200,
        timeout: 30_000,
        interval: 1_000,
      })
      return
    } catch {
      await primaryProcess.kill().catch(() => undefined)
    }
  }

  const runtimeProcess = await sandbox.startProcess(RUNTIME_COMMAND, {
    cwd: RUNTIME_WORKDIR,
    env: buildRuntimeEnv(env),
    processId: 'pi-runtime',
  })

  await runtimeProcess.waitForPort(RUNTIME_PORT, {
    path: '/health',
    status: 200,
    timeout: 60_000,
    interval: 1_000,
  })
}

function buildRuntimeEnv(env: Env): Record<string, string | undefined> {
  return {
    PORT: String(RUNTIME_PORT),
    NODE_ENV: 'production',
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY?.trim(),
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL?.trim() || 'claude-opus-4-6',
    EDGE_BASE_URL: env.EDGE_BASE_URL?.trim() || LOCAL_EDGE_BASE_URL,
    INTERNAL_API_SECRET: env.INTERNAL_API_SECRET?.trim() || undefined,
    BRUH_RUNTIME_CWD: RUNTIME_PROJECT_CWD,
    BRUH_RUNTIME_AGENT_DIR: RUNTIME_AGENT_DIR,
  }
}
