import JSZip from 'jszip';
import type { Note, WorkspaceDirectory } from '../types';
import {
  dataUrlToBlob,
  extractReferencedAssetPaths,
  getCachedAssetDataUrl,
  mimeFromFilename,
  saveBlobAsImageAsset,
} from './imageStore';
import { computeNoteFilePath, parseMarkdownToNote, serializeNoteToMarkdown } from './markdown';

const DB_NAME = 'strata-workspace-db';
const DB_VERSION = 1;
const STORE_KV = 'kv';

// Minimal Web File System Access API typing for Chromium browsers
export interface FsWritable {
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
}

export interface FsFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FsWritable>;
}

export interface FsDirectoryHandle {
  kind: 'directory';
  name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, FsFileHandle | FsDirectoryHandle]>;
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FsDirectoryHandle>;
  }
}

const memoryStore = new Map<string, unknown>();

function openDb(): Promise<IDBDatabase> {
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

export async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readonly');
      const req = tx.objectStore(STORE_KV).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return memoryStore.get(key) as T | undefined;
  }
}

export async function idbSet<T>(key: string, value: T): Promise<void> {
  memoryStore.set(key, value);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      tx.objectStore(STORE_KV).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Fallback to memoryStore in restricted iframe sandboxes
  }
}

export function isFolderSyncSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function pickSyncDirectory(): Promise<FsDirectoryHandle | null> {
  if (!window.showDirectoryPicker) return null;
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await idbSet('syncDirHandle', handle);
  return handle;
}

export async function loadPersistedDirHandle(): Promise<{
  handle: FsDirectoryHandle | null;
  permission: 'granted' | 'prompt' | 'denied';
}> {
  try {
    const handle = await idbGet<FsDirectoryHandle>('syncDirHandle');
    if (!handle) return { handle: null, permission: 'denied' };
    const perm = handle.queryPermission ? await handle.queryPermission({ mode: 'readwrite' }) : 'granted';
    return { handle, permission: perm };
  } catch {
    return { handle: null, permission: 'denied' };
  }
}

export async function requestHandlePermission(handle: FsDirectoryHandle): Promise<boolean> {
  if (!handle.requestPermission) return true;
  const res = await handle.requestPermission({ mode: 'readwrite' });
  return res === 'granted';
}

async function ensureNestedFile(root: FsDirectoryHandle, relativePath: string): Promise<FsFileHandle> {
  const parts = relativePath.split('/').filter(Boolean);
  const fileName = parts.pop()!;
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir.getFileHandle(fileName, { create: true });
}

export async function removeNestedFileIfExists(root: FsDirectoryHandle, relativePath?: string): Promise<void> {
  if (!relativePath) return;
  try {
    const parts = relativePath.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) return;
    let dir = root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: false });
    }
    await dir.removeEntry(fileName);
  } catch {
    // Ignore if file was already moved/deleted
  }
}

export async function writeNoteToFolder(
  root: FsDirectoryHandle,
  note: Note,
  directory: WorkspaceDirectory,
  previousPath?: string
): Promise<string> {
  const nextPath = computeNoteFilePath(note, directory);
  if (previousPath && previousPath !== nextPath) {
    await removeNestedFileIfExists(root, previousPath);
  }
  const fileHandle = await ensureNestedFile(root, nextPath);
  const writable = await fileHandle.createWritable();
  await writable.write(serializeNoteToMarkdown(note, directory));
  await writable.close();

  // Persist any referenced pasted images into root/assets/...
  const referencedAssets = extractReferencedAssetPaths(note.body);
  for (const assetPath of referencedAssets) {
    const dataUrl = getCachedAssetDataUrl(assetPath);
    if (!dataUrl) continue;
    try {
      const assetHandle = await ensureNestedFile(root, assetPath);
      const assetWritable = await assetHandle.createWritable();
      await assetWritable.write(dataUrlToBlob(dataUrl));
      await assetWritable.close();
    } catch {
      // Ignore individual asset sync error
    }
  }

  return nextPath;
}

export async function writeDirectoryMetadata(
  root: FsDirectoryHandle,
  directory: WorkspaceDirectory
): Promise<void> {
  const fileHandle = await ensureNestedFile(root, '_strata/directory.json');
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(directory, null, 2));
  await writable.close();
}

async function walkMarkdownFiles(
  dir: FsDirectoryHandle,
  prefix = ''
): Promise<Array<{ path: string; text: string }>> {
  const results: Array<{ path: string; text: string }> = [];
  for await (const [name, entry] of dir.entries()) {
    if (name.startsWith('.') || name === '_strata' || name === 'assets' || name === 'node_modules') continue;
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'directory') {
      const sub = await walkMarkdownFiles(entry, relPath);
      results.push(...sub);
    } else if (entry.kind === 'file' && name.toLowerCase().endsWith('.md')) {
      const file = await entry.getFile();
      const text = await file.text();
      results.push({ path: relPath, text });
    }
  }
  return results;
}

/**
 * Performs a two-way sync between in-memory workspace and a connected local/OneDrive folder:
 * - Reads _strata/directory.json if present and merges directory entities
 * - Hydrates any image files inside assets/
 * - Reads any .md files created or updated on disk
 * - Writes all workspace notes & assets to disk in Inbox/ | Internal/ | Clients/ | assets/
 */
export async function syncWorkspaceWithFolder(
  root: FsDirectoryHandle,
  currentNotes: Note[],
  currentDirectory: WorkspaceDirectory
): Promise<{ notes: Note[]; directory: WorkspaceDirectory }> {
  let mergedDirectory: WorkspaceDirectory = {
    clients: [...currentDirectory.clients],
    projects: [...currentDirectory.projects],
    people: [...currentDirectory.people],
    customLabels: [...currentDirectory.customLabels],
  };

  // 1. Merge directory metadata from _strata/directory.json if it exists
  try {
    const strataDir = await root.getDirectoryHandle('_strata', { create: false });
    const dirFile = await strataDir.getFileHandle('directory.json', { create: false });
    const raw = await (await dirFile.getFile()).text();
    const diskDir = JSON.parse(raw) as Partial<WorkspaceDirectory>;
    if (diskDir.clients) {
      for (const c of diskDir.clients) {
        if (!mergedDirectory.clients.some((x) => x.id === c.id || x.name.toLowerCase() === c.name.toLowerCase())) {
          mergedDirectory.clients.push(c);
        }
      }
    }
    if (diskDir.projects) {
      for (const p of diskDir.projects) {
        if (!mergedDirectory.projects.some((x) => x.id === p.id)) {
          mergedDirectory.projects.push(p);
        }
      }
    }
    if (diskDir.people) {
      for (const p of diskDir.people) {
        if (!mergedDirectory.people.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) {
          mergedDirectory.people.push(p);
        }
      }
    }
  } catch {
    // First time initializing folder
  }

  // 1b. Read any image files from root/assets/ into memory & IndexedDB cache
  try {
    const assetsDir = await root.getDirectoryHandle('assets', { create: false });
    for await (const [name, entry] of assetsDir.entries()) {
      if (entry.kind === 'file' && /\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i.test(name)) {
        const file = await entry.getFile();
        await saveBlobAsImageAsset(file, `assets/${name}`);
      }
    }
  } catch {
    // No assets folder on disk yet
  }

  // 2. Read all .md files on disk
  const diskFiles = await walkMarkdownFiles(root);
  const byId = new Map<string, Note>();
  for (const n of currentNotes) {
    byId.set(n.id, n);
  }

  for (const df of diskFiles) {
    const parsed = parseMarkdownToNote(df.text, df.path, mergedDirectory);
    mergedDirectory = {
      ...mergedDirectory,
      clients: [...mergedDirectory.clients, ...parsed.newClients],
      projects: [...mergedDirectory.projects, ...parsed.newProjects],
      people: [...mergedDirectory.people, ...parsed.newPeople],
    };

    const existing = byId.get(parsed.note.id);
    if (!existing || new Date(parsed.note.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
      byId.set(parsed.note.id, parsed.note);
    }
  }

  // 3. Write merged state back cleanly so disk and memory match 100%
  const syncedNotes: Note[] = [];
  for (const note of byId.values()) {
    const filePath = await writeNoteToFolder(root, note, mergedDirectory, note.filePath);
    syncedNotes.push({ ...note, filePath });
  }
  await writeDirectoryMetadata(root, mergedDirectory);

  syncedNotes.sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
  return { notes: syncedNotes, directory: mergedDirectory };
}

/**
 * Exports the entire workspace (including pasted note images) as a clean .zip mirroring the OneDrive folder layout.
 */
export async function exportWorkspaceZip(notes: Note[], directory: WorkspaceDirectory): Promise<void> {
  const zip = new JSZip();
  zip.file('_strata/directory.json', JSON.stringify(directory, null, 2));
  const bundledAssets = new Set<string>();

  for (const note of notes) {
    const path = computeNoteFilePath(note, directory);
    zip.file(path, serializeNoteToMarkdown(note, directory));

    for (const assetPath of extractReferencedAssetPaths(note.body)) {
      if (bundledAssets.has(assetPath)) continue;
      const dataUrl = getCachedAssetDataUrl(assetPath);
      if (dataUrl) {
        zip.file(assetPath, dataUrlToBlob(dataUrl));
        bundledAssets.add(assetPath);
      }
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `strata-workspace-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Imports either .md files or a .zip workspace archive (including assets/ images).
 */
export async function importFilesIntoWorkspace(
  files: FileList,
  currentNotes: Note[],
  currentDirectory: WorkspaceDirectory
): Promise<{ notes: Note[]; directory: WorkspaceDirectory; importedCount: number }> {
  let directory = {
    clients: [...currentDirectory.clients],
    projects: [...currentDirectory.projects],
    people: [...currentDirectory.people],
    customLabels: [...currentDirectory.customLabels],
  };
  const byId = new Map(currentNotes.map((n) => [n.id, n]));
  let importedCount = 0;

  // First register any loose image assets if selected alongside .md files
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/') && /^img-/i.test(file.name)) {
      await saveBlobAsImageAsset(file, `assets/${file.name}`);
    }
  }

  for (const file of Array.from(files)) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      const zip = await JSZip.loadAsync(file);
      const dirEntry = zip.file('_strata/directory.json');
      if (dirEntry) {
        try {
          const parsedDir = JSON.parse(await dirEntry.async('string')) as Partial<WorkspaceDirectory>;
          if (parsedDir.clients) {
            for (const c of parsedDir.clients) {
              if (!directory.clients.some((x) => x.id === c.id)) directory.clients.push(c);
            }
          }
          if (parsedDir.projects) {
            for (const p of parsedDir.projects) {
              if (!directory.projects.some((x) => x.id === p.id)) directory.projects.push(p);
            }
          }
          if (parsedDir.people) {
            for (const p of parsedDir.people) {
              if (!directory.people.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) directory.people.push(p);
            }
          }
        } catch {
          // Ignore malformed metadata
        }
      }

      // Hydrate image assets from zip BEFORE parsing markdown notes
      for (const [relPath, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        const assetMatch = relPath.match(/(?:^|\/)(assets\/[^/]+\.(?:png|jpe?g|webp|gif|svg|bmp|avif))$/i);
        if (assetMatch) {
          const rawBlob = await entry.async('blob');
          const typedBlob = new Blob([rawBlob], { type: mimeFromFilename(assetMatch[1]) });
          await saveBlobAsImageAsset(typedBlob, assetMatch[1]);
        }
      }

      for (const [relPath, entry] of Object.entries(zip.files)) {
        if (entry.dir || !relPath.toLowerCase().endsWith('.md')) continue;
        const mdText = await entry.async('string');
        const parsed = parseMarkdownToNote(mdText, relPath, directory);
        directory = {
          ...directory,
          clients: [...directory.clients, ...parsed.newClients],
          projects: [...directory.projects, ...parsed.newProjects],
          people: [...directory.people, ...parsed.newPeople],
        };
        byId.set(parsed.note.id, parsed.note);
        importedCount++;
      }
    } else if (file.name.toLowerCase().endsWith('.md')) {
      const mdText = await file.text();
      const parsed = parseMarkdownToNote(mdText, `Inbox/${file.name}`, directory);
      directory = {
        ...directory,
        clients: [...directory.clients, ...parsed.newClients],
        projects: [...directory.projects, ...parsed.newProjects],
        people: [...directory.people, ...parsed.newPeople],
      };
      byId.set(parsed.note.id, parsed.note);
      importedCount++;
    }
  }

  const notes = Array.from(byId.values()).sort(
    (a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)
  );
  return { notes, directory, importedCount };
}
