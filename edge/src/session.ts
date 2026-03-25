export type SessionStatus = 'idle' | 'active';

export interface SessionMetadata {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  latestSeq: number;
  status: SessionStatus;
  title?: string;
}

export interface SessionEventEnvelope {
  sessionId: string;
  seq: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SessionPromptRequest {
  text: string;
}

export interface SessionIndexEntry {
  sessionId: string;
  createdAt: string;
}

import type { BruhAgent } from './bruh-agent';

export interface Env {
  BRUH_AGENT: DurableObjectNamespace<BruhAgent>;
  MEMORY_BUCKET: R2Bucket;
  ASSETS?: Fetcher;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  INTERNAL_API_SECRET?: string;
}
