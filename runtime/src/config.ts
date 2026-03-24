import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface RuntimeConfig {
  port: number;
  edgeBaseUrl: string;
  cwd: string;
  agentDir: string;
  anthropicApiKey: string;
}

export async function loadConfig(): Promise<RuntimeConfig> {
  const cwd = process.cwd();
  const agentDir = path.resolve(cwd, '.data/pi-agent');
  await mkdir(agentDir, { recursive: true });

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required to run the Pi runtime locally.');
  }

  return {
    port: Number(process.env.PORT || 8788),
    edgeBaseUrl: (process.env.EDGE_BASE_URL || 'http://127.0.0.1:8790').replace(/\/+$/, ''),
    cwd,
    agentDir,
    anthropicApiKey,
  };
}
