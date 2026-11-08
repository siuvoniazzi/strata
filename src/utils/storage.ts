import JSZip from 'jszip';
import type { Client, Note, Person, Project, SyncTombstones, WorkspaceDirectory } from '../types';
import {
  dataUrlToBlob,
  extractReferencedAssetPaths,
  getCachedAssetDataUrl,
  mimeFromFilename,
  saveBlobAsImageAsset,
} from './imageStore';
import {
  computeNoteFilePath,
  folderSegment,
  normalizeLabel,
  parseMarkdownToNote,
  serializeNoteToMarkdown,
} from './markdown';

const DB_NAME = 'strata-workspace-db';
const DB_VERSION = 1;
const STORE_KV = 'kv';

// Minimal Web File System Access API typing for Chromium browsers + Virtual Cloud Handles
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
  /** Optional hook for cloud handles (e.g. Google Drive) to prefetch metadata before batch sync */
  prepareSyncSession?: () => Promise<void>;
  /** Optional identifier for cloud-backed directory handles */
  providerKind?: 'local' | 'gdrive';
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FsDirectoryHandle>;
  }
}

export interface DiskDirectoryMetadata extends WorkspaceDirectory {
  workspaceId?: string;
  lastSyncedAt?: string;
  tombstones?: Partial<SyncTombstones>;
  syncedNoteIds?: string[];
}

export function createEmptyTombstones(): SyncTombstones {
  return {
    notes: {},
    clients: {},
    projects: {},
    people: {},
  };
}

const memoryStore = new Map<string, unknown>();

// Serialized async queue so concurrent edits / syncs never race on disk or Google Drive
let syncQueuePromise: Promise<unknown> = Promise.resolve();

export function enqueueStorageTask<T>(task: () => Promise<T>): Promise<T> {
  const next = syncQueuePromise.then(task, task);
  syncQueuePromise = next.catch(() => {});
  return next;
}

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

export async function loadSyncTombstones(): Promise<SyncTombstones> {
  const saved = await idbGet<Partial<SyncTombstones>>('syncTombstones');
  return {
    notes: { ...(saved?.notes || {}) },
    clients: { ...(saved?.clients || {}) },
    projects: { ...(saved?.projects || {}) },
    people: { ...(saved?.people || {}) },
  };
}

export async function saveSyncTombstones(tombstones: SyncTombstones): Promise<void> {
  await idbSet('syncTombstones', tombstones);
}

export function mergeTombstones(
  a?: Partial<SyncTombstones> | null,
  b?: Partial<SyncTombstones> | null
): SyncTombstones {
  const result = createEmptyTombstones();
  const keys: Array<keyof SyncTombstones> = ['notes', 'clients', 'projects', 'people'];
  for (const k of keys) {
    const mapA = a?.[k] || {};
    const mapB = b?.[k] || {};
    for (const [id, ts] of Object.entries(mapA)) {
      if (ts) result[k][id] = ts;
    }
    for (const [id, ts] of Object.entries(mapB)) {
      if (!ts) continue;
      const existing = result[k][id];
      if (!existing || ts > existing) {
        result[k][id] = ts;
      }
    }
  }
  return result;
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

/**
 * Safely resolves a child directory handle without triggering duplicate folder creation
 * on Android SAF / Google Drive virtual filesystems.
 */
async function getSafeDirectoryHandle(
  parent: FsDirectoryHandle,
  name: string,
  create: boolean
): Promise<FsDirectoryHandle> {
  // 1. Check existing entries first (prevents Android SAF / Drive from creating "Folder (1)")
  try {
    let caseInsensitiveMatch: FsDirectoryHandle | null = null;
    for await (const [entryName, entry] of parent.entries()) {
      if (entry.kind !== 'directory') continue;
      if (entryName === name) {
        return entry;
      }
      if (!caseInsensitiveMatch && entryName.toLowerCase() === name.toLowerCase()) {
        caseInsensitiveMatch = entry;
      }
    }
    if (caseInsensitiveMatch) {
      return caseInsensitiveMatch;
    }
  } catch {
    // Fallback to getDirectoryHandle
  }

  // 2. Try non-creating lookup
  try {
    return await parent.getDirectoryHandle(name, { create: false });
  } catch {
    if (!create) {
      throw new Error(`Directory "${name}" not found`);
    }
  }

  // 3. Create only when confirmed absent
  return parent.getDirectoryHandle(name, { create: true });
}

/**
 * Safely resolves a child file handle without triggering duplicate file creation
 * on Android SAF / Google Drive virtual filesystems.
 */
async function getSafeFileHandle(
  parent: FsDirectoryHandle,
  name: string,
  create: boolean
): Promise<FsFileHandle> {
  try {
    let caseInsensitiveMatch: FsFileHandle | null = null;
    for await (const [entryName, entry] of parent.entries()) {
      if (entry.kind !== 'file') continue;
      if (entryName === name) {
        return entry;
      }
      if (!caseInsensitiveMatch && entryName.toLowerCase() === name.toLowerCase()) {
        caseInsensitiveMatch = entry;
      }
    }
    if (caseInsensitiveMatch) {
      return caseInsensitiveMatch;
    }
  } catch {
    // Fallback to getFileHandle
  }

  try {
    return await parent.getFileHandle(name, { create: false });
  } catch {
    if (!create) {
      throw new Error(`File "${name}" not found`);
    }
  }

  return parent.getFileHandle(name, { create: true });
}

/**
 * If a user on phone/laptop selects the parent folder of an existing Strata workspace
 * (e.g. selecting "My Drive" when "My Drive/Strata/_strata/directory.json" already exists),
 * automatically resolve to that existing workspace folder instead of creating a second workspace.
 */
export async function resolveEffectiveWorkspaceRoot(
  root: FsDirectoryHandle
): Promise<FsDirectoryHandle> {
  try {
    // Check if root itself already has _strata or standard Strata folders
    const topDirs: Array<[string, FsDirectoryHandle]> = [];
    let hasStrataMarker = false;
    let hasRootMarkdown = false;

    for await (const [name, entry] of root.entries()) {
      if (entry.kind === 'directory') {
        const lower = name.toLowerCase();
        if (lower === '_strata' || lower === 'inbox' || lower === 'clients' || lower === 'internal') {
          hasStrataMarker = true;
        } else if (!name.startsWith('.')) {
          topDirs.push([name, entry]);
        }
      } else if (entry.kind === 'file' && name.toLowerCase().endsWith('.md')) {
        hasRootMarkdown = true;
      }
    }

    if (hasStrataMarker || hasRootMarkdown) {
      return root;
    }

    // Check immediate subdirectories to see if one of them is already a Strata workspace
    const candidateWorkspaces: FsDirectoryHandle[] = [];
    for (const [dirName, dirHandle] of topDirs) {
      try {
        const strataSub = await getSafeDirectoryHandle(dirHandle, '_strata', false);
        await getSafeFileHandle(strataSub, 'directory.json', false);
        if (/strata/i.test(dirName)) {
          return dirHandle;
        }
        candidateWorkspaces.push(dirHandle);
      } catch {
        // Not a Strata workspace root
      }
    }

    if (candidateWorkspaces.length === 1) {
      return candidateWorkspaces[0];
    }
  } catch {
    // Ignore and use root as-is
  }
  return root;
}

async function ensureNestedFile(root: FsDirectoryHandle, relativePath: string): Promise<FsFileHandle> {
  const parts = relativePath.split('/').filter(Boolean);
  const fileName = parts.pop()!;
  let dir = root;
  for (const part of parts) {
    dir = await getSafeDirectoryHandle(dir, part, true);
  }
  return getSafeFileHandle(dir, fileName, true);
}

async function fileExistsInFolder(root: FsDirectoryHandle, relativePath: string): Promise<boolean> {
  try {
    const parts = relativePath.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) return false;
    let dir = root;
    for (const part of parts) {
      dir = await getSafeDirectoryHandle(dir, part, false);
    }
    await getSafeFileHandle(dir, fileName, false);
    return true;
  } catch {
    return false;
  }
}

export async function removeNestedFileIfExists(root: FsDirectoryHandle, relativePath?: string): Promise<void> {
  if (!relativePath) return;
  try {
    const parts = relativePath.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) return;
    let dir = root;
    for (const part of parts) {
      dir = await getSafeDirectoryHandle(dir, part, false);
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
  previousPath?: string,
  options?: { skipIfContentMatches?: string }
): Promise<string> {
  const nextPath = computeNoteFilePath(note, directory);
  if (previousPath && previousPath !== nextPath) {
    await removeNestedFileIfExists(root, previousPath);
  }

  const serialized = serializeNoteToMarkdown(note, directory);
  const normalizeEol = (s: string) => s.replace(/\r\n?/g, '\n').trimEnd();

  if (
    options?.skipIfContentMatches === undefined ||
    normalizeEol(options.skipIfContentMatches) !== normalizeEol(serialized)
  ) {
    const fileHandle = await ensureNestedFile(root, nextPath);
    const writable = await fileHandle.createWritable();
    await writable.write(serialized);
    await writable.close();
  }

  // Persist any referenced pasted images into root/assets/... (skip if already on disk)
  const referencedAssets = extractReferencedAssetPaths(note.body);
  for (const assetPath of referencedAssets) {
    const dataUrl = getCachedAssetDataUrl(assetPath);
    if (!dataUrl) continue;
    try {
      const alreadyExists = await fileExistsInFolder(root, assetPath);
      if (!alreadyExists) {
        const assetHandle = await ensureNestedFile(root, assetPath);
        const assetWritable = await assetHandle.createWritable();
        await assetWritable.write(dataUrlToBlob(dataUrl));
        await assetWritable.close();
      }
    } catch {
      // Ignore individual asset sync error
    }
  }

  return nextPath;
}

export async function writeDirectoryMetadata(
  root: FsDirectoryHandle,
  directory: WorkspaceDirectory,
  extra?: {
    tombstones?: SyncTombstones;
    syncedNoteIds?: string[];
    existingRawJson?: string | null;
  }
): Promise<void> {
  const payload: DiskDirectoryMetadata = {
    clients: directory.clients,
    projects: directory.projects,
    people: directory.people,
    customLabels: directory.customLabels,
    tombstones: extra?.tombstones,
    syncedNoteIds: extra?.syncedNoteIds,
    lastSyncedAt: new Date().toISOString(),
  };

  if (extra?.existingRawJson) {
    try {
      const prev = JSON.parse(extra.existingRawJson) as Partial<DiskDirectoryMetadata>;
      const prevComparable = JSON.stringify({
        clients: prev.clients || [],
        projects: prev.projects || [],
        people: prev.people || [],
        customLabels: prev.customLabels || [],
        tombstones: prev.tombstones || {},
        syncedNoteIds: prev.syncedNoteIds || [],
      });
      const nextComparable = JSON.stringify({
        clients: payload.clients,
        projects: payload.projects,
        people: payload.people,
        customLabels: payload.customLabels,
        tombstones: payload.tombstones || {},
        syncedNoteIds: payload.syncedNoteIds || [],
      });
      if (prevComparable === nextComparable) {
        return;
      }
    } catch {
      // Proceed with write
    }
  }

  const fileHandle = await ensureNestedFile(root, '_strata/directory.json');
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(payload, null, 2));
  await writable.close();
}

interface DiskMarkdownEntry {
  path: string;
  text: string;
  lastModified: number;
}

async function walkMarkdownFiles(
  dir: FsDirectoryHandle,
  prefix = ''
): Promise<DiskMarkdownEntry[]> {
  const results: DiskMarkdownEntry[] = [];
  for await (const [name, entry] of dir.entries()) {
    const cleanName = name.replace(/\s*\(\d+\)$/, '').toLowerCase();
    if (
      name.startsWith('.') ||
      cleanName === '_strata' ||
      cleanName === 'assets' ||
      cleanName === 'node_modules'
    ) {
      continue;
    }
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'directory') {
      const sub = await walkMarkdownFiles(entry, relPath);
      results.push(...sub);
    } else if (entry.kind === 'file' && /\.md$/i.test(name)) {
      const file = await entry.getFile();
      const text = await file.text();
      results.push({ path: relPath, text, lastModified: file.lastModified });
    }
  }
  return results;
}

/**
 * Reads _strata/directory.json and any conflict copies (e.g. _strata/directory (1).json or _strata (1)/directory.json)
 */
async function readAllDiskDirectoryMetadata(root: FsDirectoryHandle): Promise<{
  configs: Array<Partial<DiskDirectoryMetadata>>;
  primaryRawJson: string | null;
  conflictPathsToClean: string[];
}> {
  const configs: Array<Partial<DiskDirectoryMetadata>> = [];
  let primaryRawJson: string | null = null;
  const conflictPathsToClean: string[] = [];

  try {
    for await (const [dirName, dirEntry] of root.entries()) {
      if (dirEntry.kind !== 'directory') continue;
      if (!/^_strata(?:\s*\(\d+\))?$/i.test(dirName)) continue;

      const isConflictDir = dirName !== '_strata';
      for await (const [fileName, fileEntry] of dirEntry.entries()) {
        if (fileEntry.kind !== 'file' || !fileName.toLowerCase().endsWith('.json')) continue;
        if (!/^directory/i.test(fileName)) continue;

        try {
          const raw = await (await fileEntry.getFile()).text();
          const parsed = JSON.parse(raw) as Partial<DiskDirectoryMetadata>;
          configs.push(parsed);
          if (!isConflictDir && fileName === 'directory.json') {
            primaryRawJson = raw;
          } else {
            conflictPathsToClean.push(`${dirName}/${fileName}`);
          }
        } catch {
          // Ignore malformed conflict file
        }
      }
    }
  } catch {
    // No _strata folder on disk yet
  }

  return { configs, primaryRawJson, conflictPathsToClean };
}

/**
 * Performs a multi-device two-way sync between in-memory workspace and a connected Local / Google Drive folder:
 * - Resolves nested workspace roots if the user picked a parent folder
 * - Reads _strata/directory.json (and any cloud conflict copies) and merges directory entities + deletion tombstones
 * - Reconciles Client & Project IDs across devices so duplicate folders / Unassigned-Client never occur
 * - Hydrates any image files inside assets/
 * - Reads all .md files created or updated on disk (using both frontmatter updatedAt and file lastModified)
 * - Cleans up duplicate / renamed / conflict (1).md files and writes only changed files to disk
 */
export async function syncWorkspaceWithFolder(
  rawRoot: FsDirectoryHandle,
  currentNotes: Note[],
  currentDirectory: WorkspaceDirectory,
  localTombstones?: SyncTombstones
): Promise<{
  notes: Note[];
  directory: WorkspaceDirectory;
  tombstones: SyncTombstones;
  effectiveRoot: FsDirectoryHandle;
}> {
  return enqueueStorageTask(async () => {
    if (rawRoot.prepareSyncSession) {
      await rawRoot.prepareSyncSession();
    }

    const root = await resolveEffectiveWorkspaceRoot(rawRoot);
    const baseTombstones = localTombstones || (await loadSyncTombstones());

    // 1. Read _strata/directory.json (including any conflict copies)
    const { configs: diskConfigs, primaryRawJson, conflictPathsToClean } =
      await readAllDiskDirectoryMetadata(root);

    let mergedTombstones = mergeTombstones(baseTombstones, null);
    const previouslySyncedOnDisk = new Set<string>();
    let hadDiskMetadata = diskConfigs.length > 0;

    for (const cfg of diskConfigs) {
      mergedTombstones = mergeTombstones(mergedTombstones, cfg.tombstones);
      if (Array.isArray(cfg.syncedNoteIds)) {
        for (const id of cfg.syncedNoteIds) previouslySyncedOnDisk.add(id);
      }
    }

    // 2. Reconcile Clients with canonical ID mapping (preferring disk IDs so all devices converge)
    const clientIdMap = new Map<string, string>();
    const canonicalClients: Client[] = [];

    const registerClient = (c: Client) => {
      if (mergedTombstones.clients[c.id]) return;
      const existing = canonicalClients.find(
        (x) =>
          x.id === c.id ||
          x.name.toLowerCase() === c.name.toLowerCase() ||
          folderSegment(x.name).toLowerCase() === folderSegment(c.name).toLowerCase()
      );
      if (existing) {
        clientIdMap.set(c.id, existing.id);
        if (!existing.domain && c.domain) existing.domain = c.domain;
        if (!existing.industry && c.industry) existing.industry = c.industry;
      } else {
        canonicalClients.push({ ...c });
        clientIdMap.set(c.id, c.id);
      }
    };

    for (const cfg of diskConfigs) {
      for (const c of cfg.clients || []) registerClient(c);
    }
    for (const c of currentDirectory.clients) {
      registerClient(c);
    }

    // 3. Reconcile Projects with canonical ID mapping (after remapping clientId)
    const projectIdMap = new Map<string, string>();
    const canonicalProjects: Project[] = [];

    const registerProject = (p: Project) => {
      if (mergedTombstones.projects[p.id]) return;
      const mappedClientId = p.clientId ? clientIdMap.get(p.clientId) || p.clientId : null;
      if (mappedClientId && mergedTombstones.clients[mappedClientId]) return;

      const existing = canonicalProjects.find(
        (x) =>
          x.id === p.id ||
          ((x.name.toLowerCase() === p.name.toLowerCase() ||
            folderSegment(x.name).toLowerCase() === folderSegment(p.name).toLowerCase()) &&
            x.clientId === mappedClientId)
      );
      if (existing) {
        projectIdMap.set(p.id, existing.id);
      } else {
        const cleanProj: Project = {
          ...p,
          clientId: mappedClientId,
          scope: mappedClientId ? 'client' : 'internal',
        };
        canonicalProjects.push(cleanProj);
        projectIdMap.set(p.id, cleanProj.id);
      }
    };

    for (const cfg of diskConfigs) {
      for (const p of cfg.projects || []) registerProject(p);
    }
    for (const p of currentDirectory.projects) {
      registerProject(p);
    }

    // 4. Reconcile People & Custom Labels
    const canonicalPeople: Person[] = [];
    const registerPerson = (p: Person) => {
      const lower = p.name.trim().toLowerCase();
      if (!lower || mergedTombstones.people[lower]) return;
      const mappedClientId = p.clientId ? clientIdMap.get(p.clientId) || p.clientId : null;
      const existing = canonicalPeople.find((x) => x.name.toLowerCase() === lower);
      if (existing) {
        if (!existing.email && p.email) existing.email = p.email;
        if (!existing.role && p.role) existing.role = p.role;
        if (!existing.clientId && mappedClientId) existing.clientId = mappedClientId;
      } else {
        canonicalPeople.push({
          ...p,
          clientId: mappedClientId,
        });
      }
    };

    for (const cfg of diskConfigs) {
      for (const p of cfg.people || []) registerPerson(p);
    }
    for (const p of currentDirectory.people) {
      registerPerson(p);
    }

    const customLabelSet = new Set<string>();
    for (const cfg of diskConfigs) {
      for (const lbl of cfg.customLabels || []) {
        const norm = normalizeLabel(lbl);
        if (norm) customLabelSet.add(norm);
      }
    }
    for (const lbl of currentDirectory.customLabels) {
      const norm = normalizeLabel(lbl);
      if (norm) customLabelSet.add(norm);
    }

    let mergedDirectory: WorkspaceDirectory = {
      clients: canonicalClients,
      projects: canonicalProjects,
      people: canonicalPeople,
      customLabels: Array.from(customLabelSet),
    };

    // 5. Hydrate image assets from root/assets/ (and any assets (1)/ conflict folders)
    try {
      for await (const [dirName, dirEntry] of root.entries()) {
        if (dirEntry.kind !== 'directory' || !/^assets(?:\s*\(\d+\))?$/i.test(dirName)) continue;
        for await (const [name, entry] of dirEntry.entries()) {
          if (entry.kind === 'file' && /\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i.test(name)) {
            const cleanAssetName = name.replace(/\s*\(\d+\)(\.[a-z0-9]+)$/i, '$1');
            const assetKey = `assets/${cleanAssetName}`;
            if (!getCachedAssetDataUrl(assetKey)) {
              const file = await entry.getFile();
              await saveBlobAsImageAsset(file, assetKey);
            }
          }
        }
      }
    } catch {
      // No assets folder on disk yet
    }

    // 6. Read all .md files on disk
    const diskFiles = await walkMarkdownFiles(root);
    if (diskFiles.length > 0) {
      hadDiskMetadata = true;
    }

    const diskPathsByNoteId = new Map<string, Array<{ path: string; text: string }>>();
    const diskNotesById = new Map<string, Note>();

    for (const df of diskFiles) {
      const parsed = parseMarkdownToNote(df.text, df.path, mergedDirectory, df.lastModified);

      for (const nc of parsed.newClients) registerClient(nc);
      for (const np of parsed.newProjects) registerProject(np);
      for (const npe of parsed.newPeople) registerPerson(npe);

      mergedDirectory = {
        clients: canonicalClients,
        projects: canonicalProjects,
        people: canonicalPeople,
        customLabels: mergedDirectory.customLabels,
      };

      const mappedClientId = parsed.note.clientId
        ? clientIdMap.get(parsed.note.clientId) || parsed.note.clientId
        : null;
      const mappedProjectId = parsed.note.projectId
        ? projectIdMap.get(parsed.note.projectId) || parsed.note.projectId
        : null;

      const normalizedDiskNote: Note = {
        ...parsed.note,
        clientId: mappedClientId,
        projectId: mappedProjectId,
        scope: mappedClientId ? 'client' : parsed.note.scope,
      };

      const existingPaths = diskPathsByNoteId.get(normalizedDiskNote.id) || [];
      existingPaths.push({ path: df.path, text: df.text });
      diskPathsByNoteId.set(normalizedDiskNote.id, existingPaths);

      // Check tombstone
      const deletedAt = mergedTombstones.notes[normalizedDiskNote.id];
      if (deletedAt && new Date(deletedAt).getTime() >= new Date(normalizedDiskNote.updatedAt).getTime()) {
        continue;
      }

      const prevDiskNote = diskNotesById.get(normalizedDiskNote.id);
      if (!prevDiskNote) {
        diskNotesById.set(normalizedDiskNote.id, normalizedDiskNote);
      } else {
        // Prefer the newer timestamp, or non-conflict filename if timestamps are identical
        const prevTime = new Date(prevDiskNote.updatedAt).getTime() || 0;
        const nextTime = new Date(normalizedDiskNote.updatedAt).getTime() || 0;
        const nextIsConflict = /\(\d+\)\.md$/i.test(df.path);
        if (nextTime > prevTime || (nextTime === prevTime && !nextIsConflict)) {
          diskNotesById.set(normalizedDiskNote.id, normalizedDiskNote);
        }
      }
    }

    // 7. Reconcile in-memory notes with disk notes
    const byId = new Map<string, Note>();

    for (const rawMemNote of currentNotes) {
      const mappedClientId = rawMemNote.clientId
        ? clientIdMap.get(rawMemNote.clientId) || rawMemNote.clientId
        : null;
      const mappedProjectId = rawMemNote.projectId
        ? projectIdMap.get(rawMemNote.projectId) || rawMemNote.projectId
        : null;

      const memNote: Note = {
        ...rawMemNote,
        clientId: mappedClientId,
        projectId: mappedProjectId,
        scope: mappedClientId ? 'client' : rawMemNote.scope,
      };

      const deletedAt = mergedTombstones.notes[memNote.id];
      if (deletedAt && new Date(deletedAt).getTime() >= new Date(memNote.updatedAt).getTime()) {
        continue;
      }

      // If this note was previously synced to disk, and is now missing from disk while disk has metadata,
      // check if it was deleted on another device that didn't write a tombstone (e.g. deleted in Google Drive UI)
      if (
        hadDiskMetadata &&
        !diskNotesById.has(memNote.id) &&
        previouslySyncedOnDisk.has(memNote.id)
      ) {
        mergedTombstones.notes[memNote.id] = new Date().toISOString();
        continue;
      }

      byId.set(memNote.id, memNote);
    }

    for (const [noteId, diskNote] of diskNotesById.entries()) {
      const existingMem = byId.get(noteId);
      if (!existingMem) {
        byId.set(noteId, diskNote);
      } else {
        const diskTime = new Date(diskNote.updatedAt).getTime() || 0;
        const memTime = new Date(existingMem.updatedAt).getTime() || 0;
        if (diskTime >= memTime) {
          byId.set(noteId, diskNote);
        }
      }
    }

    // 8. Clean up any tombstoned files or conflict metadata files still lingering on disk
    for (const [noteId, paths] of diskPathsByNoteId.entries()) {
      if (!byId.has(noteId)) {
        for (const p of paths) {
          await removeNestedFileIfExists(root, p.path);
        }
      }
    }
    for (const conflictMetaPath of conflictPathsToClean) {
      await removeNestedFileIfExists(root, conflictMetaPath);
    }

    // 9. Write new or changed notes to canonical paths & delete duplicate/renamed old paths
    const syncedNotes: Note[] = [];
    for (const note of byId.values()) {
      const canonicalPath = computeNoteFilePath(note, mergedDirectory);
      const diskEntries = diskPathsByNoteId.get(note.id) || [];
      const matchingCanonicalEntry = diskEntries.find((e) => e.path === canonicalPath);

      const filePath = await writeNoteToFolder(root, note, mergedDirectory, note.filePath, {
        skipIfContentMatches: matchingCanonicalEntry?.text,
      });

      // Remove any duplicate or old-slug files on disk for this same note ID
      for (const entry of diskEntries) {
        if (entry.path !== filePath) {
          await removeNestedFileIfExists(root, entry.path);
        }
      }

      syncedNotes.push({ ...note, filePath });
    }

    const syncedNoteIds = syncedNotes.map((n) => n.id);
    await saveSyncTombstones(mergedTombstones);
    await writeDirectoryMetadata(root, mergedDirectory, {
      tombstones: mergedTombstones,
      syncedNoteIds,
      existingRawJson: primaryRawJson,
    });

    syncedNotes.sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
    return {
      notes: syncedNotes,
      directory: mergedDirectory,
      tombstones: mergedTombstones,
      effectiveRoot: root,
    };
  });
}

/**
 * Exports the entire workspace (including pasted note images) as a clean .zip mirroring the OneDrive/Google Drive folder layout.
 */
export async function exportWorkspaceZip(notes: Note[], directory: WorkspaceDirectory): Promise<void> {
  const zip = new JSZip();
  const tombstones = await loadSyncTombstones();
  zip.file(
    '_strata/directory.json',
    JSON.stringify(
      {
        ...directory,
        tombstones,
        syncedNoteIds: notes.map((n) => n.id),
        lastSyncedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
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
              if (!directory.clients.some((x) => x.id === c.id || x.name.toLowerCase() === c.name.toLowerCase())) {
                directory.clients.push(c);
              }
            }
          }
          if (parsedDir.projects) {
            for (const p of parsedDir.projects) {
              if (!directory.projects.some((x) => x.id === p.id)) directory.projects.push(p);
            }
          }
          if (parsedDir.people) {
            for (const p of parsedDir.people) {
              if (!directory.people.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) {
                directory.people.push(p);
              }
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
      const parsed = parseMarkdownToNote(mdText, `Inbox/${file.name}`, directory, file.lastModified);
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
