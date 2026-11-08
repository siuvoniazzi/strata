import React, { useEffect, useState } from 'react';
import {
  Check,
  Cloud,
  Copy,
  ExternalLink,
  FolderOpen,
  FolderSync,
  HelpCircle,
  KeyRound,
  Link2,
  Loader2,
  RefreshCw,
  Smartphone,
  Sparkles,
  Unplug,
  X,
} from 'lucide-react';
import type { GoogleDriveConfig } from '../types';
import {
  createDrivePairingCode,
  createDrivePairingUrl,
  type DiscoveredDriveFolder,
  discoverStrataFoldersInDrive,
  extractDriveFolderIdFromInput,
  fetchDriveUserInfo,
  isGoogleDriveTokenValid,
  parseDrivePairingCode,
  requestGoogleDriveAccessToken,
  resolveOrCreateDriveWorkspaceFolder,
  saveGoogleDriveConfig,
  startGoogleOAuthRedirect,
  verifyDriveFolderById,
} from '../utils/googleDriveSync';
import { isFolderSyncSupported, type FsDirectoryHandle } from '../utils/storage';

interface SyncModalProps {
  dirHandle: FsDirectoryHandle | null;
  dirPermission: 'granted' | 'prompt' | 'denied';
  gdriveConfig: GoogleDriveConfig;
  syncStatus: string;
  isSyncing: boolean;
  lastSyncedAt: string | null;
  noteCount: number;
  onClose: () => void;
  onTriggerSyncNow: () => Promise<void>;
  onPickLocalFolder: () => Promise<void>;
  onDisconnectLocalFolder: () => Promise<void>;
  onConnectGoogleDrive: (nextConfig: GoogleDriveConfig, duplicateFolderIds?: string[]) => Promise<void>;
  onDisconnectGoogleDrive: () => void;
}

export const SyncModal: React.FC<SyncModalProps> = ({
  dirHandle,
  dirPermission,
  gdriveConfig,
  syncStatus,
  isSyncing,
  lastSyncedAt,
  noteCount,
  onClose,
  onTriggerSyncNow,
  onPickLocalFolder,
  onDisconnectLocalFolder,
  onConnectGoogleDrive,
  onDisconnectGoogleDrive,
}) => {
  const [activeTab, setActiveTab] = useState<'gdrive' | 'folder' | 'pair'>(() => {
    if (gdriveConfig.enabled) return 'gdrive';
    if (dirHandle && dirHandle.providerKind !== 'gdrive') return 'folder';
    return 'gdrive';
  });

  const [clientIdInput, setClientIdInput] = useState(gdriveConfig.clientId || '');
  const [folderNameInput, setFolderNameInput] = useState(gdriveConfig.folderName || 'Strata');
  const [folderUrlOrIdInput, setFolderUrlOrIdInput] = useState(gdriveConfig.folderId || '');
  const [manualTokenInput, setManualTokenInput] = useState('');
  const [showAdvancedToken, setShowAdvancedToken] = useState(false);
  const [showSetupGuide, setShowSetupGuide] = useState(false);

  const [discoveredFolders, setDiscoveredFolders] = useState<DiscoveredDriveFolder[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  // Multi-device pairing state
  const [includeSessionTokenInPair, setIncludeSessionTokenInPair] = useState(true);
  const [copiedPairUrl, setCopiedPairUrl] = useState(false);
  const [copiedPairCode, setCopiedPairCode] = useState(false);
  const [pastePairInput, setPastePairInput] = useState('');

  const tokenValid = isGoogleDriveTokenValid(gdriveConfig);
  const isGdriveConnected = Boolean(gdriveConfig.enabled && tokenValid && gdriveConfig.folderId);
  const isLocalFolderConnected = Boolean(
    dirHandle && dirHandle.providerKind !== 'gdrive' && dirPermission === 'granted'
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleDiscoverFolders = async (tokenToUse?: string) => {
    const token = tokenToUse || gdriveConfig.accessToken;
    if (!token) return;
    setDiscovering(true);
    setErrorMsg(null);
    try {
      const folders = await discoverStrataFoldersInDrive(token);
      setDiscoveredFolders(folders);
      if (folders.length > 0 && !folderUrlOrIdInput) {
        setFolderUrlOrIdInput(folders[0].id);
        setFolderNameInput(folders[0].name);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not list Google Drive folders');
    } finally {
      setDiscovering(false);
    }
  };

  useEffect(() => {
    if (tokenValid && gdriveConfig.accessToken && activeTab === 'gdrive') {
      void handleDiscoverFolders(gdriveConfig.accessToken);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const finalizeDriveConnection = async (
    accessToken: string,
    expiresAt: number,
    targetFolderInput?: string,
    targetFolderName?: string
  ) => {
    setAuthBusy(true);
    setErrorMsg(null);
    try {
      const userInfo = await fetchDriveUserInfo(accessToken);
      const explicitId = extractDriveFolderIdFromInput(targetFolderInput ?? folderUrlOrIdInput);
      const resolved = await resolveOrCreateDriveWorkspaceFolder(
        accessToken,
        (targetFolderName ?? folderNameInput).trim() || 'Strata',
        explicitId || undefined
      );

      const nextConfig: GoogleDriveConfig = {
        enabled: true,
        clientId: clientIdInput.trim(),
        accessToken,
        tokenExpiresAt: expiresAt,
        folderId: resolved.id,
        folderName: resolved.name,
        userEmail: userInfo.email || gdriveConfig.userEmail,
        autoSync: true,
      };

      saveGoogleDriveConfig(nextConfig);
      setFolderUrlOrIdInput(resolved.id);
      setFolderNameInput(resolved.name);
      await onConnectGoogleDrive(nextConfig, resolved.duplicateIds);
      setStatusNote(
        resolved.duplicateIds.length > 0
          ? `Connected to "${resolved.name}" and merged ${resolved.duplicateIds.length} duplicate folder(s)!`
          : `Connected to Google Drive folder "${resolved.name}"!`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to connect Google Drive folder');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleGoogleSignInPopup = async () => {
    setErrorMsg(null);
    setStatusNote(null);
    const cleanClient = clientIdInput.trim();
    if (!cleanClient) {
      setShowSetupGuide(true);
      setErrorMsg(
        'Enter your Google OAuth Client ID below (or paste a Pairing Code from your laptop).'
      );
      return;
    }

    setAuthBusy(true);
    try {
      const { accessToken, expiresAt } = await requestGoogleDriveAccessToken(cleanClient, {
        prompt: tokenValid ? '' : 'select_account',
      });
      await finalizeDriveConnection(accessToken, expiresAt);
    } catch (err) {
      setAuthBusy(false);
      setErrorMsg(err instanceof Error ? err.message : 'Google Sign-In failed');
    }
  };

  const handleGoogleRedirectSignIn = () => {
    setErrorMsg(null);
    const cleanClient = clientIdInput.trim();
    if (!cleanClient) {
      setShowSetupGuide(true);
      setErrorMsg('Enter your Google OAuth Client ID first.');
      return;
    }
    const preSave: GoogleDriveConfig = {
      ...gdriveConfig,
      clientId: cleanClient,
      folderName: folderNameInput.trim() || 'Strata',
      folderId: extractDriveFolderIdFromInput(folderUrlOrIdInput) || gdriveConfig.folderId,
    };
    saveGoogleDriveConfig(preSave);
    startGoogleOAuthRedirect(cleanClient);
  };

  const handleConnectWithExistingOrManualToken = async () => {
    setErrorMsg(null);
    setStatusNote(null);
    const token = manualTokenInput.trim() || gdriveConfig.accessToken;
    if (!token) {
      setErrorMsg('Sign in with Google or paste a valid Access Token first.');
      return;
    }
    const expiresAt = manualTokenInput.trim()
      ? Date.now() + 3500 * 1000
      : gdriveConfig.tokenExpiresAt || Date.now() + 3500 * 1000;
    await finalizeDriveConnection(token, expiresAt);
    setManualTokenInput('');
  };

  const handleSelectDiscoveredFolder = async (folder: DiscoveredDriveFolder) => {
    setFolderUrlOrIdInput(folder.id);
    setFolderNameInput(folder.name);
    if (tokenValid && gdriveConfig.accessToken) {
      await finalizeDriveConnection(
        gdriveConfig.accessToken,
        gdriveConfig.tokenExpiresAt,
        folder.id,
        folder.name
      );
    }
  };

  const handleApplyPairingCode = async () => {
    setErrorMsg(null);
    setStatusNote(null);
    const parsed = parseDrivePairingCode(pastePairInput);
    if (!parsed) {
      setErrorMsg('Invalid pairing link or code. Copy it from your other device and paste it here.');
      return;
    }

    if (parsed.c) setClientIdInput(parsed.c);
    setFolderUrlOrIdInput(parsed.f);
    setFolderNameInput(parsed.n);

    const tokenToUse = parsed.t || (tokenValid ? gdriveConfig.accessToken : '');
    const expiryToUse = parsed.e || gdriveConfig.tokenExpiresAt || Date.now() + 3500 * 1000;

    if (tokenToUse && expiryToUse > Date.now()) {
      const verified = await verifyDriveFolderById(tokenToUse, parsed.f);
      const nextConfig: GoogleDriveConfig = {
        enabled: true,
        clientId: parsed.c || clientIdInput.trim(),
        accessToken: tokenToUse,
        tokenExpiresAt: expiryToUse,
        folderId: parsed.f,
        folderName: verified?.name || parsed.n,
        autoSync: true,
      };
      saveGoogleDriveConfig(nextConfig);
      await onConnectGoogleDrive(nextConfig);
      setPastePairInput('');
      setStatusNote(`Paired and synced with "${nextConfig.folderName}"!`);
      setActiveTab('gdrive');
    } else {
      const nextConfig: GoogleDriveConfig = {
        ...gdriveConfig,
        clientId: parsed.c || clientIdInput.trim(),
        folderId: parsed.f,
        folderName: parsed.n,
      };
      saveGoogleDriveConfig(nextConfig);
      setPastePairInput('');
      setStatusNote(
        `Folder "${parsed.n}" configured! Tap "Sign in with Google" to start syncing.`
      );
      setActiveTab('gdrive');
    }
  };

  const currentOrigin =
    typeof window !== 'undefined' ? window.location.origin : 'https://your-site.github.io';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 640 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FolderSync size={16} />
            <strong>Multi-Device &amp; Google Drive Sync</strong>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {(isGdriveConnected || isLocalFolderConnected) && (
              <button
                type="button"
                className="btn btn-xs btn-primary"
                disabled={isSyncing}
                onClick={() => void onTriggerSyncNow()}
              >
                <RefreshCw size={12} className={isSyncing ? 'ai-spin' : ''} />
                {isSyncing ? 'Syncing…' : 'Sync Now'}
              </button>
            )}
            <button
              type="button"
              className="btn btn-icon btn-ghost"
              onClick={onClose}
              aria-label="Close sync modal"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="modal-body" style={{ gap: 14 }}>
          {/* Live Status Banner */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-surface-subtle)',
              border: '1px solid var(--border-default)',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background:
                      isGdriveConnected || isLocalFolderConnected
                        ? 'hsl(154, 72%, 40%)'
                        : 'var(--text-muted)',
                  }}
                />
                <span>{syncStatus}</span>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                {noteCount} note{noteCount === 1 ? '' : 's'} in workspace
                {lastSyncedAt
                  ? ` · Last synced ${new Date(lastSyncedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}`
                  : ' · Auto-syncs on startup, edits & tab focus'}
              </span>
            </div>

            {gdriveConfig.userEmail && isGdriveConnected && (
              <span className="pill pill-person" style={{ fontSize: 11.5 }}>
                {gdriveConfig.userEmail}
              </span>
            )}
          </div>

          {/* Sync Mode Tabs */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn btn-xs ${activeTab === 'gdrive' ? 'btn-primary' : ''}`}
              onClick={() => setActiveTab('gdrive')}
            >
              <Cloud size={13} />
              Google Drive Cloud (Laptop &amp; Phone)
            </button>
            <button
              type="button"
              className={`btn btn-xs ${activeTab === 'pair' ? 'btn-primary' : ''}`}
              onClick={() => setActiveTab('pair')}
            >
              <Smartphone size={13} />
              Pair Phone / Another Device
            </button>
            <button
              type="button"
              className={`btn btn-xs ${activeTab === 'folder' ? 'btn-primary' : ''}`}
              onClick={() => setActiveTab('folder')}
            >
              <FolderOpen size={13} />
              Local / Desktop Drive Folder
            </button>
          </div>

          {errorMsg && (
            <div
              style={{
                padding: '9px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--priority-high-bg)',
                color: 'var(--priority-high-text)',
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              {errorMsg}
            </div>
          )}

          {statusNote && (
            <div
              style={{
                padding: '9px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--status-done-bg)',
                color: 'var(--status-done-text)',
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              {statusNote}
            </div>
          )}

          {/* TAB 1: Direct Google Drive Cloud Sync */}
          {activeTab === 'gdrive' && (
            <div className="settings-section" style={{ gap: 12 }}>
              <div
                style={{
                  padding: '9px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-surface-subtle)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  lineHeight: 1.45,
                }}
              >
                <strong>Why Direct Google Drive Sync for Multi-Device?</strong> Mobile browsers often block
                selecting existing Google Drive folders or create duplicate folders via the OS file picker.
                Direct Google Drive Sync connects straight to your Google Drive folder by ID—and works
                seamlessly alongside <strong>Google Drive for Desktop</strong> on your laptop!
              </div>

              <div className="form-field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label className="form-label">Google OAuth Client ID</label>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => setShowSetupGuide((v) => !v)}
                  >
                    <HelpCircle size={11} />
                    {showSetupGuide ? 'Hide 1-Min Setup Guide' : 'How to get a free Client ID'}
                  </button>
                </div>
                <input
                  type="text"
                  className="form-input"
                  placeholder="1234567890-abcdefg.apps.googleusercontent.com"
                  value={clientIdInput}
                  onChange={(e) => setClientIdInput(e.target.value)}
                />
              </div>

              {showSetupGuide && (
                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-surface-subtle)',
                    border: '1px solid var(--border-default)',
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <strong style={{ color: 'var(--text-primary)' }}>
                    One-Time Google Cloud Setup (Takes ~60 seconds, then pair your phone with 1 link):
                  </strong>
                  <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <li>
                      Open{' '}
                      <a
                        href="https://console.cloud.google.com/apis/library/drive.googleapis.com"
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--accent-primary)' }}
                      >
                        Google Cloud Console → Google Drive API <ExternalLink size={10} />
                      </a>{' '}
                      and click <strong>Enable</strong>.
                    </li>
                    <li>
                      Go to{' '}
                      <a
                        href="https://console.cloud.google.com/apis/credentials"
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--accent-primary)' }}
                      >
                        APIs &amp; Services → Credentials <ExternalLink size={10} />
                      </a>
                      , click <strong>Create Credentials → OAuth client ID</strong> (Web application).
                    </li>
                    <li>
                      Under <strong>Authorized JavaScript origins</strong> &amp;{' '}
                      <strong>Authorized redirect URIs</strong>, add: <code>{currentOrigin}</code>
                    </li>
                    <li>
                      Paste the <code>.apps.googleusercontent.com</code> Client ID above. Once connected on your
                      laptop, use the <strong>Pair Phone</strong> tab so you never have to type it on your phone!
                    </li>
                  </ol>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="form-field">
                  <label className="form-label">Workspace Folder Name in Drive</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="Strata"
                    value={folderNameInput}
                    onChange={(e) => setFolderNameInput(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label className="form-label">
                    Exact Google Drive Folder URL or ID (Optional)
                  </label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="Paste Drive folder link or leave blank to auto-find…"
                    value={folderUrlOrIdInput}
                    onChange={(e) => setFolderUrlOrIdInput(e.target.value)}
                  />
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={authBusy}
                  onClick={() => void handleGoogleSignInPopup()}
                >
                  {authBusy ? <Loader2 size={14} className="ai-spin" /> : <Cloud size={14} />}
                  {isGdriveConnected ? 'Reconnect / Sync Google Drive' : 'Sign in with Google & Sync'}
                </button>

                <button
                  type="button"
                  className="btn btn-xs"
                  disabled={authBusy}
                  onClick={handleGoogleRedirectSignIn}
                  title="Use redirect login if mobile browser blocks popups"
                >
                  Mobile Redirect Login
                </button>

                {tokenValid && (
                  <button
                    type="button"
                    className="btn btn-xs btn-soft"
                    disabled={discovering || authBusy}
                    onClick={() => void handleDiscoverFolders()}
                  >
                    <Sparkles size={12} />
                    {discovering ? 'Scanning Drive…' : 'Find Existing Strata Folders'}
                  </button>
                )}

                {gdriveConfig.enabled && (
                  <button
                    type="button"
                    className="btn btn-xs btn-danger-ghost"
                    onClick={() => {
                      onDisconnectGoogleDrive();
                      setStatusNote('Disconnected from Google Drive Cloud Sync.');
                    }}
                  >
                    <Unplug size={12} />
                    Disconnect
                  </button>
                )}
              </div>

              {/* Discovered Existing Folders in Google Drive */}
              {discoveredFolders.length > 0 && (
                <div className="form-field" style={{ marginTop: 4 }}>
                  <span className="form-label">
                    Discovered Workspace Folders in Your Google Drive (Click to Lock onto Folder):
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {discoveredFolders.map((f) => {
                      const isSelected = gdriveConfig.folderId === f.id;
                      return (
                        <button
                          key={f.id}
                          type="button"
                          className="btn"
                          style={{
                            justifyContent: 'space-between',
                            borderColor: isSelected ? 'var(--accent-primary)' : undefined,
                            background: isSelected ? 'var(--accent-soft)' : undefined,
                          }}
                          onClick={() => void handleSelectDiscoveredFolder(f)}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <FolderOpen size={14} />
                            <strong>{f.name}</strong>
                            {f.hasStrataMetadata && (
                              <span className="pill pill-link" style={{ fontSize: 10.5 }}>
                                Has _strata notes
                              </span>
                            )}
                            {f.duplicateIds && f.duplicateIds.length > 0 && (
                              <span className="pill pill-label" style={{ fontSize: 10.5 }}>
                                Merges {f.duplicateIds.length + 1} duplicate folders
                              </span>
                            )}
                          </span>
                          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                            {isSelected ? 'Connected' : `ID: ${f.id.slice(0, 8)}…`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Optional Direct Access Token Fallback */}
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  onClick={() => setShowAdvancedToken((v) => !v)}
                >
                  <KeyRound size={11} />
                  {showAdvancedToken
                    ? 'Hide Direct Access Token Input'
                    : 'Advanced: Connect with a Google Drive Access Token'}
                </button>

                {showAdvancedToken && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input
                      type="password"
                      className="form-input"
                      placeholder="Paste ya29.... OAuth2 Access Token (scope: drive)…"
                      value={manualTokenInput}
                      onChange={(e) => setManualTokenInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      disabled={authBusy}
                      onClick={() => void handleConnectWithExistingOrManualToken()}
                    >
                      Connect Token
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: Multi-Device Pairing (Laptop <-> Phone) */}
          {activeTab === 'pair' && (
            <div className="settings-section" style={{ gap: 12 }}>
              <div
                style={{
                  padding: '9px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-surface-subtle)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                }}
              >
                <strong>Lock Laptop &amp; Phone to the Exact Same Folder ID:</strong> Once Google Drive
                Sync is connected on one device, copy a Pairing Link or Code below and open/paste it on your
                phone. Both devices will sync to the exact same Google Drive <code>folderId</code>—never
                creating a second folder.
              </div>

              {gdriveConfig.folderId ? (
                <div className="radar-card" style={{ gap: 10 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                    1. Send Pairing Config from This Device (Folder: “{gdriveConfig.folderName}”)
                  </div>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={includeSessionTokenInPair}
                      onChange={(e) => setIncludeSessionTokenInPair(e.target.checked)}
                    />
                    Include active Google session token for instant 1-tap connect on your personal phone
                  </label>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      onClick={() => {
                        const url = createDrivePairingUrl(gdriveConfig, includeSessionTokenInPair);
                        navigator.clipboard.writeText(url);
                        setCopiedPairUrl(true);
                        setTimeout(() => setCopiedPairUrl(false), 2000);
                      }}
                    >
                      {copiedPairUrl ? <Check size={12} /> : <Link2 size={12} />}
                      {copiedPairUrl ? 'Copied Pairing URL!' : 'Copy Phone Pairing Link'}
                    </button>

                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => {
                        const code = createDrivePairingCode(gdriveConfig, includeSessionTokenInPair);
                        navigator.clipboard.writeText(code);
                        setCopiedPairCode(true);
                        setTimeout(() => setCopiedPairCode(false), 2000);
                      }}
                    >
                      {copiedPairCode ? <Check size={12} /> : <Copy size={12} />}
                      {copiedPairCode ? 'Copied Code!' : 'Copy Pairing Code'}
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px dashed var(--border-default)',
                    fontSize: 12,
                    color: 'var(--text-muted)',
                  }}
                >
                  Connect Google Drive in the first tab on your laptop first to generate a Phone Pairing Link.
                </div>
              )}

              <div className="radar-card" style={{ gap: 8 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                  2. On Your Phone (or Second Device): Paste Pairing Code or Link
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="Paste pairing link or code from your other device…"
                    value={pastePairInput}
                    onChange={(e) => setPastePairInput(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-xs btn-primary"
                    disabled={!pastePairInput.trim() || authBusy}
                    onClick={() => void handleApplyPairingCode()}
                  >
                    Apply &amp; Pair
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Local / Mounted Cloud Folder Sync */}
          {activeTab === 'folder' && (
            <div className="settings-section" style={{ gap: 12 }}>
              <div
                style={{
                  padding: '9px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-surface-subtle)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  lineHeight: 1.45,
                }}
              >
                <strong>Desktop Google Drive / OneDrive Folder Sync:</strong> On your laptop, you can point
                Strata to a local folder synced by the Google Drive or OneDrive desktop app.
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  <li>
                    Automatically detects if you selected a parent folder and resolves existing{' '}
                    <code>_strata/directory.json</code> workspaces.
                  </li>
                  <li>
                    Automatically merges and cleans up <code>(1).md</code> conflict files and reconciles Client
                    &amp; Project IDs across devices.
                  </li>
                  <li>
                    <strong>Tip for Phone + Laptop:</strong> You can use <em>Local Folder Sync</em> on your
                    laptop pointing to <code>Google Drive/Strata</code> AND use <em>Google Drive Cloud Sync</em>{' '}
                    on your phone pointing to that same <code>Strata</code> folder!
                  </li>
                </ul>
              </div>

              {!isFolderSyncSupported() ? (
                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--status-waiting-bg)',
                    color: 'var(--status-waiting-text)',
                    fontSize: 12,
                  }}
                >
                  This browser (e.g. mobile Safari/iOS) does not support the OS Local Folder Picker API. Switch
                  to the <strong>Google Drive Cloud</strong> tab above for direct cloud sync on this device!
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isSyncing}
                    onClick={() => void onPickLocalFolder()}
                  >
                    <FolderOpen size={14} />
                    {dirHandle && dirHandle.providerKind !== 'gdrive'
                      ? `Change Local Folder (${dirHandle.name})`
                      : 'Select Local / Google Drive Folder'}
                  </button>

                  {dirHandle && dirHandle.providerKind !== 'gdrive' && (
                    <>
                      <button
                        type="button"
                        className="btn btn-xs btn-soft"
                        disabled={isSyncing}
                        onClick={() => void onTriggerSyncNow()}
                      >
                        <RefreshCw size={12} className={isSyncing ? 'ai-spin' : ''} />
                        Sync &amp; Deduplicate Folder Now
                      </button>

                      <button
                        type="button"
                        className="btn btn-xs btn-danger-ghost"
                        onClick={() => void onDisconnectLocalFolder()}
                      >
                        <Unplug size={12} />
                        Disconnect Folder
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
