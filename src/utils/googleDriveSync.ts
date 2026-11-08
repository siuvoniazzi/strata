import type { GoogleDriveConfig } from '../types';
import type { FsDirectoryHandle, FsFileHandle, FsWritable } from './storage';

const GDRIVE_CONFIG_STORAGE_KEY = 'strata.gdrive.config';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  parents?: string[];
  size?: string;
}

export interface DiscoveredDriveFolder {
  id: string;
  name: string;
  hasStrataMetadata: boolean;
  modifiedTime?: string;
  duplicateIds?: string[];
}

export interface DrivePairingPayload {
  c?: string; // clientId
  f: string; // folderId
  n: string; // folderName
  t?: string; // optional temporary accessToken
  e?: number; // optional tokenExpiresAt
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            prompt?: string;
            callback: (response: {
              access_token?: string;
              expires_in?: number;
              error?: string;
              error_description?: string;
            }) => void;
            error_callback?: (err: { type?: string; message?: string }) => void;
          }) => {
            requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
          };
        };
      };
    };
  }
}

const DEFAULT_ENV_CLIENT_ID =
  (typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_GOOGLE_CLIENT_ID) ||
  '';

export function loadGoogleDriveConfig(): GoogleDriveConfig {
  try {
    const raw = localStorage.getItem(GDRIVE_CONFIG_STORAGE_KEY);
    if (!raw) {
      return {
        enabled: false,
        clientId: DEFAULT_ENV_CLIENT_ID,
        accessToken: '',
        tokenExpiresAt: 0,
        folderId: '',
        folderName: 'Strata',
        autoSync: true,
      };
    }
    const parsed = JSON.parse(raw) as Partial<GoogleDriveConfig>;
    return {
      enabled: Boolean(parsed.enabled),
      clientId: parsed.clientId || DEFAULT_ENV_CLIENT_ID,
      accessToken: parsed.accessToken || '',
      tokenExpiresAt: Number(parsed.tokenExpiresAt) || 0,
      folderId: parsed.folderId || '',
      folderName: parsed.folderName || 'Strata',
      userEmail: parsed.userEmail,
      autoSync: parsed.autoSync !== false,
    };
  } catch {
    return {
      enabled: false,
      clientId: DEFAULT_ENV_CLIENT_ID,
      accessToken: '',
      tokenExpiresAt: 0,
      folderId: '',
      folderName: 'Strata',
      autoSync: true,
    };
  }
}

export function saveGoogleDriveConfig(config: GoogleDriveConfig): void {
  try {
    localStorage.setItem(GDRIVE_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage quota / sandboxed errors
  }
}

export function isGoogleDriveTokenValid(config: GoogleDriveConfig): boolean {
  if (!config.accessToken) return false;
  if (!config.tokenExpiresAt) return true;
  return Date.now() < config.tokenExpiresAt - 30_000;
}

/**
 * Extracts a Google Drive Folder ID from either a full Google Drive URL or a raw ID string.
 */
export function extractDriveFolderIdFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Match https://drive.google.com/drive/folders/<ID> or /drive/u/0/folders/<ID>
  const urlMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (urlMatch) return urlMatch[1];

  // Match ?id=<ID>
  const queryMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (queryMatch) return queryMatch[1];

  // Raw Drive ID (alphanumeric, hyphens, underscores, >= 15 chars, no spaces/slashes)
  if (/^[a-zA-Z0-9_-]{15,80}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

/**
 * Encodes a multi-device pairing payload into a URL or compact pairing code.
 */
export function createDrivePairingCode(
  config: GoogleDriveConfig,
  includeCurrentToken = false
): string {
  const payload: DrivePairingPayload = {
    c: config.clientId || undefined,
    f: config.folderId,
    n: config.folderName || 'Strata',
  };
  if (includeCurrentToken && isGoogleDriveTokenValid(config)) {
    payload.t = config.accessToken;
    payload.e = config.tokenExpiresAt;
  }
  const json = JSON.stringify(payload);
  return btoa(encodeURIComponent(json));
}

export function createDrivePairingUrl(
  config: GoogleDriveConfig,
  includeCurrentToken = false
): string {
  const code = createDrivePairingCode(config, includeCurrentToken);
  const base =
    typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}${window.location.search}`
      : '';
  return `${base}#strata_gdrive=${code}`;
}

export function parseDrivePairingCode(rawInput: string): DrivePairingPayload | null {
  try {
    let token = rawInput.trim();
    const hashIdx = token.indexOf('#strata_gdrive=');
    if (hashIdx !== -1) {
      token = token.slice(hashIdx + '#strata_gdrive='.length).split('&')[0];
    } else if (token.startsWith('strata_gdrive=')) {
      token = token.slice('strata_gdrive='.length).split('&')[0];
    }
    const json = decodeURIComponent(atob(token));
    const parsed = JSON.parse(json) as Partial<DrivePairingPayload>;
    if (!parsed.f || typeof parsed.f !== 'string') return null;
    return {
      c: typeof parsed.c === 'string' ? parsed.c : undefined,
      f: parsed.f,
      n: typeof parsed.n === 'string' && parsed.n ? parsed.n : 'Strata',
      t: typeof parsed.t === 'string' ? parsed.t : undefined,
      e: typeof parsed.e === 'number' ? parsed.e : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Checks window.location.hash on startup for either:
 * 1) A multi-device pairing link (#strata_gdrive=...)
 * 2) An OAuth2 implicit redirect callback (#state=strata_gdrive_oauth&access_token=...)
 */
export function consumeUrlGoogleDriveParams(): {
  updatedConfig: GoogleDriveConfig | null;
  didPair: boolean;
  didOAuthRedirect: boolean;
} {
  if (typeof window === 'undefined' || !window.location.hash) {
    return { updatedConfig: null, didPair: false, didOAuthRedirect: false };
  }

  const hash = window.location.hash.slice(1);
  if (!hash) {
    return { updatedConfig: null, didPair: false, didOAuthRedirect: false };
  }

  // Case 1: Pairing link (#strata_gdrive=...)
  if (hash.startsWith('strata_gdrive=')) {
    const payload = parseDrivePairingCode(hash);
    if (payload) {
      const current = loadGoogleDriveConfig();
      const next: GoogleDriveConfig = {
        ...current,
        enabled: true,
        clientId: payload.c || current.clientId,
        folderId: payload.f,
        folderName: payload.n || current.folderName || 'Strata',
        accessToken: payload.t || current.accessToken,
        tokenExpiresAt: payload.e || current.tokenExpiresAt,
      };
      saveGoogleDriveConfig(next);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      return { updatedConfig: next, didPair: true, didOAuthRedirect: false };
    }
  }

  // Case 2: OAuth2 redirect callback (#access_token=...&state=strata_gdrive_oauth)
  const params = new URLSearchParams(hash);
  const accessToken = params.get('access_token');
  const state = params.get('state');
  if (accessToken && state?.startsWith('strata_gdrive_oauth')) {
    const expiresInSec = Number(params.get('expires_in')) || 3600;
    const current = loadGoogleDriveConfig();
    const next: GoogleDriveConfig = {
      ...current,
      enabled: true,
      accessToken,
      tokenExpiresAt: Date.now() + expiresInSec * 1000,
    };
    saveGoogleDriveConfig(next);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return { updatedConfig: next, didPair: false, didOAuthRedirect: true };
  }

  return { updatedConfig: null, didPair: false, didOAuthRedirect: false };
}

let gsiScriptPromise: Promise<void> | null = null;

function loadGoogleIdentityScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Window unavailable'));
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gsiScriptPromise) return gsiScriptPromise;

  gsiScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Sign-In script')));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gsiScriptPromise = null;
      reject(new Error('Failed to load Google Sign-In script'));
    };
    document.head.appendChild(script);
  });

  return gsiScriptPromise;
}

/**
 * Initiates a full-page OAuth2 implicit flow redirect (helpful on mobile browsers / iOS PWAs where popups are blocked).
 */
export function startGoogleOAuthRedirect(clientId: string): void {
  const cleanClientId = clientId.trim();
  if (!cleanClientId) throw new Error('Google OAuth Client ID is required');
  const redirectUri = `${window.location.origin}${window.location.pathname}`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', cleanClientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', 'strata_gdrive_oauth');
  authUrl.searchParams.set('prompt', 'select_account');
  window.location.assign(authUrl.toString());
}

/**
 * Requests a Google Drive OAuth2 access token using Google Identity Services popup flow.
 */
export async function requestGoogleDriveAccessToken(
  clientId: string,
  options?: { prompt?: string }
): Promise<{ accessToken: string; expiresAt: number }> {
  const cleanClientId = clientId.trim();
  if (!cleanClientId) {
    throw new Error('Please enter a Google OAuth Client ID first.');
  }

  await loadGoogleIdentityScript();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) {
    throw new Error('Google Sign-In library unavailable in this browser.');
  }

  return new Promise((resolve, reject) => {
    const tokenClient = oauth2.initTokenClient({
      client_id: cleanClientId,
      scope: 'https://www.googleapis.com/auth/drive',
      prompt: options?.prompt ?? '',
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error_description || resp.error || 'Google Sign-In failed'));
          return;
        }
        const expiresIn = Number(resp.expires_in) || 3600;
        resolve({
          accessToken: resp.access_token,
          expiresAt: Date.now() + expiresIn * 1000,
        });
      },
      error_callback: (err) => {
        reject(new Error(err?.message || err?.type || 'Google Sign-In popup closed or blocked'));
      },
    });

    tokenClient.requestAccessToken({ prompt: options?.prompt ?? '' });
  });
}

async function driveFetch<T>(
  accessToken: string,
  url: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers || {});
  headers.set('Authorization', `Bearer ${accessToken}`);
  const res = await fetch(url, {
    ...init,
    headers,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const errJson = (await res.json()) as { error?: { message?: string } };
      if (errJson?.error?.message) detail = errJson.error.message;
    } catch {
      // Ignore parse error
    }
    const err = new Error(`Google Drive API error: ${detail}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function listDriveQuery(accessToken: string, q: string, fields = 'files(id,name,mimeType,modifiedTime,parents)'): Promise<DriveFileItem[]> {
  const items: DriveFileItem[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${DRIVE_API_BASE}/files`);
    url.searchParams.set('q', q);
    url.searchParams.set('fields', `nextPageToken,${fields}`);
    url.searchParams.set('pageSize', '200');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const data = await driveFetch<{ files?: DriveFileItem[]; nextPageToken?: string }>(
      accessToken,
      url.toString()
    );
    if (data.files) items.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return items;
}

export async function fetchDriveUserInfo(accessToken: string): Promise<{ email?: string; displayName?: string }> {
  try {
    const url = `${DRIVE_API_BASE}/about?fields=user(emailAddress,displayName)`;
    const data = await driveFetch<{ user?: { emailAddress?: string; displayName?: string } }>(accessToken, url);
    return {
      email: data.user?.emailAddress,
      displayName: data.user?.displayName,
    };
  } catch {
    return {};
  }
}

export async function verifyDriveFolderById(
  accessToken: string,
  folderId: string
): Promise<{ id: string; name: string } | null> {
  try {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed&supportsAllDrives=true`;
    const item = await driveFetch<DriveFileItem & { trashed?: boolean }>(accessToken, url);
    if (item.trashed || item.mimeType !== FOLDER_MIME) return null;
    return { id: item.id, name: item.name };
  } catch {
    return null;
  }
}

/**
 * Auto-discovers existing Strata workspace folders in the user's Google Drive!
 * This prevents creating a new/duplicate folder when connecting a second device (like a phone):
 * 1) Finds any existing `_strata` folder in Google Drive and resolves its parent folder (the workspace root).
 * 2) Finds any folders named "Strata" (or containing "Strata") and groups duplicate folder names so they can be merged.
 */
export async function discoverStrataFoldersInDrive(
  accessToken: string
): Promise<DiscoveredDriveFolder[]> {
  const discoveredById = new Map<string, DiscoveredDriveFolder>();

  // 1. Find any `_strata` metadata directory and resolve its parent workspace folder
  const strataMetaDirs = await listDriveQuery(
    accessToken,
    `name = '_strata' and mimeType = '${FOLDER_MIME}' and trashed = false`
  );

  const parentIds = new Set<string>();
  for (const metaDir of strataMetaDirs) {
    for (const pid of metaDir.parents || []) {
      parentIds.add(pid);
    }
  }

  for (const pid of parentIds) {
    try {
      const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(pid)}?fields=id,name,mimeType,modifiedTime,trashed&supportsAllDrives=true`;
      const parentInfo = await driveFetch<DriveFileItem & { trashed?: boolean }>(accessToken, url);
      if (!parentInfo.trashed && parentInfo.mimeType === FOLDER_MIME) {
        discoveredById.set(parentInfo.id, {
          id: parentInfo.id,
          name: parentInfo.name,
          hasStrataMetadata: true,
          modifiedTime: parentInfo.modifiedTime,
        });
      }
    } catch {
      // Ignore inaccessible parent
    }
  }

  // 2. Also find any folders with "strata" in the name
  const namedFolders = await listDriveQuery(
    accessToken,
    `mimeType = '${FOLDER_MIME}' and name contains 'Strata' and trashed = false`
  );
  for (const f of namedFolders) {
    if (!discoveredById.has(f.id)) {
      discoveredById.set(f.id, {
        id: f.id,
        name: f.name,
        hasStrataMetadata: false,
        modifiedTime: f.modifiedTime,
      });
    }
  }

  // Group folders with identical case-insensitive names so duplicate folders in Drive are consolidated
  const byLowerName = new Map<string, DiscoveredDriveFolder[]>();
  for (const folder of discoveredById.values()) {
    const key = folder.name.trim().toLowerCase();
    const list = byLowerName.get(key) || [];
    list.push(folder);
    byLowerName.set(key, list);
  }

  const consolidated: DiscoveredDriveFolder[] = [];
  for (const group of byLowerName.values()) {
    // Sort: folders with _strata metadata first, then most recently modified
    group.sort((a, b) => {
      if (a.hasStrataMetadata !== b.hasStrataMetadata) {
        return a.hasStrataMetadata ? -1 : 1;
      }
      return (b.modifiedTime || '').localeCompare(a.modifiedTime || '');
    });
    const primary = group[0];
    const duplicateIds = group.slice(1).map((g) => g.id);
    consolidated.push({
      ...primary,
      duplicateIds: duplicateIds.length > 0 ? duplicateIds : undefined,
    });
  }

  consolidated.sort((a, b) => {
    if (a.hasStrataMetadata !== b.hasStrataMetadata) {
      return a.hasStrataMetadata ? -1 : 1;
    }
    return (b.modifiedTime || '').localeCompare(a.modifiedTime || '');
  });

  return consolidated;
}

/**
 * Ensures or resolves a single canonical Google Drive folder for Strata.
 * Always reuses an existing workspace folder if one exists in Drive — never blindly creates a duplicate!
 */
export async function resolveOrCreateDriveWorkspaceFolder(
  accessToken: string,
  preferredFolderName = 'Strata',
  explicitFolderId?: string
): Promise<{ id: string; name: string; duplicateIds: string[] }> {
  // 1. If an explicit folder ID is configured, verify it exists and check for same-named sibling folders
  if (explicitFolderId) {
    const verified = await verifyDriveFolderById(accessToken, explicitFolderId);
    if (verified) {
      const discovered = await discoverStrataFoldersInDrive(accessToken);
      const match = discovered.find(
        (d) =>
          d.id === verified.id ||
          d.duplicateIds?.includes(verified.id) ||
          d.name.toLowerCase() === verified.name.toLowerCase()
      );
      const allIds = new Set<string>([verified.id]);
      if (match) {
        allIds.add(match.id);
        for (const dup of match.duplicateIds || []) allIds.add(dup);
      }
      allIds.delete(verified.id);
      return {
        id: verified.id,
        name: verified.name,
        duplicateIds: Array.from(allIds),
      };
    }
  }

  // 2. Discover existing Strata folders in Google Drive
  const discovered = await discoverStrataFoldersInDrive(accessToken);
  const cleanTarget = preferredFolderName.trim() || 'Strata';

  // Prefer an exact name match or any existing folder that already has `_strata` metadata
  const exactMatch = discovered.find((d) => d.name.toLowerCase() === cleanTarget.toLowerCase());
  if (exactMatch) {
    return {
      id: exactMatch.id,
      name: exactMatch.name,
      duplicateIds: exactMatch.duplicateIds || [],
    };
  }

  const withMetadata = discovered.find((d) => d.hasStrataMetadata);
  if (withMetadata) {
    return {
      id: withMetadata.id,
      name: withMetadata.name,
      duplicateIds: withMetadata.duplicateIds || [],
    };
  }

  // 3. Also check if any folder with `cleanTarget` name exists anywhere in Drive
  const escapedName = cleanTarget.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const existingByName = await listDriveQuery(
    accessToken,
    `mimeType = '${FOLDER_MIME}' and name = '${escapedName}' and trashed = false`
  );
  if (existingByName.length > 0) {
    const primary = existingByName[0];
    return {
      id: primary.id,
      name: primary.name,
      duplicateIds: existingByName.slice(1).map((x) => x.id),
    };
  }

  // 4. Create the folder in root ("root") only when no existing folder was found
  const created = await driveFetch<DriveFileItem>(accessToken, `${DRIVE_API_BASE}/files?supportsAllDrives=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: cleanTarget,
      mimeType: FOLDER_MIME,
    }),
  });

  return {
    id: created.id,
    name: created.name,
    duplicateIds: [],
  };
}

class GoogleDriveFileHandle implements FsFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  private readonly accessTokenGetter: () => string;
  private readonly parentFolderId: string;
  private fileId: string | null;
  private duplicateFileIds: string[];
  private modifiedTimeMs: number;
  private readonly onFileMutated?: () => void;

  constructor(params: {
    name: string;
    accessTokenGetter: () => string;
    parentFolderId: string;
    fileId: string | null;
    duplicateFileIds?: string[];
    modifiedTime?: string;
    onFileMutated?: () => void;
  }) {
    this.name = params.name;
    this.accessTokenGetter = params.accessTokenGetter;
    this.parentFolderId = params.parentFolderId;
    this.fileId = params.fileId;
    this.duplicateFileIds = params.duplicateFileIds || [];
    this.modifiedTimeMs = params.modifiedTime ? new Date(params.modifiedTime).getTime() || Date.now() : Date.now();
    this.onFileMutated = params.onFileMutated;
  }

  async getFile(): Promise<File> {
    if (!this.fileId) {
      return new File([''], this.name, { lastModified: this.modifiedTimeMs });
    }
    const token = this.accessTokenGetter();
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(this.fileId)}?alt=media&supportsAllDrives=true`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to download "${this.name}" from Google Drive (${res.status})`);
    }
    const blob = await res.blob();
    return new File([blob], this.name, {
      type: blob.type || 'text/markdown',
      lastModified: this.modifiedTimeMs,
    });
  }

  async createWritable(): Promise<FsWritable> {
    let pendingData: string | Blob = '';
    return {
      write: async (data: string | Blob) => {
        pendingData = data;
      },
      close: async () => {
        const token = this.accessTokenGetter();
        const contentBlob =
          typeof pendingData === 'string'
            ? new Blob([pendingData], {
                type: this.name.endsWith('.json') ? 'application/json' : 'text/markdown;charset=utf-8',
              })
            : pendingData;

        if (this.fileId) {
          // Update existing file IN-PLACE by ID so a duplicate file is NEVER created
          const uploadUrl = `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(this.fileId)}?uploadType=media&supportsAllDrives=true`;
          const res = await fetch(uploadUrl, {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': contentBlob.type || 'application/octet-stream',
            },
            body: contentBlob,
          });
          if (!res.ok) {
            throw new Error(`Failed to update "${this.name}" in Google Drive (${res.status})`);
          }

          // Clean up any duplicate files with the exact same name in the folder
          for (const dupId of this.duplicateFileIds) {
            if (dupId !== this.fileId) {
              fetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(dupId)}?supportsAllDrives=true`, {
                method: 'PATCH',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ trashed: true }),
              }).catch(() => {});
            }
          }
          this.duplicateFileIds = [];
        } else {
          // Create new file inside parentFolderId using multipart upload
          const metadata = {
            name: this.name,
            parents: [this.parentFolderId],
          };
          const boundary = `strata_ drive_${Date.now().toString(36)}`;
          const metaPart =
            `--${boundary}\r\n` +
            `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
            `${JSON.stringify(metadata)}\r\n` +
            `--${boundary}\r\n` +
            `Content-Type: ${contentBlob.type || 'application/octet-stream'}\r\n\r\n`;
          const closeDelimiter = `\r\n--${boundary}--`;

          const multipartBody = new Blob([metaPart, contentBlob, closeDelimiter], {
            type: `multipart/related; boundary=${boundary}`,
          });

          const uploadUrl = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,modifiedTime&supportsAllDrives=true`;
          const res = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
            },
            body: multipartBody,
          });
          if (!res.ok) {
            throw new Error(`Failed to create "${this.name}" in Google Drive (${res.status})`);
          }
          const created = (await res.json()) as { id: string; modifiedTime?: string };
          this.fileId = created.id;
          if (created.modifiedTime) {
            this.modifiedTimeMs = new Date(created.modifiedTime).getTime() || Date.now();
          }
        }
        this.onFileMutated?.();
      },
    };
  }
}

/**
 * Virtual FsDirectoryHandle backed by Google Drive API v3.
 * Supports consolidating duplicate folders (e.g., if two devices previously created two "Inbox" or "Strata" folders)
 * so all files across duplicate folders are read and unified into the canonical folder!
 */
export class GoogleDriveDirectoryHandle implements FsDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly providerKind = 'gdrive' as const;
  readonly name: string;
  readonly primaryFolderId: string;
  private readonly allFolderIds: string[];
  private readonly accessTokenGetter: () => string;
  private childrenCache: DriveFileItem[] | null = null;

  constructor(params: {
    name: string;
    primaryFolderId: string;
    duplicateFolderIds?: string[];
    accessTokenGetter: () => string;
  }) {
    this.name = params.name;
    this.primaryFolderId = params.primaryFolderId;
    this.allFolderIds = Array.from(
      new Set([params.primaryFolderId, ...(params.duplicateFolderIds || [])])
    );
    this.accessTokenGetter = params.accessTokenGetter;
  }

  async prepareSyncSession(): Promise<void> {
    this.childrenCache = null;
  }

  async queryPermission(): Promise<'granted' | 'denied' | 'prompt'> {
    return this.accessTokenGetter() ? 'granted' : 'prompt';
  }

  async requestPermission(): Promise<'granted' | 'denied' | 'prompt'> {
    return this.accessTokenGetter() ? 'granted' : 'prompt';
  }

  private async listChildren(): Promise<DriveFileItem[]> {
    if (this.childrenCache) return this.childrenCache;
    const token = this.accessTokenGetter();
    const parentClause =
      this.allFolderIds.length === 1
        ? `'${this.allFolderIds[0]}' in parents`
        : `(${this.allFolderIds.map((id) => `'${id}' in parents`).join(' or ')})`;

    const items = await listDriveQuery(token, `${parentClause} and trashed = false`);
    this.childrenCache = items;
    return items;
  }

  async *entries(): AsyncIterableIterator<[string, FsFileHandle | FsDirectoryHandle]> {
    const items = await this.listChildren();

    // Group directories by case-insensitive name so duplicate folders in Drive are automatically merged!
    const foldersByLower = new Map<string, DriveFileItem[]>();
    // Group files by exact name so duplicate files in Drive are automatically deduplicated!
    const filesByName = new Map<string, DriveFileItem[]>();

    for (const item of items) {
      if (item.mimeType === FOLDER_MIME) {
        const key = item.name.trim().toLowerCase();
        const group = foldersByLower.get(key) || [];
        group.push(item);
        foldersByLower.set(key, group);
      } else {
        const group = filesByName.get(item.name) || [];
        group.push(item);
        filesByName.set(item.name, group);
      }
    }

    for (const group of foldersByLower.values()) {
      // Prefer the folder inside primaryFolderId, or most recently modified
      group.sort((a, b) => {
        const aInPrimary = a.parents?.includes(this.primaryFolderId) ? 0 : 1;
        const bInPrimary = b.parents?.includes(this.primaryFolderId) ? 0 : 1;
        if (aInPrimary !== bInPrimary) return aInPrimary - bInPrimary;
        return (b.modifiedTime || '').localeCompare(a.modifiedTime || '');
      });
      const primary = group[0];
      const duplicateIds = group.slice(1).map((g) => g.id);
      yield [
        primary.name,
        new GoogleDriveDirectoryHandle({
          name: primary.name,
          primaryFolderId: primary.id,
          duplicateFolderIds: duplicateIds,
          accessTokenGetter: this.accessTokenGetter,
        }),
      ];
    }

    for (const [fileName, group] of filesByName.entries()) {
      // Sort newest modified first so the newest content is read
      group.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
      const primary = group[0];
      const duplicateIds = group.slice(1).map((g) => g.id);
      yield [
        fileName,
        new GoogleDriveFileHandle({
          name: fileName,
          accessTokenGetter: this.accessTokenGetter,
          parentFolderId: this.primaryFolderId,
          fileId: primary.id,
          duplicateFileIds: duplicateIds,
          modifiedTime: primary.modifiedTime,
          onFileMutated: () => {
            this.childrenCache = null;
          },
        }),
      ];
    }
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<FsDirectoryHandle> {
    const items = await this.listChildren();
    const matching = items.filter(
      (item) =>
        item.mimeType === FOLDER_MIME && item.name.trim().toLowerCase() === name.trim().toLowerCase()
    );

    if (matching.length > 0) {
      matching.sort((a, b) => {
        const aInPrimary = a.parents?.includes(this.primaryFolderId) ? 0 : 1;
        const bInPrimary = b.parents?.includes(this.primaryFolderId) ? 0 : 1;
        if (aInPrimary !== bInPrimary) return aInPrimary - bInPrimary;
        return (b.modifiedTime || '').localeCompare(a.modifiedTime || '');
      });
      const primary = matching[0];
      return new GoogleDriveDirectoryHandle({
        name: primary.name,
        primaryFolderId: primary.id,
        duplicateFolderIds: matching.slice(1).map((m) => m.id),
        accessTokenGetter: this.accessTokenGetter,
      });
    }

    if (!options?.create) {
      throw new Error(`Google Drive folder "${name}" not found`);
    }

    const token = this.accessTokenGetter();
    const created = await driveFetch<DriveFileItem>(
      token,
      `${DRIVE_API_BASE}/files?supportsAllDrives=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          mimeType: FOLDER_MIME,
          parents: [this.primaryFolderId],
        }),
      }
    );

    this.childrenCache = null;
    return new GoogleDriveDirectoryHandle({
      name: created.name,
      primaryFolderId: created.id,
      accessTokenGetter: this.accessTokenGetter,
    });
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle> {
    const items = await this.listChildren();
    const matching = items.filter(
      (item) =>
        item.mimeType !== FOLDER_MIME && item.name.trim().toLowerCase() === name.trim().toLowerCase()
    );

    if (matching.length > 0) {
      matching.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
      const primary = matching[0];
      return new GoogleDriveFileHandle({
        name: primary.name,
        accessTokenGetter: this.accessTokenGetter,
        parentFolderId: this.primaryFolderId,
        fileId: primary.id,
        duplicateFileIds: matching.slice(1).map((m) => m.id),
        modifiedTime: primary.modifiedTime,
        onFileMutated: () => {
          this.childrenCache = null;
        },
      });
    }

    if (!options?.create) {
      throw new Error(`Google Drive file "${name}" not found`);
    }

    return new GoogleDriveFileHandle({
      name,
      accessTokenGetter: this.accessTokenGetter,
      parentFolderId: this.primaryFolderId,
      fileId: null,
      onFileMutated: () => {
        this.childrenCache = null;
      },
    });
  }

  async removeEntry(name: string): Promise<void> {
    const items = await this.listChildren();
    const targets = items.filter(
      (item) => item.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
    if (targets.length === 0) return;

    const token = this.accessTokenGetter();
    for (const target of targets) {
      try {
        await driveFetch(
          token,
          `${DRIVE_API_BASE}/files/${encodeURIComponent(target.id)}?supportsAllDrives=true`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trashed: true }),
          }
        );
      } catch {
        // Ignore individual remove error
      }
    }
    this.childrenCache = null;
  }
}
