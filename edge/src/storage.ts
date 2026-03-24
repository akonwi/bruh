const ALLOWED_ROOTS = new Set(['memory', 'artifacts']);

export interface StorageObjectPayload {
  path: string;
  content: string;
  etag: string;
  version: string;
  size: number;
  uploadedAt: string;
  contentType?: string;
}

export interface StorageListFile {
  path: string;
  etag: string;
  version: string;
  size: number;
  uploadedAt: string;
}

export interface StorageListPayload {
  prefix: string;
  directories: string[];
  files: StorageListFile[];
  truncated: boolean;
  cursor?: string;
}

function normalizeSlashes(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+/, '');
}

function validateSegments(value: string): void {
  const segments = value.split('/');
  for (const segment of segments) {
    if (!segment) {
      throw new Error('Paths may not contain empty segments.');
    }

    if (segment === '.' || segment === '..') {
      throw new Error('Paths may not contain relative path segments.');
    }
  }
}

function validateAllowedRoot(value: string): void {
  const [root] = value.split('/');
  if (!root || !ALLOWED_ROOTS.has(root)) {
    throw new Error(`Paths must start with one of: ${[...ALLOWED_ROOTS].join(', ')}.`);
  }
}

export function normalizeStoragePath(input: string): string {
  const normalized = normalizeSlashes(input.trim());
  if (!normalized) {
    throw new Error('path is required');
  }

  validateSegments(normalized);
  validateAllowedRoot(normalized);
  return normalized;
}

export function normalizeStoragePrefix(input?: string | null): string {
  const normalized = normalizeSlashes((input ?? '').trim());
  if (!normalized) {
    return '';
  }

  const prefix = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  validateSegments(prefix);
  validateAllowedRoot(prefix);
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export function toStorageObjectPayload(object: R2ObjectBody, content: string): StorageObjectPayload {
  return {
    path: object.key,
    content,
    etag: object.etag,
    version: object.version,
    size: object.size,
    uploadedAt: object.uploaded.toISOString(),
    contentType: object.httpMetadata?.contentType,
  };
}

export function toStorageListFile(object: R2Object): StorageListFile {
  return {
    path: object.key,
    etag: object.etag,
    version: object.version,
    size: object.size,
    uploadedAt: object.uploaded.toISOString(),
  };
}

export function buildStorageListPayload(
  prefix: string,
  objects: R2Objects,
): StorageListPayload {
  return {
    prefix,
    directories: objects.delimitedPrefixes,
    files: objects.objects.map(toStorageListFile),
    truncated: objects.truncated,
    cursor: objects.truncated ? objects.cursor : undefined,
  };
}
