import { cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

function sanitizeSessionId(sessionId: string): string {
  const trimmed = sessionId.trim()
  if (!trimmed) {
    throw new Error('sessionId is required')
  }

  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_')
  if (!normalized) {
    throw new Error(`Could not derive a safe workspace directory from sessionId: ${sessionId}`)
  }

  return normalized
}

export function getWorkspaceRoot(baseCwd: string, sessionId: string): string {
  return path.join(baseCwd, '.data', 'workspaces', sanitizeSessionId(sessionId))
}

export async function ensureThreadWorkspace(baseCwd: string, sessionId: string): Promise<string> {
  const workspaceRoot = getWorkspaceRoot(baseCwd, sessionId)
  const sourcePiDir = path.join(baseCwd, '.pi')
  const targetPiDir = path.join(workspaceRoot, '.pi')

  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(path.join(workspaceRoot, 'artifacts'), { recursive: true })
  await mkdir(path.join(workspaceRoot, 'tmp'), { recursive: true })

  await rm(targetPiDir, { recursive: true, force: true })
  await cp(sourcePiDir, targetPiDir, { recursive: true })

  return workspaceRoot
}
