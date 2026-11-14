const DB_NAME = 'strata-workspace-db';
const DB_VERSION = 1;
const STORE_KV = 'kv';
const ASSET_INDEX_KEY = 'imageAssetPaths';
const ASSET_KEY_PREFIX = 'img:';
const NOTE_ASSET_KEY_PREFIX = 'noteAsset:';

const imageMemoryCache = new Map<string, string>();
let persistQueue: Promise<void> = Promise.resolve();

function openImageDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_KV)) {
          db.createObjectStore(STORE_KV);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}

async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openImageDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readonly');
      const req = tx.objectStore(STORE_KV).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

async function kvSet<T>(key: string, value: T): Promise<void> {
  try {
    const db = await openImageDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      tx.objectStore(STORE_KV).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore storage errors in restricted sandboxes; memory cache remains active
  }
}

export function normalizeAssetPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const assetMatch = trimmed.match(/(?:^|\/)(assets\/[^/?#\s]+)$/);
  if (assetMatch) return assetMatch[1];
  return trimmed.replace(/^(?:\.\/|\.\.\/)+/, '');
}

function makeScopedCacheKey(assetPath: string, noteId?: string): string {
  const norm = normalizeAssetPath(assetPath);
  return noteId ? `${noteId}::${norm}` : norm;
}

function makeIdbStorageKey(cacheKey: string): string {
  return cacheKey.includes('::')
    ? `${NOTE_ASSET_KEY_PREFIX}${cacheKey}`
    : `${ASSET_KEY_PREFIX}${cacheKey}`;
}

function extFromMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes('pdf')) return 'pdf';
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('gif')) return 'gif';
  if (lower.includes('svg')) return 'svg';
  if (lower.includes('bmp')) return 'bmp';
  if (lower.includes('avif')) return 'avif';
  if (lower.includes('plain')) return 'txt';
  if (lower.includes('csv')) return 'csv';
  if (lower.includes('json')) return 'json';
  if (lower.includes('zip')) return 'zip';
  return 'png';
}

export function mimeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.avif')) return 'image/avif';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (lower.endsWith('.ppt')) return 'application/vnd.ms-powerpoint';
  if (lower.endsWith('.pptx')) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  return 'application/octet-stream';
}

export function sanitizeAssetFilename(rawName: string): string {
  const base = rawName.split(/[/\\]/).pop()?.trim() || 'attachment';
  const dotIdx = base.lastIndexOf('.');
  const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  const ext = dotIdx > 0 ? base.slice(dotIdx).replace(/[^a-zA-Z0-9.]+/g, '') : '';
  const cleanStem = stem
    .replace(/[<>:"/\\|?*()[\]\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${cleanStem || 'attachment'}${ext}`;
}

function generateAssetPath(ext: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `assets/img-${stamp}-${rand}.${ext}`;
}

function generateFileAssetPath(filename: string, dataUrl: string, noteId?: string): string {
  const cleanName = sanitizeAssetFilename(filename);
  const candidate = `assets/${cleanName}`;
  const existing = imageMemoryCache.get(makeScopedCacheKey(candidate, noteId));
  if (!existing || existing === dataUrl) {
    return candidate;
  }
  const dotIdx = cleanName.lastIndexOf('.');
  const stem = dotIdx > 0 ? cleanName.slice(0, dotIdx) : cleanName;
  const ext = dotIdx > 0 ? cleanName.slice(dotIdx) : '';
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 5);
  return `assets/${stem}-${stamp}-${rand}${ext}`;
}

function queuePersistAsset(cacheKey: string, dataUrl: string): void {
  persistQueue = persistQueue
    .then(async () => {
      await kvSet(makeIdbStorageKey(cacheKey), dataUrl);
      const existing = (await kvGet<string[]>(ASSET_INDEX_KEY)) || [];
      if (!existing.includes(cacheKey)) {
        await kvSet(ASSET_INDEX_KEY, [...existing, cacheKey]);
      }
    })
    .catch(() => {});
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to decode asset blob'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read asset blob'));
    reader.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) {
    return new Blob([], { type: 'application/octet-stream' });
  }
  const header = dataUrl.slice(0, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/^data:([^;]+)/i);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';

  if (/;base64/i.test(header)) {
    const binStr = atob(payload);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  }

  return new Blob([decodeURIComponent(payload)], { type: mime });
}

/**
 * Saves a pasted or dropped image File/Blob into the workspace/note asset cache & IndexedDB.
 */
export async function saveBlobAsImageAsset(
  blob: Blob,
  explicitPath?: string,
  noteId?: string
): Promise<{ assetPath: string; dataUrl: string }> {
  const dataUrl = await blobToDataUrl(blob);
  if (!explicitPath) {
    const prefix = noteId ? `${noteId}::` : '';
    for (const [existingKey, existingData] of imageMemoryCache.entries()) {
      if (noteId && !existingKey.startsWith(prefix)) continue;
      if (!noteId && existingKey.includes('::')) continue;
      if (existingData === dataUrl) {
        const assetPath = noteId ? existingKey.slice(prefix.length) : existingKey;
        return { assetPath, dataUrl };
      }
    }
  }
  const ext = extFromMime(blob.type || 'image/png');
  const assetPath = explicitPath ? normalizeAssetPath(explicitPath) : generateAssetPath(ext);
  const cacheKey = makeScopedCacheKey(assetPath, noteId);
  imageMemoryCache.set(cacheKey, dataUrl);
  queuePersistAsset(cacheKey, dataUrl);
  return { assetPath, dataUrl };
}

/**
 * Saves any attached file (PDF, doc, etc.) into the note's asset cache & IndexedDB.
 */
export async function saveBlobAsFileAsset(
  blob: Blob,
  options?: { noteId?: string; filename?: string; explicitPath?: string }
): Promise<{ assetPath: string; dataUrl: string; fileName: string }> {
  const rawName =
    options?.filename ||
    (typeof File !== 'undefined' && blob instanceof File ? blob.name : '') ||
    `attachment.${extFromMime(blob.type || 'application/octet-stream')}`;
  const typedBlob =
    blob.type && blob.type !== 'application/octet-stream'
      ? blob
      : new Blob([blob], { type: mimeFromFilename(rawName) });
  const dataUrl = await blobToDataUrl(typedBlob);

  if (!options?.explicitPath) {
    const prefix = options?.noteId ? `${options.noteId}::` : '';
    for (const [existingKey, existingData] of imageMemoryCache.entries()) {
      if (options?.noteId && !existingKey.startsWith(prefix)) continue;
      if (!options?.noteId && existingKey.includes('::')) continue;
      if (existingData === dataUrl) {
        const assetPath = options?.noteId ? existingKey.slice(prefix.length) : existingKey;
        const fileName = assetPath.split('/').pop() || sanitizeAssetFilename(rawName);
        return { assetPath, dataUrl, fileName };
      }
    }
  }

  const assetPath = options?.explicitPath
    ? normalizeAssetPath(options.explicitPath)
    : generateFileAssetPath(rawName, dataUrl, options?.noteId);
  const cacheKey = makeScopedCacheKey(assetPath, options?.noteId);
  imageMemoryCache.set(cacheKey, dataUrl);
  queuePersistAsset(cacheKey, dataUrl);
  const fileName = assetPath.split('/').pop() || sanitizeAssetFilename(rawName);
  return { assetPath, dataUrl, fileName };
}

/**
 * Synchronously registers a data:image/... URL as a clean workspace asset path.
 */
export function registerDataUrlAssetSync(
  dataUrl: string,
  explicitPath?: string,
  noteId?: string
): string {
  if (!dataUrl.startsWith('data:image/')) return dataUrl;

  if (!explicitPath) {
    const prefix = noteId ? `${noteId}::` : '';
    for (const [existingKey, existingData] of imageMemoryCache.entries()) {
      if (noteId && !existingKey.startsWith(prefix)) continue;
      if (!noteId && existingKey.includes('::')) continue;
      if (existingData === dataUrl) {
        return noteId ? existingKey.slice(prefix.length) : existingKey;
      }
    }
  }

  const mimeMatch = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+)/i);
  const ext = extFromMime(mimeMatch ? mimeMatch[1] : 'image/png');
  const assetPath = explicitPath ? normalizeAssetPath(explicitPath) : generateAssetPath(ext);
  const cacheKey = makeScopedCacheKey(assetPath, noteId);
  imageMemoryCache.set(cacheKey, dataUrl);
  queuePersistAsset(cacheKey, dataUrl);
  return assetPath;
}

/**
 * Resolves a stored workspace/note asset path (e.g. `assets/img-xyz.png`) or external URL.
 */
export function resolveImageSrc(rawSrc: string, noteId?: string): string {
  if (!rawSrc) return '';
  const trimmed = rawSrc.trim();
  if (
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://')
  ) {
    return trimmed;
  }
  const normalized = normalizeAssetPath(trimmed);
  if (noteId) {
    const scoped = imageMemoryCache.get(makeScopedCacheKey(normalized, noteId));
    if (scoped) return scoped;
  }
  return imageMemoryCache.get(normalized) || imageMemoryCache.get(trimmed) || trimmed;
}

export function getCachedAssetDataUrl(assetPath: string, noteId?: string): string | undefined {
  const normalized = normalizeAssetPath(assetPath);
  if (noteId) {
    const scoped = imageMemoryCache.get(makeScopedCacheKey(normalized, noteId));
    if (scoped) return scoped;
  }
  return imageMemoryCache.get(normalized) || imageMemoryCache.get(assetPath);
}

/**
 * Creates a temporary Blob URL for viewing/downloading a stored asset (safe for PDFs in iframes/tabs).
 */
export function createAssetObjectUrl(rawSrc: string, noteId?: string): string | null {
  const dataUrl = getCachedAssetDataUrl(rawSrc, noteId);
  if (!dataUrl || !dataUrl.startsWith('data:')) return null;
  const blob = dataUrlToBlob(dataUrl);
  return URL.createObjectURL(blob);
}

/**
 * Hydrates all persisted workspace & per-note assets from IndexedDB into synchronous memory cache at startup.
 */
export async function hydrateImagesFromIdb(): Promise<void> {
  const keys = await kvGet<string[]>(ASSET_INDEX_KEY);
  if (!keys || keys.length === 0) return;

  await Promise.all(
    keys.map(async (cacheKey) => {
      if (imageMemoryCache.has(cacheKey)) return;
      const dataUrl =
        (await kvGet<string>(makeIdbStorageKey(cacheKey))) ||
        (await kvGet<string>(`${ASSET_KEY_PREFIX}${cacheKey}`));
      if (dataUrl) {
        imageMemoryCache.set(cacheKey, dataUrl);
      }
    })
  );
}

/**
 * Extracts all `assets/...` paths (both images `![...](assets/...)` and file links `[...](assets/...)`)
 * referenced in a Markdown body.
 */
export function extractReferencedAssetPaths(markdown: string): string[] {
  const found = new Set<string>();
  const regex = /!?\[[^\]]*\]\(([^)\n]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const norm = normalizeAssetPath(match[1]);
    if (norm.startsWith('assets/')) {
      found.add(norm);
    }
  }
  return Array.from(found);
}
