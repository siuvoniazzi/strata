const DB_NAME = 'strata-workspace-db';
const DB_VERSION = 1;
const STORE_KV = 'kv';
const ASSET_INDEX_KEY = 'imageAssetPaths';
const ASSET_KEY_PREFIX = 'img:';

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
  const assetMatch = trimmed.match(/(?:^|\/)(assets\/img-[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)$/);
  if (assetMatch) return assetMatch[1];
  return trimmed.replace(/^(?:\.\/|\.\.\/)+/, '');
}

function extFromMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('gif')) return 'gif';
  if (lower.includes('svg')) return 'svg';
  if (lower.includes('bmp')) return 'bmp';
  if (lower.includes('avif')) return 'avif';
  return 'png';
}

export function mimeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.avif')) return 'image/avif';
  return 'image/png';
}

function generateAssetPath(ext: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `assets/img-${stamp}-${rand}.${ext}`;
}

function queuePersistAsset(assetPath: string, dataUrl: string): void {
  persistQueue = persistQueue
    .then(async () => {
      await kvSet(`${ASSET_KEY_PREFIX}${assetPath}`, dataUrl);
      const existing = (await kvGet<string[]>(ASSET_INDEX_KEY)) || [];
      if (!existing.includes(assetPath)) {
        await kvSet(ASSET_INDEX_KEY, [...existing, assetPath]);
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
        reject(new Error('Failed to decode image blob'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read image blob'));
    reader.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) {
    return new Blob([], { type: 'image/png' });
  }
  const header = dataUrl.slice(0, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/^data:([^;]+)/i);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';

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
 * Saves a pasted or dropped image File/Blob into the workspace asset cache & IndexedDB.
 */
export async function saveBlobAsImageAsset(
  blob: Blob,
  explicitPath?: string
): Promise<{ assetPath: string; dataUrl: string }> {
  const dataUrl = await blobToDataUrl(blob);
  if (!explicitPath) {
    for (const [existingPath, existingData] of imageMemoryCache.entries()) {
      if (existingData === dataUrl) {
        return { assetPath: existingPath, dataUrl };
      }
    }
  }
  const ext = extFromMime(blob.type || 'image/png');
  const assetPath = explicitPath ? normalizeAssetPath(explicitPath) : generateAssetPath(ext);
  imageMemoryCache.set(assetPath, dataUrl);
  queuePersistAsset(assetPath, dataUrl);
  return { assetPath, dataUrl };
}

/**
 * Synchronously registers a data:image/... URL as a clean workspace asset path.
 */
export function registerDataUrlAssetSync(dataUrl: string, explicitPath?: string): string {
  if (!dataUrl.startsWith('data:image/')) return dataUrl;

  // Reuse existing asset path if identical dataUrl is already cached
  if (!explicitPath) {
    for (const [existingPath, existingData] of imageMemoryCache.entries()) {
      if (existingData === dataUrl) return existingPath;
    }
  }

  const mimeMatch = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+)/i);
  const ext = extFromMime(mimeMatch ? mimeMatch[1] : 'image/png');
  const assetPath = explicitPath ? normalizeAssetPath(explicitPath) : generateAssetPath(ext);
  imageMemoryCache.set(assetPath, dataUrl);
  queuePersistAsset(assetPath, dataUrl);
  return assetPath;
}

/**
 * Resolves a stored workspace asset path (e.g. `assets/img-xyz.png`) or external URL for <img> rendering.
 */
export function resolveImageSrc(rawSrc: string): string {
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
  return imageMemoryCache.get(normalized) || imageMemoryCache.get(trimmed) || trimmed;
}

export function getCachedAssetDataUrl(assetPath: string): string | undefined {
  const normalized = normalizeAssetPath(assetPath);
  return imageMemoryCache.get(normalized) || imageMemoryCache.get(assetPath);
}

/**
 * Hydrates all persisted workspace image assets from IndexedDB into synchronous memory cache at startup.
 */
export async function hydrateImagesFromIdb(): Promise<void> {
  const paths = await kvGet<string[]>(ASSET_INDEX_KEY);
  if (!paths || paths.length === 0) return;

  await Promise.all(
    paths.map(async (path) => {
      if (imageMemoryCache.has(path)) return;
      const dataUrl = await kvGet<string>(`${ASSET_KEY_PREFIX}${path}`);
      if (dataUrl) {
        imageMemoryCache.set(path, dataUrl);
      }
    })
  );
}

/**
 * Extracts all `assets/...` image paths referenced in a Markdown body.
 */
export function extractReferencedAssetPaths(markdown: string): string[] {
  const found = new Set<string>();
  const regex = /!\[[^\]]*\]\(([^)\n]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const norm = normalizeAssetPath(match[1]);
    if (norm.startsWith('assets/')) {
      found.add(norm);
    }
  }
  return Array.from(found);
}
