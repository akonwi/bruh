export type SessionStatus = 'idle' | 'active'

export interface SessionMetadata {
  sessionId: string
  createdAt: string
  updatedAt: string
  latestSeq: number
  status: SessionStatus
  title?: string
}

export interface SessionEventEnvelope {
  sessionId: string
  seq: number
  type: string
  timestamp: string
  payload: Record<string, unknown>
}

export interface SessionIndexEntry {
  sessionId: string
  createdAt: string
}

import type { Sandbox } from '@cloudflare/sandbox'
import type { BruhAgent } from './bruh-agent'

export interface Env {
  BRUH_AGENT: DurableObjectNamespace<BruhAgent>
  SANDBOX: DurableObjectNamespace<Sandbox>
  MEMORY_BUCKET: R2Bucket
  LOADER?: WorkerLoader
  ASSETS?: Fetcher
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  HOST?: string
  INTERNAL_API_SECRET?: string
}
