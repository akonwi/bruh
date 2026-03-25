import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface RuntimeConfig {
  port: number;
  edgeBaseUrl: string;
  cwd: string;
  agentDir: string;
  anthropicApiKey: string;
  anthropicModel: string;
  internalApiSecret?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

export async function loadConfig(): Promise<RuntimeConfig> {
  const cwd = path.resolve(process.env.BRUH_RUNTIME_CWD?.trim() || process.cwd());
  const agentDir = path.resolve(
    process.env.BRUH_RUNTIME_AGENT_DIR?.trim() || path.join(cwd, '.data/pi-agent'),
  );
  await mkdir(agentDir, { recursive: true });

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required to run the Pi runtime.');
  }

  return {
    port: Number(process.env.PORT || 8788),
    edgeBaseUrl: (process.env.EDGE_BASE_URL || 'http://localhost:8790').replace(/\/+$/, ''),
    cwd,
    agentDir,
    anthropicApiKey,
    anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-4-6',
    internalApiSecret: process.env.INTERNAL_API_SECRET?.trim() || undefined,
    cfAccessClientId: process.env.CF_ACCESS_CLIENT_ID?.trim() || undefined,
    cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET?.trim() || undefined,
  };
}
