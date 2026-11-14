import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  BarChart3,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Download,
  FilePlus2,
  FolderSync,
  Gavel,
  History,
  Inbox,
  KeyRound,
  Layers,
  Loader2,
  Maximize2,
  Minimize2,
  Moon,
  PanelLeft,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Sun,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { AiSettingsModal, AiStructureModal } from './components/AiStructureModal';
import { CommandPalette } from './components/CommandPalette';
import { ContextTimeline } from './components/ContextTimeline';
import {
  DecisionsGlobalView,
  PeopleDirectoryView,
  TasksGlobalView,
} from './components/DirectoryViews';
import { HybridEditor } from './components/HybridEditor';
import { type ReportsHubMode, ReportsView } from './components/ReportsView';
import { SyncModal } from './components/SyncModal';
import {
  WorkspaceOverlay,
  isSameOverlayEntry,
  type OverlayEntry,
} from './components/WorkspaceOverlay';
import type {
  ActiveMainView,
  AiConfig,
  Client,
  DecisionStatus,
  GoogleDriveConfig,
  Note,
  NoteFilter,
  ParsedDecision,
  ParsedTask,
  Person,
  Project,
  SyncTombstones,
  TaskStatus,
  WorkspaceDirectory,
  WorkspacePreferences,
} from './types';
import {
  getAiActivitySnapshot,
  loadAiConfig,
  subscribeAiActivity,
} from './utils/aiProvider';
import {
  buildDailyBriefingNote,
  buildDeterministicDailyBriefing,
  composeFullDailyNoteMarkdown,
  computeDailyBriefingData,
  DAILY_BRIEFING_NOTE_ID,
  generateDailyBriefingWithAiOrFallback,
  getTodayDateString,
  loadDailyBriefingState,
  type PersistedDailyBriefingState,
  saveDailyBriefingState,
} from './utils/dailyBriefing';
import {
  consumeUrlGoogleDriveParams,
  GoogleDriveDirectoryHandle,
  isGoogleDriveTokenValid,
  loadGoogleDriveConfig,
  resolveOrCreateDriveWorkspaceFolder,
  saveGoogleDriveConfig,
} from './utils/googleDriveSync';
import { hydrateImagesFromIdb } from './utils/imageStore';
import {
  copyTextToClipboard,
  loadShareIncludeMetadataPreference,
  serializeNoteForShare,
  shareNoteViaEmail,
  shareNoteViaWhatsApp,
} from './utils/noteShare';
import { loadWorkspacePreferences } from './utils/preferences';
import {
  computeNoteFilePath,
  deleteDecisionFromBody,
  deleteTaskFromBody,
  extractInlineMentions,
  getAllNoteLabels,
  isDailyBriefingNote,
  normalizeLabel,
  parseNoteItems,
  removeLabelFromNote,
  slugify,
  stripMarkdownFormatting,
  updateDecisionInBody,
  updateTaskInBody,
} from './utils/markdown';
import { createSeedWorkspace, purgeLegacyDemoData } from './utils/seedData';
import {
  createEmptyTombstones,
  enqueueStorageTask,
  exportWorkspaceZip,
  type FsDirectoryHandle,
  idbGet,
  idbSet,
  importFilesIntoWorkspace,
  loadPersistedDirHandle,
  loadSyncTombstones,
  pickSyncDirectory,
  removeNestedFileIfExists,
  requestHandlePermission,
  saveSyncTombstones,
  syncWorkspaceWithFolder,
  writeDirectoryMetadata,
  writeNoteToFolder,
} from './utils/storage';

import {
  areNotesContentEqual,
  type EditorSelectionSnapshot,
  type NoteEditMeta,
  type PendingSelectionRestore,
  UndoHistoryStore,
  type WorkspaceSnapshotState,
} from './utils/undoHistory';

const CLIENT_PALETTE = ['#0284c7', '#0d9488', '#d97706', '#2563eb', '#059669', '#dc2626'];

interface WorkspaceToastState {
  message: string;
  action: 'undo' | 'redo' | null;
}

function makeFreshNote(partial?: Partial<Note>): Note {
  const now = new Date();
  const iso = now.toISOString();
  return {
    id: `note-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: '',
    date: iso.slice(0, 10),
    scope: 'inbox',
    clientId: null,
    projectId: null,
    participants: [],
    labels: [],
    body: '',
    createdAt: iso,
    updatedAt: iso,
    ...partial,
  };
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hasNoteChangedFromDraft(candidate: Note, baseline: Note): boolean {
  return (
    candidate.title !== baseline.title ||
    candidate.body !== baseline.body ||
    candidate.date !== baseline.date ||
    candidate.scope !== baseline.scope ||
    candidate.clientId !== baseline.clientId ||
    candidate.projectId !== baseline.projectId ||
    !areStringArraysEqual(candidate.participants, baseline.participants) ||
    !areStringArraysEqual(candidate.labels, baseline.labels)
  );
}

function isUntouchedBlankNote(n: Note): boolean {
  return (
    !n.title.trim() &&
    !n.body.trim() &&
    n.scope === 'inbox' &&
    !n.clientId &&
    !n.projectId &&
    n.participants.length === 0 &&
    n.labels.length === 0
  );
}

export function App() {
  const seed = useMemo(() => createSeedWorkspace(), []);
  const initialPrefs = useMemo(() => loadWorkspacePreferences(), []);
  const [initialDraft] = useState<Note>(() => makeFreshNote());
  const [historyStore] = useState(() => new UndoHistoryStore());

  const [preferences, setPreferences] = useState<WorkspacePreferences>(initialPrefs);
  const [draftNote, setDraftNote] = useState<Note | null>(initialDraft);
  const draftBaselineRef = useRef<Note | null>(initialDraft);
  const [notes, setNotes] = useState<Note[]>(seed.notes);
  const [directory, setDirectory] = useState<WorkspaceDirectory>(seed.directory);
  const [activeNoteId, setActiveNoteId] = useState<string>(initialDraft.id);
  const [mainView, setMainView] = useState<ActiveMainView>('notes');
  const [noteFilter, setNoteFilter] = useState<NoteFilter>({ kind: 'all' });
  const [listSearch, setListSearch] = useState('');
  const [pendingSelectionRestore, setPendingSelectionRestore] =
    useState<PendingSelectionRestore | null>(null);
  const restoreNonceRef = useRef<number>(0);

  const [reportInitialFilter, setReportInitialFilter] = useState<{
    mode?: ReportsHubMode;
    label?: string;
    clientId?: string;
    person?: string;
  }>({});
  const [dailyBriefingState, setDailyBriefingState] =
    useState<PersistedDailyBriefingState | null>(() => loadDailyBriefingState());
  const dailyBriefingStateRef = useRef<PersistedDailyBriefingState | null>(dailyBriefingState);
  const [isRefreshingDailyBriefing, setIsRefreshingDailyBriefing] = useState<boolean>(false);
  const aiDailyAutoGenDateRef = useRef<string | null>(null);
  const [overlayStack, setOverlayStack] = useState<OverlayEntry[]>([]);

  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 860 : false
  );
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (initialPrefs.startupLayout === 'focus') return false;
    return typeof window !== 'undefined' ? window.innerWidth > 860 : true;
  });
  const [noteListOpen, setNoteListOpen] = useState<boolean>(
    () => initialPrefs.startupLayout !== 'focus'
  );
  const [radarOpen, setRadarOpen] = useState<boolean>(() => {
    if (initialPrefs.startupLayout === 'focus') return false;
    return typeof window !== 'undefined' ? window.innerWidth > 1180 : true;
  });
  const [mobileNotesPane, setMobileNotesPane] = useState<'list' | 'editor'>('editor');
  const [radarRequestedTab, setRadarRequestedTab] = useState<'context' | 'ask' | 'outline' | null>(null);
  const prevPanelsRef = useRef<{ sidebar: boolean; noteList: boolean; radar: boolean } | null>(null);

  // Sidebar inline quick-add state
  const [sidebarAddingClient, setSidebarAddingClient] = useState(false);
  const [sidebarClientInput, setSidebarClientInput] = useState('');
  const [sidebarAddingProjectFor, setSidebarAddingProjectFor] = useState<string | null>(null); // 'internal' | clientId
  const [sidebarProjectInput, setSidebarProjectInput] = useState('');
  const [sidebarAddingLabel, setSidebarAddingLabel] = useState(false);
  const [sidebarLabelInput, setSidebarLabelInput] = useState('');

  // Workspace undo/redo notification toast
  const [workspaceToast, setWorkspaceToast] = useState<WorkspaceToastState | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('strata.theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {
      // Sandboxed iframe fallback
    }
    if (
      typeof document !== 'undefined' &&
      (document.documentElement.classList.contains('dark') ||
        (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches))
    ) {
      return 'dark';
    }
    return 'light';
  });

  const [aiConfig, setAiConfig] = useState<AiConfig>(() => loadAiConfig());
  const aiActivity = useSyncExternalStore(
    subscribeAiActivity,
    getAiActivitySnapshot,
    getAiActivitySnapshot
  );
  const [showAiStructure, setShowAiStructure] = useState(false);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);

  // Local / OneDrive / Google Drive Folder Sync State
  const [dirHandle, setDirHandle] = useState<FsDirectoryHandle | null>(null);
  const [dirPermission, setDirPermission] = useState<'granted' | 'prompt' | 'denied'>('denied');
  const [gdriveConfig, setGdriveConfig] = useState<GoogleDriveConfig>(() => loadGoogleDriveConfig());
  const gdriveConfigRef = useRef<GoogleDriveConfig>(gdriveConfig);

  const [tombstones, setTombstones] = useState<SyncTombstones>(() => createEmptyTombstones());
  const tombstonesRef = useRef<SyncTombstones>(tombstones);

  const [syncStatus, setSyncStatus] = useState<string>('IndexedDB Local');
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const initialSyncDoneRef = useRef<boolean>(false);
  const lastSyncTimestampMsRef = useRef<number>(0);

  const notesRef = useRef<Note[]>(notes);
  const directoryRef = useRef<WorkspaceDirectory>(directory);
  const dirHandleRef = useRef<FsDirectoryHandle | null>(dirHandle);
  const dirPermissionRef = useRef<'granted' | 'prompt' | 'denied'>(dirPermission);

  useEffect(() => {
    gdriveConfigRef.current = gdriveConfig;
    tombstonesRef.current = tombstones;
    notesRef.current = notes;
    directoryRef.current = directory;
    dirHandleRef.current = dirHandle;
    dirPermissionRef.current = dirPermission;
    dailyBriefingStateRef.current = dailyBriefingState;
  }, [gdriveConfig, tombstones, notes, directory, dirHandle, dirPermission, dailyBriefingState]);

  // Debounced single-note write queue so rapid typing never creates duplicate slug files
  const pendingNoteWritesRef = useRef<
    Map<string, { note: Note; originalPath?: string; customDir?: WorkspaceDirectory }>
  >(new Map());
  const noteWriteTimerRef = useRef<number | null>(null);

  const fileImportRef = useRef<HTMLInputElement | null>(null);

  const recordTombstone = useCallback(
    (kind: keyof SyncTombstones, idOrKey: string) => {
      if (!idOrKey) return;
      const nowIso = new Date().toISOString();
      setTombstones((prev) => {
        const next: SyncTombstones = {
          ...prev,
          [kind]: {
            ...prev[kind],
            [idOrKey]: nowIso,
          },
        };
        tombstonesRef.current = next;
        void saveSyncTombstones(next);
        return next;
      });
    },
    []
  );

  // Apply Light/Dark theme attribute
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('strata.theme', theme);
    } catch {
      // Ignore in sandboxed iframe
    }
  }, [theme]);

  // Track mobile viewport breakpoint and auto-close overlay drawers when entering mobile
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 860px)');
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (e.matches) {
        setSidebarOpen(false);
        setRadarOpen(false);
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Guard against duplicate paste events forwarded by webview / preview iframe hosts
  useEffect(() => {
    let lastTime = 0;
    let lastSig = '';

    const onPasteCapture = (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const now = performance.now();
      const plain = dt.getData('text/plain');
      const htmlLen = dt.getData('text/html').length;
      const firstFile = dt.files && dt.files[0] ? `${dt.files[0].type}:${dt.files[0].size}` : '';
      const types = Array.from(dt.types || []).join(',');
      const sig = `${plain.length}:${plain.slice(0, 80)}|${htmlLen}|${dt.files?.length || 0}:${firstFile}|${types}`;

      if (now - lastTime < 120 && sig === lastSig) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      lastTime = now;
      lastSig = sig;
    };

    window.addEventListener('paste', onPasteCapture, true);
    return () => window.removeEventListener('paste', onPasteCapture, true);
  }, []);

  // Focus the fresh note title immediately on desktop startup without mutating note content
  useEffect(() => {
    if (typeof window === 'undefined' || window.innerWidth <= 860) return;
    const t = window.setTimeout(() => {
      document.getElementById('note-title-input')?.focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, []);

  // Hydrate workspace from IndexedDB + run initial multi-device sync before any local overwrites
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const urlParams = consumeUrlGoogleDriveParams();
        if (urlParams.updatedConfig) {
          setGdriveConfig(urlParams.updatedConfig);
          gdriveConfigRef.current = urlParams.updatedConfig;
          if (urlParams.didPair && !isGoogleDriveTokenValid(urlParams.updatedConfig)) {
            setShowSyncModal(true);
          }
        }

        const [savedNotes, savedDir, demoPurgedV2, persistedHandle, savedTombstones] =
          await Promise.all([
            idbGet<Note[]>('notes'),
            idbGet<WorkspaceDirectory>('directory'),
            idbGet<boolean>('demoPurgedV2'),
            loadPersistedDirHandle(),
            loadSyncTombstones(),
            hydrateImagesFromIdb(),
          ]);

        if (!mounted) return;

        setTombstones(savedTombstones);
        tombstonesRef.current = savedTombstones;

        let workingNotes: Note[] = seed.notes;
        let workingDir: WorkspaceDirectory = seed.directory;

        if (savedNotes && savedDir) {
          if (!demoPurgedV2) {
            const purged = purgeLegacyDemoData(savedNotes, savedDir);
            const cleanedNotes = purged.notes.filter((n) => !isUntouchedBlankNote(n));
            workingNotes = cleanedNotes;
            workingDir = purged.directory;
            setNotes((prev) => {
              if (prev.length === 0) return cleanedNotes;
              const hydratedIds = new Set(cleanedNotes.map((n) => n.id));
              const newlyEdited = prev.filter((n) => !hydratedIds.has(n.id));
              return [...newlyEdited, ...cleanedNotes];
            });
            setDirectory(purged.directory);
            await idbSet('notes', cleanedNotes);
            await idbSet('directory', purged.directory);
            await idbSet('demoPurgedV2', true);
          } else {
            const cleanedNotes = savedNotes.filter((n) => !isUntouchedBlankNote(n));
            workingNotes = cleanedNotes;
            workingDir = savedDir;
            setNotes((prev) => {
              if (prev.length === 0) return cleanedNotes;
              const hydratedIds = new Set(cleanedNotes.map((n) => n.id));
              const newlyEdited = prev.filter((n) => !hydratedIds.has(n.id));
              return [...newlyEdited, ...cleanedNotes];
            });
            setDirectory(savedDir);
            if (cleanedNotes.length !== savedNotes.length) {
              await idbSet('notes', cleanedNotes);
            }
          }
        } else {
          await idbSet('directory', seed.directory);
          await idbSet('demoPurgedV2', true);
        }

        const activeGdrive = urlParams.updatedConfig || gdriveConfigRef.current;

        // Priority 1: Direct Google Drive Cloud Sync if enabled & token valid
        if (activeGdrive.enabled && isGoogleDriveTokenValid(activeGdrive)) {
          try {
            setIsSyncing(true);
            setSyncStatus(`Syncing Google Drive (${activeGdrive.folderName || 'Strata'})…`);
            const resolved = await resolveOrCreateDriveWorkspaceFolder(
              activeGdrive.accessToken,
              activeGdrive.folderName || 'Strata',
              activeGdrive.folderId || undefined
            );
            const updatedCfg: GoogleDriveConfig = {
              ...activeGdrive,
              folderId: resolved.id,
              folderName: resolved.name,
            };
            saveGoogleDriveConfig(updatedCfg);
            if (mounted) {
              setGdriveConfig(updatedCfg);
              gdriveConfigRef.current = updatedCfg;
            }
            const gdriveHandle = new GoogleDriveDirectoryHandle({
              name: resolved.name,
              primaryFolderId: resolved.id,
              duplicateFolderIds: resolved.duplicateIds,
              accessTokenGetter: () => gdriveConfigRef.current.accessToken,
            });
            if (mounted) {
              setDirHandle(gdriveHandle);
              dirHandleRef.current = gdriveHandle;
              setDirPermission('granted');
              dirPermissionRef.current = 'granted';
            }
            const synced = await syncWorkspaceWithFolder(
              gdriveHandle,
              workingNotes,
              workingDir,
              savedTombstones
            );
            if (mounted) {
              setNotes(synced.notes);
              setDirectory(synced.directory);
              setTombstones(synced.tombstones);
              tombstonesRef.current = synced.tombstones;
              setLastSyncedAt(new Date().toISOString());
              lastSyncTimestampMsRef.current = Date.now();
              setSyncStatus(`Google Drive: ${resolved.name}`);
            }
          } catch {
            if (mounted) {
              setSyncStatus(`Reconnect Drive: ${activeGdrive.folderName || 'Strata'}`);
            }
          } finally {
            if (mounted) {
              setIsSyncing(false);
              initialSyncDoneRef.current = true;
            }
          }
        } else if (activeGdrive.enabled && !isGoogleDriveTokenValid(activeGdrive)) {
          setSyncStatus(`Reconnect Drive: ${activeGdrive.folderName || 'Strata'}`);
          initialSyncDoneRef.current = true;
        } else if (persistedHandle.handle) {
          // Priority 2: Connected Local / Mounted Cloud Folder
          setDirHandle(persistedHandle.handle);
          dirHandleRef.current = persistedHandle.handle;
          setDirPermission(persistedHandle.permission);
          dirPermissionRef.current = persistedHandle.permission;

          if (persistedHandle.permission === 'granted') {
            try {
              setIsSyncing(true);
              setSyncStatus(`Syncing ${persistedHandle.handle.name}…`);
              const synced = await syncWorkspaceWithFolder(
                persistedHandle.handle,
                workingNotes,
                workingDir,
                savedTombstones
              );
              if (mounted) {
                setDirHandle(synced.effectiveRoot);
                dirHandleRef.current = synced.effectiveRoot;
                setNotes(synced.notes);
                setDirectory(synced.directory);
                setTombstones(synced.tombstones);
                tombstonesRef.current = synced.tombstones;
                setLastSyncedAt(new Date().toISOString());
                lastSyncTimestampMsRef.current = Date.now();
                setSyncStatus(`Synced: ${synced.effectiveRoot.name}`);
              }
            } catch {
              if (mounted) {
                setSyncStatus(`Sync warning: ${persistedHandle.handle.name}`);
              }
            } finally {
              if (mounted) {
                setIsSyncing(false);
                initialSyncDoneRef.current = true;
              }
            }
          } else {
            setSyncStatus(`Reconnect: ${persistedHandle.handle.name}`);
            initialSyncDoneRef.current = true;
          }
        } else {
          initialSyncDoneRef.current = true;
        }
      } finally {
        if (mounted) setHydrated(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [seed]);

  // Persist notes & directory to IndexedDB on change
  useEffect(() => {
    if (!hydrated) return;
    idbSet('notes', notes);
  }, [notes, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    idbSet('directory', directory);
    if (dirHandle && dirPermission === 'granted' && initialSyncDoneRef.current) {
      enqueueStorageTask(() =>
        writeDirectoryMetadata(dirHandle, directory, {
          tombstones: tombstonesRef.current,
          syncedNoteIds: notesRef.current.map((n) => n.id),
        })
      ).catch(() => {});
    }
  }, [directory, hydrated, dirHandle, dirPermission]);

  const activeNote = useMemo(() => {
    const savedMatch = notes.find((n) => n.id === activeNoteId);
    if (savedMatch) return savedMatch;
    if (draftNote && draftNote.id === activeNoteId) return draftNote;
    return notes[0] || draftNote || initialDraft;
  }, [notes, activeNoteId, draftNote, initialDraft]);

  const getHistoryUiSnapshot = useCallback(
    () => historyStore.getUiSnapshot(activeNote.id),
    [historyStore, activeNote.id]
  );
  const historyUi = useSyncExternalStore(
    historyStore.subscribe,
    getHistoryUiSnapshot,
    getHistoryUiSnapshot
  );

  const showToastMessage = useCallback(
    (message: string, action: 'undo' | 'redo' | null = 'undo') => {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
      setWorkspaceToast({ message, action });
      undoTimerRef.current = window.setTimeout(() => {
        setWorkspaceToast(null);
      }, 7000);
    },
    []
  );

  const flushPendingNoteWrites = useCallback(async () => {
    if (noteWriteTimerRef.current !== null) {
      window.clearTimeout(noteWriteTimerRef.current);
      noteWriteTimerRef.current = null;
    }
    const handle = dirHandleRef.current;
    if (!handle || dirPermissionRef.current !== 'granted') {
      pendingNoteWritesRef.current.clear();
      return;
    }
    const entries = Array.from(pendingNoteWritesRef.current.values());
    pendingNoteWritesRef.current.clear();
    if (entries.length === 0) return;

    await enqueueStorageTask(async () => {
      try {
        for (const item of entries) {
          const nextPath = await writeNoteToFolder(
            handle,
            item.note,
            item.customDir || directoryRef.current,
            item.originalPath
          );
          if (nextPath !== item.note.filePath) {
            setNotes((prev) =>
              prev.map((n) => (n.id === item.note.id ? { ...n, filePath: nextPath } : n))
            );
          }
        }
        setLastSyncedAt(new Date().toISOString());
        lastSyncTimestampMsRef.current = Date.now();
      } catch {
        setSyncStatus('Sync warning — check folder access');
      }
    });
  }, []);

  const syncSingleNoteToDisk = useCallback(
    (updatedNote: Note, previousPath?: string, customDir?: WorkspaceDirectory) => {
      if (!dirHandleRef.current || dirPermissionRef.current !== 'granted') return;

      const existingPending = pendingNoteWritesRef.current.get(updatedNote.id);
      pendingNoteWritesRef.current.set(updatedNote.id, {
        note: updatedNote,
        // Preserve the earliest path before typing began so we delete the old file once
        originalPath: existingPending ? existingPending.originalPath : previousPath,
        customDir: customDir || existingPending?.customDir,
      });

      if (noteWriteTimerRef.current !== null) {
        window.clearTimeout(noteWriteTimerRef.current);
      }

      const delayMs = dirHandleRef.current.providerKind === 'gdrive' ? 850 : 500;
      noteWriteTimerRef.current = window.setTimeout(() => {
        void flushPendingNoteWrites();
      }, delayMs);
    },
    [flushPendingNoteWrites]
  );

  const syncWorkspaceDiffToDisk = useCallback(
    async (prevNotes: Note[], targetNotes: Note[], targetDir: WorkspaceDirectory) => {
      if (!dirHandle || dirPermission !== 'granted') return;
      await flushPendingNoteWrites();
      await enqueueStorageTask(async () => {
        try {
          const targetIds = new Set(targetNotes.map((n) => n.id));
          for (const oldNote of prevNotes) {
            if (!targetIds.has(oldNote.id) && oldNote.filePath) {
              await removeNestedFileIfExists(dirHandle, oldNote.filePath);
            }
          }
          const prevById = new Map(prevNotes.map((n) => [n.id, n]));
          for (const nextNote of targetNotes) {
            const prevNote = prevById.get(nextNote.id);
            if (
              !prevNote ||
              !areNotesContentEqual(prevNote, nextNote) ||
              prevNote.filePath !== nextNote.filePath
            ) {
              await writeNoteToFolder(dirHandle, nextNote, targetDir, prevNote?.filePath);
            }
          }
          await writeDirectoryMetadata(dirHandle, targetDir, {
            tombstones: tombstonesRef.current,
            syncedNoteIds: targetNotes.map((n) => n.id),
          });
          setLastSyncedAt(new Date().toISOString());
          lastSyncTimestampMsRef.current = Date.now();
        } catch {
          setSyncStatus('Sync warning — check folder access');
        }
      });
    },
    [dirHandle, dirPermission, flushPendingNoteWrites]
  );

  const captureWorkspaceSnapshot = useCallback(
    (): WorkspaceSnapshotState => ({
      notes,
      directory,
      activeNoteId,
      draftNote,
      noteFilter,
      mainView,
    }),
    [notes, directory, activeNoteId, draftNote, noteFilter, mainView]
  );

  const applyWorkspaceSnapshot = useCallback(
    (target: WorkspaceSnapshotState, prev: WorkspaceSnapshotState) => {
      setNotes(target.notes);
      setDirectory(target.directory);
      setDraftNote(target.draftNote);
      draftBaselineRef.current = target.draftNote;
      setActiveNoteId(target.activeNoteId);
      setNoteFilter(target.noteFilter);
      setMainView(target.mainView);
      setOverlayStack((prevStack) =>
        prevStack.filter(
          (entry) => entry.kind !== 'note' || target.notes.some((n) => n.id === entry.noteId)
        )
      );
      void syncWorkspaceDiffToDisk(prev.notes, target.notes, target.directory);
    },
    [syncWorkspaceDiffToDisk]
  );

  const pushWorkspaceHistory = useCallback(
    (label: string, options?: { coalesceKey?: string | null; showToast?: boolean }) => {
      const snap = captureWorkspaceSnapshot();
      historyStore.recordWorkspaceChange(snap, {
        label,
        coalesceKey: options?.coalesceKey ?? null,
      });
      if (options?.showToast) {
        showToastMessage(label, 'undo');
      }
    },
    [captureWorkspaceSnapshot, historyStore, showToastMessage]
  );

  const handleUndoWorkspace = useCallback((): boolean => {
    const current = captureWorkspaceSnapshot();
    const res = historyStore.undoWorkspace(current);
    if (!res) return false;
    applyWorkspaceSnapshot(res.state, current);
    showToastMessage(`Undid: ${res.label}`, 'redo');
    return true;
  }, [applyWorkspaceSnapshot, captureWorkspaceSnapshot, historyStore, showToastMessage]);

  const handleRedoWorkspace = useCallback((): boolean => {
    const current = captureWorkspaceSnapshot();
    const res = historyStore.redoWorkspace(current);
    if (!res) return false;
    applyWorkspaceSnapshot(res.state, current);
    showToastMessage(`Redid: ${res.label}`, 'undo');
    return true;
  }, [applyWorkspaceSnapshot, captureWorkspaceSnapshot, historyStore, showToastMessage]);

  const handleSyncNoteSelection = useCallback(
    (selection: EditorSelectionSnapshot) => {
      historyStore.updateNoteSelection(activeNote.id, selection);
    },
    [activeNote.id, historyStore]
  );

  const applyRestoredNoteState = useCallback(
    (
      targetNote: Note,
      targetWasDraft: boolean,
      selection: EditorSelectionSnapshot,
      previousFilePath?: string
    ) => {
      if (targetWasDraft) {
        setNotes((prev) => prev.filter((n) => n.id !== targetNote.id));
        draftBaselineRef.current = targetNote;
        setDraftNote(targetNote);
        setActiveNoteId(targetNote.id);
        if (previousFilePath && dirHandle && dirPermission === 'granted') {
          removeNestedFileIfExists(dirHandle, previousFilePath).catch(() => {});
        }
      } else {
        if (draftBaselineRef.current?.id === targetNote.id) {
          draftBaselineRef.current = null;
          setDraftNote(null);
        }
        const computedPath = computeNoteFilePath(targetNote, directory);
        const withPath = {
          ...targetNote,
          filePath: computedPath,
          updatedAt: new Date().toISOString(),
        };
        setNotes((prev) =>
          prev.some((n) => n.id === withPath.id)
            ? prev.map((n) => (n.id === withPath.id ? withPath : n))
            : [withPath, ...prev]
        );
        setActiveNoteId(withPath.id);
        syncSingleNoteToDisk(withPath, previousFilePath);
      }

      setPendingSelectionRestore({
        noteId: targetNote.id,
        selection,
        nonce: ++restoreNonceRef.current,
      });
    },
    [dirHandle, dirPermission, directory, syncSingleNoteToDisk]
  );

  const handleUndoNote = useCallback((): boolean => {
    const currentWasDraft = Boolean(
      draftNote && draftNote.id === activeNote.id && !notes.some((n) => n.id === activeNote.id)
    );
    const res = historyStore.undoNote(activeNote.id, activeNote, currentWasDraft);
    if (!res) return false;
    applyRestoredNoteState(res.note, res.wasDraft, res.selection, activeNote.filePath);
    return true;
  }, [activeNote, applyRestoredNoteState, draftNote, historyStore, notes]);

  const handleRedoNote = useCallback((): boolean => {
    const currentWasDraft = Boolean(
      draftNote && draftNote.id === activeNote.id && !notes.some((n) => n.id === activeNote.id)
    );
    const res = historyStore.redoNote(activeNote.id, activeNote, currentWasDraft);
    if (!res) return false;
    applyRestoredNoteState(res.note, res.wasDraft, res.selection, activeNote.filePath);
    return true;
  }, [activeNote, applyRestoredNoteState, draftNote, historyStore, notes]);

  const openOverlay = useCallback((entry: OverlayEntry) => {
    setOverlayStack([entry]);
  }, []);

  const pushOverlay = useCallback((entry: OverlayEntry) => {
    setOverlayStack((prev) =>
      isSameOverlayEntry(prev[prev.length - 1], entry) ? prev : [...prev, entry]
    );
  }, []);

  const popOverlay = useCallback(() => {
    setOverlayStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : []));
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlayStack([]);
  }, []);

  const openNoteEditor = useCallback((id: string) => {
    if (draftBaselineRef.current && draftBaselineRef.current.id !== id) {
      draftBaselineRef.current = null;
      setDraftNote(null);
    }
    setOverlayStack([]);
    setActiveNoteId(id);
    setMainView('notes');
    setMobileNotesPane('editor');
    if (typeof window !== 'undefined' && window.innerWidth <= 860) {
      setSidebarOpen(false);
      setRadarOpen(false);
    }
  }, []);

  const applyNotesFilter = useCallback((nextFilter: NoteFilter) => {
    setOverlayStack([]);
    setMainView('notes');
    setNoteFilter(nextFilter);
    setNoteListOpen(true);
    setMobileNotesPane('list');
    if (typeof window !== 'undefined' && window.innerWidth <= 860) {
      setSidebarOpen(false);
      setRadarOpen(false);
    }
  }, []);

  const switchPrimaryView = useCallback((view: ActiveMainView) => {
    setOverlayStack([]);
    setMainView(view);
    if (typeof window !== 'undefined' && window.innerWidth <= 860) {
      setSidebarOpen(false);
      setRadarOpen(false);
    }
  }, []);

  const openNewNoteInEditor = useCallback(
    (id: string) => {
      setOverlayStack([]);
      setActiveNoteId(id);
      setMainView('notes');
      setMobileNotesPane('editor');
      if (preferences.focusOnNewNote) {
        if (sidebarOpen || noteListOpen || radarOpen) {
          prevPanelsRef.current = {
            sidebar: sidebarOpen,
            noteList: noteListOpen,
            radar: radarOpen,
          };
        }
        setSidebarOpen(false);
        setNoteListOpen(false);
        setRadarOpen(false);
      } else if (typeof window !== 'undefined' && window.innerWidth <= 860) {
        setSidebarOpen(false);
        setRadarOpen(false);
      }
    },
    [preferences.focusOnNewNote, sidebarOpen, noteListOpen, radarOpen]
  );

  // Global keyboard shortcuts: Ctrl/Cmd+K (Command Palette), Alt+N (Instant New Note), Ctrl/Cmd+Z / Shift+Z / Y (Undo/Redo)
  const handleSpinUpNote = useCallback(() => {
    const inheritedScope =
      noteFilter.kind === 'client' || (noteFilter.kind === 'project' && noteFilter.clientId)
        ? 'client'
        : noteFilter.kind === 'internal' || (noteFilter.kind === 'project' && !noteFilter.clientId)
        ? 'internal'
        : 'inbox';

    const fresh = makeFreshNote({
      scope: inheritedScope,
      clientId: noteFilter.clientId || null,
      projectId: noteFilter.projectId || null,
      labels: noteFilter.label ? [noteFilter.label] : [],
      participants: noteFilter.personName ? [noteFilter.personName] : [],
    });

    draftBaselineRef.current = fresh;
    setDraftNote(fresh);
    openNewNoteInEditor(fresh.id);
    setTimeout(() => {
      document.getElementById('note-title-input')?.focus();
    }, 30);
  }, [noteFilter, openNewNoteInEditor]);

  const isFocusMode =
    mainView === 'notes' &&
    (isMobile
      ? mobileNotesPane === 'editor' && !sidebarOpen && !radarOpen
      : !sidebarOpen && !noteListOpen && !radarOpen);

  const handleToggleFocusMode = useCallback(() => {
    const currentlyFocused =
      mainView === 'notes' &&
      (isMobile
        ? mobileNotesPane === 'editor' && !sidebarOpen && !radarOpen
        : !sidebarOpen && !noteListOpen && !radarOpen);

    if (currentlyFocused) {
      const saved = prevPanelsRef.current;
      if (isMobile) {
        setMobileNotesPane('list');
      } else if (saved && (saved.sidebar || saved.noteList || saved.radar)) {
        setSidebarOpen(saved.sidebar);
        setNoteListOpen(saved.noteList);
        setRadarOpen(saved.radar);
      } else {
        setSidebarOpen(true);
        setNoteListOpen(true);
        setRadarOpen(typeof window !== 'undefined' ? window.innerWidth > 1180 : true);
      }
      prevPanelsRef.current = null;
    } else {
      prevPanelsRef.current = {
        sidebar: sidebarOpen,
        noteList: noteListOpen,
        radar: radarOpen,
      };
      setMainView('notes');
      setMobileNotesPane('editor');
      setSidebarOpen(false);
      setNoteListOpen(false);
      setRadarOpen(false);
    }
  }, [isMobile, mainView, mobileNotesPane, sidebarOpen, noteListOpen, radarOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleSpinUpNote();
        return;
      }
      if (
        (e.altKey && !e.ctrlKey && !e.metaKey && (e.key.toLowerCase() === 'z' || e.key === 'Ω')) ||
        ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === '\\')
      ) {
        e.preventDefault();
        handleToggleFocusMode();
        return;
      }

      const isMod = e.metaKey || e.ctrlKey;
      const keyLower = e.key.toLowerCase();
      const isUndoShortcut = isMod && !e.altKey && !e.shiftKey && keyLower === 'z';
      const isRedoShortcut =
        (isMod && !e.altKey && e.shiftKey && keyLower === 'z') ||
        (isMod && !e.altKey && !e.shiftKey && keyLower === 'y');

      if (!isUndoShortcut && !isRedoShortcut) return;

      if (
        showCommandPalette ||
        showAiStructure ||
        showAiSettings ||
        document.querySelector('.modal-backdrop, .lightbox-backdrop')
      ) {
        return;
      }

      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl) {
        const tag = activeEl.tagName.toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const isNoteTitle = activeEl.id === 'note-title-input';
          const isRawMd = activeEl.classList.contains('raw-markdown-textarea');
          const isMetaDate = activeEl.classList.contains('meta-date-input');
          const isDirField = activeEl.classList.contains('directory-inline-field');
          const isInlineAdd =
            activeEl.classList.contains('inline-add-input') ||
            activeEl.classList.contains('sidebar-inline-input');

          if (isDirField) {
            e.preventDefault();
            if (isUndoShortcut) handleUndoWorkspace();
            else handleRedoWorkspace();
            return;
          }

          if (isInlineAdd) {
            if ((activeEl as HTMLInputElement).value !== '') {
              return;
            }
          } else if (!isNoteTitle && !isRawMd && !isMetaDate) {
            return;
          }
        }
      }

      const focusInNoteEditor = Boolean(
        activeEl &&
          (activeEl.id === 'note-title-input' ||
            activeEl.classList.contains('raw-markdown-textarea') ||
            activeEl.closest('.word-doc-body') ||
            (activeEl.closest('.meta-grid') &&
              !(
                activeEl.classList.contains('inline-add-input') &&
                (activeEl as HTMLInputElement).value !== ''
              )))
      );

      const inNotesEditor =
        mainView === 'notes' &&
        overlayStack.length === 0 &&
        (!isMobile || mobileNotesPane === 'editor');

      if (isUndoShortcut) {
        const target = historyStore.resolveUndoTarget({
          activeNoteId: activeNote.id,
          inNotesEditor,
          focusInNoteEditor,
          workspaceToastActive: workspaceToast !== null,
        });
        if (focusInNoteEditor) e.preventDefault();
        if (target === 'note') {
          e.preventDefault();
          handleUndoNote();
        } else if (target === 'workspace') {
          e.preventDefault();
          handleUndoWorkspace();
        }
      } else {
        const target = historyStore.resolveRedoTarget({
          activeNoteId: activeNote.id,
          inNotesEditor,
          focusInNoteEditor,
          workspaceToastActive: workspaceToast !== null,
        });
        if (focusInNoteEditor) e.preventDefault();
        if (target === 'note') {
          e.preventDefault();
          handleRedoNote();
        } else if (target === 'workspace') {
          e.preventDefault();
          handleRedoWorkspace();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeNote.id,
    handleRedoNote,
    handleRedoWorkspace,
    handleSpinUpNote,
    handleToggleFocusMode,
    handleUndoNote,
    handleUndoWorkspace,
    historyStore,
    isMobile,
    mainView,
    mobileNotesPane,
    overlayStack.length,
    showAiSettings,
    showAiStructure,
    showCommandPalette,
    workspaceToast,
  ]);

  const handleOpenOrCreateNoteByTitle = useCallback(
    (targetTitle: string) => {
      const found = notes.find(
        (x) => x.title.toLowerCase() === targetTitle.toLowerCase()
      );
      if (found) {
        openNoteEditor(found.id);
      } else {
        pushWorkspaceHistory(`Created note "${targetTitle}"`);
        const raw = makeFreshNote({
          title: targetTitle,
          scope: activeNote.scope,
          clientId: activeNote.clientId,
          projectId: activeNote.projectId,
        });
        const created = { ...raw, filePath: computeNoteFilePath(raw, directory) };
        draftBaselineRef.current = null;
        setDraftNote(null);
        setNotes((prev) => [created, ...prev]);
        syncSingleNoteToDisk(created);
        openNewNoteInEditor(created.id);
      }
    },
    [
      notes,
      activeNote.scope,
      activeNote.clientId,
      activeNote.projectId,
      directory,
      pushWorkspaceHistory,
      syncSingleNoteToDisk,
      openNoteEditor,
      openNewNoteInEditor,
    ]
  );

  const handlePeekOrCreateNoteByTitle = useCallback(
    (targetTitle: string) => {
      const found = notes.find(
        (x) => x.title.toLowerCase() === targetTitle.toLowerCase()
      );
      if (found) {
        if (found.id === activeNote.id) {
          setOverlayStack([]);
        } else {
          const entry: OverlayEntry = { kind: 'note', noteId: found.id };
          setOverlayStack((prev) =>
            prev.length > 0
              ? isSameOverlayEntry(prev[prev.length - 1], entry)
                ? prev
                : [...prev, entry]
              : [entry]
          );
        }
      } else {
        pushWorkspaceHistory(`Created note "${targetTitle}"`);
        const raw = makeFreshNote({
          title: targetTitle,
          scope: activeNote.scope,
          clientId: activeNote.clientId,
          projectId: activeNote.projectId,
        });
        const created = { ...raw, filePath: computeNoteFilePath(raw, directory) };
        setNotes((prev) => [created, ...prev]);
        syncSingleNoteToDisk(created);
        const entry: OverlayEntry = { kind: 'note', noteId: created.id };
        setOverlayStack((prev) => (prev.length > 0 ? [...prev, entry] : [entry]));
      }
    },
    [
      notes,
      activeNote.id,
      activeNote.scope,
      activeNote.clientId,
      activeNote.projectId,
      directory,
      pushWorkspaceHistory,
      syncSingleNoteToDisk,
    ]
  );

  const allWorkspaceLabels = useMemo(() => {
    const set = new Set<string>(directory.customLabels);
    for (const n of notes) {
      for (const l of getAllNoteLabels(n)) set.add(l);
    }
    return Array.from(set).sort();
  }, [notes, directory.customLabels]);

  const globalCounts = useMemo(() => {
    let openTasks = 0;
    let totalDecisions = 0;
    let inboxCount = 0;
    let dailyUrgentCount = 0;
    const today = getTodayDateString();
    for (const n of notes) {
      if (n.scope === 'inbox') inboxCount++;
      const items = parseNoteItems(n, directory.people);
      for (const t of items.tasks) {
        if (t.status !== 'done') {
          openTasks++;
          if (t.dueDate && t.dueDate <= today) {
            dailyUrgentCount++;
          }
        }
      }
      totalDecisions += items.decisions.length;
    }
    return { openTasks, totalDecisions, inboxCount, dailyUrgentCount };
  }, [notes, directory.people]);

  const filteredNotesList = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    return notes.filter((n) => {
      if (noteFilter.kind === 'inbox' && n.scope !== 'inbox') return false;
      if (noteFilter.kind === 'internal' && n.scope !== 'internal') return false;
      if (noteFilter.kind === 'client' && n.clientId !== noteFilter.clientId) return false;
      if (noteFilter.kind === 'project' && n.projectId !== noteFilter.projectId) return false;
      if (noteFilter.kind === 'label' && !getAllNoteLabels(n).includes(noteFilter.label || '')) return false;
      if (noteFilter.kind === 'person') {
        const target = (noteFilter.personName || '').toLowerCase();
        const inPart = n.participants.some((p) => p.toLowerCase() === target);
        const inMent = extractInlineMentions(n.body, directory.people).some(
          (p) => p.toLowerCase() === target
        );
        if (!inPart && !inMent) return false;
      }
      if (q) {
        const hay = `${n.title} ${n.body} ${n.participants.join(' ')} ${getAllNoteLabels(n).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [notes, noteFilter, listSearch, directory.people]);

  const commitNoteToStateAndDisk = useCallback(
    (updated: Note) => {
      if (draftBaselineRef.current?.id === updated.id) {
        draftBaselineRef.current = null;
        setDraftNote(null);
      }
      const prevNote = notes.find((n) => n.id === updated.id);
      const computedPath = computeNoteFilePath(updated, directory);
      const withPath = { ...updated, filePath: computedPath };
      setNotes((prev) =>
        prev.some((n) => n.id === updated.id)
          ? prev.map((n) => (n.id === updated.id ? withPath : n))
          : [withPath, ...prev]
      );
      syncSingleNoteToDisk(withPath, prevNote?.filePath);
    },
    [notes, directory, syncSingleNoteToDisk]
  );

  const handleRefreshDailyBriefing = useCallback(
    async (windowDays = 7) => {
      const today = getTodayDateString();
      const currentNotes = notesRef.current;
      const currentDir = directoryRef.current;
      const data = computeDailyBriefingData(currentNotes, currentDir, today, windowDays);
      setIsRefreshingDailyBriefing(true);
      try {
        const result = await generateDailyBriefingWithAiOrFallback(data, currentDir, aiConfig);
        const nowIso = new Date().toISOString();
        const nextState: PersistedDailyBriefingState = {
          date: today,
          generatedAt: nowIso,
          sourceSignature: data.sourceSignature,
          overviewMarkdown: result.overviewMarkdown,
          fullNoteMarkdown: result.fullNoteMarkdown,
          usedProvider: result.usedProvider,
          privacyReport: result.privacyReport,
        };
        saveDailyBriefingState(nextState);
        dailyBriefingStateRef.current = nextState;
        setDailyBriefingState(nextState);

        const existingDaily = notesRef.current.find((n) => n.id === DAILY_BRIEFING_NOTE_ID);
        const built = buildDailyBriefingNote({
          existingNote: existingDaily,
          todayDate: today,
          fullNoteMarkdown: result.fullNoteMarkdown,
          directory: directoryRef.current,
        });
        setNotes((prev) =>
          prev.some((n) => n.id === DAILY_BRIEFING_NOTE_ID)
            ? prev.map((n) => (n.id === DAILY_BRIEFING_NOTE_ID ? built : n))
            : [built, ...prev]
        );
        syncSingleNoteToDisk(built, existingDaily?.filePath);
      } finally {
        setIsRefreshingDailyBriefing(false);
      }
    },
    [aiConfig, syncSingleNoteToDisk]
  );

  const handleOpenDailyReportNote = useCallback(() => {
    const existing = notesRef.current.find((n) => n.id === DAILY_BRIEFING_NOTE_ID);
    if (existing) {
      openNoteEditor(existing.id);
      return;
    }
    const today = getTodayDateString();
    const currentDir = directoryRef.current;
    const data = computeDailyBriefingData(notesRef.current, currentDir, today, 7);
    const prev = dailyBriefingStateRef.current;
    const deterministic = buildDeterministicDailyBriefing(data, currentDir);
    const overviewMd =
      prev && prev.date === today && prev.overviewMarkdown.trim()
        ? prev.overviewMarkdown
        : deterministic.overviewMarkdown;
    const fullMarkdown = composeFullDailyNoteMarkdown(overviewMd, data, currentDir);
    const built = buildDailyBriefingNote({
      todayDate: today,
      fullNoteMarkdown: fullMarkdown,
      directory: currentDir,
    });
    setNotes((prevNotes) => [built, ...prevNotes]);
    syncSingleNoteToDisk(built);
    openNoteEditor(built.id);
  }, [openNoteEditor, syncSingleNoteToDisk]);

  // Auto-update the Daily Briefing state & Daily Report Note whenever source notes or date change
  useEffect(() => {
    if (!hydrated) return;
    const sourceNotes = notes.filter((n) => !isDailyBriefingNote(n));
    const hasDailyNote = notes.some((n) => n.id === DAILY_BRIEFING_NOTE_ID);
    if (sourceNotes.length === 0 && !hasDailyNote) return;

    const timer = window.setTimeout(() => {
      const today = getTodayDateString();
      const currentNotes = notesRef.current;
      const currentDir = directoryRef.current;
      const data = computeDailyBriefingData(currentNotes, currentDir, today, 7);
      const prev = dailyBriefingStateRef.current;
      const deterministic = buildDeterministicDailyBriefing(data, currentDir);

      const preserveAiOverview =
        prev &&
        prev.date === today &&
        prev.usedProvider !== 'Local Smart Engine' &&
        Boolean(prev.overviewMarkdown.trim());

      const overviewMd = preserveAiOverview
        ? prev.overviewMarkdown
        : deterministic.overviewMarkdown;
      const usedProvider = preserveAiOverview ? prev.usedProvider : deterministic.usedProvider;
      const fullMarkdown = composeFullDailyNoteMarkdown(overviewMd, data, currentDir);
      const stateNeedsUpdate =
        !prev || prev.date !== today || prev.sourceSignature !== data.sourceSignature;

      const nowIso = stateNeedsUpdate ? new Date().toISOString() : prev.generatedAt;

      if (stateNeedsUpdate) {
        const nextState: PersistedDailyBriefingState = {
          date: today,
          generatedAt: nowIso,
          sourceSignature: data.sourceSignature,
          overviewMarkdown: overviewMd,
          fullNoteMarkdown: fullMarkdown,
          usedProvider,
        };
        saveDailyBriefingState(nextState);
        dailyBriefingStateRef.current = nextState;
        setDailyBriefingState(nextState);
      }

      // Keep the auto-updated Daily Report note synchronized in the workspace
      if (activeNoteId !== DAILY_BRIEFING_NOTE_ID) {
        const existingDaily = currentNotes.find((n) => n.id === DAILY_BRIEFING_NOTE_ID);
        if (
          !existingDaily ||
          existingDaily.date !== today ||
          existingDaily.body !== fullMarkdown
        ) {
          const built = buildDailyBriefingNote({
            existingNote: existingDaily,
            todayDate: today,
            fullNoteMarkdown: fullMarkdown,
            directory: currentDir,
          });
          setNotes((prevNotes) =>
            prevNotes.some((n) => n.id === DAILY_BRIEFING_NOTE_ID)
              ? prevNotes.map((n) => (n.id === DAILY_BRIEFING_NOTE_ID ? built : n))
              : [built, ...prevNotes]
          );
          syncSingleNoteToDisk(built, existingDaily?.filePath);
        }
      }

      // If an external AI provider is configured and we haven't generated today's AI briefing yet, trigger once
      if (
        aiConfig.provider !== 'local' &&
        (!prev || prev.date !== today || prev.usedProvider === 'Local Smart Engine') &&
        aiDailyAutoGenDateRef.current !== today
      ) {
        aiDailyAutoGenDateRef.current = today;
        void handleRefreshDailyBriefing(7);
      }
    }, 150);

    return () => window.clearTimeout(timer);
  }, [
    hydrated,
    notes,
    directory,
    activeNoteId,
    aiConfig.provider,
    handleRefreshDailyBriefing,
    syncSingleNoteToDisk,
  ]);

  const handleUpdateNote = useCallback(
    (updated: Note, meta?: NoteEditMeta) => {
      const baseline = draftBaselineRef.current;
      let prevNote: Note | undefined;
      let prevWasDraft = false;

      if (baseline && baseline.id === updated.id) {
        if (!hasNoteChangedFromDraft(updated, baseline)) {
          if (meta?.selectionAfter !== undefined) {
            historyStore.updateNoteSelection(updated.id, meta.selectionAfter);
          }
          return;
        }
        prevNote = baseline;
        prevWasDraft = true;
        draftBaselineRef.current = null;
        setDraftNote(null);
      } else {
        prevNote = notes.find((n) => n.id === updated.id);
      }

      const computedPath = computeNoteFilePath(updated, directory);
      const withPath = { ...updated, filePath: computedPath };

      if (prevNote) {
        historyStore.recordNoteChange(prevNote, prevWasDraft, withPath, meta);
      }

      setNotes((prev) =>
        prev.some((n) => n.id === updated.id)
          ? prev.map((n) => (n.id === updated.id ? withPath : n))
          : [withPath, ...prev]
      );
      syncSingleNoteToDisk(withPath, prevNote?.filePath);
    },
    [notes, directory, historyStore, syncSingleNoteToDisk]
  );

  const handleDeleteNote = useCallback(
    (noteId: string) => {
      if (draftNote && draftNote.id === noteId) {
        if (notes.length > 0) {
          draftBaselineRef.current = null;
          setDraftNote(null);
          setActiveNoteId(notes[0].id);
          if (typeof window !== 'undefined' && window.innerWidth <= 860) {
            setMobileNotesPane('list');
          }
        } else {
          const fresh = makeFreshNote();
          draftBaselineRef.current = fresh;
          setDraftNote(fresh);
          setActiveNoteId(fresh.id);
          setMobileNotesPane('editor');
        }
        return;
      }

      const target = notes.find((n) => n.id === noteId);
      if (!target) return;
      pushWorkspaceHistory(`Deleted note "${target.title || 'Untitled Note'}"`, { showToast: true });
      recordTombstone('notes', noteId);
      pendingNoteWritesRef.current.delete(noteId);

      const remaining = notes.filter((n) => n.id !== noteId);
      if (remaining.length === 0) {
        const fresh = makeFreshNote();
        draftBaselineRef.current = fresh;
        setDraftNote(fresh);
        setNotes([]);
        setActiveNoteId(fresh.id);
        setMobileNotesPane('editor');
      } else {
        setNotes(remaining);
        if (activeNoteId === noteId) {
          draftBaselineRef.current = null;
          setDraftNote(null);
          setActiveNoteId(remaining[0].id);
        }
        if (typeof window !== 'undefined' && window.innerWidth <= 860) {
          setMobileNotesPane('list');
        }
      }
      if (dirHandle && dirPermission === 'granted') {
        const activeHandle = dirHandle;
        const targetPath = target.filePath;
        const nextIds = remaining.map((n) => n.id);
        enqueueStorageTask(async () => {
          if (targetPath) {
            await removeNestedFileIfExists(activeHandle, targetPath);
          }
          await writeDirectoryMetadata(activeHandle, directoryRef.current, {
            tombstones: tombstonesRef.current,
            syncedNoteIds: nextIds,
          });
        }).catch(() => {});
      }
    },
    [draftNote, notes, activeNoteId, dirHandle, dirPermission, pushWorkspaceHistory, recordTombstone]
  );

  const handleEnsurePerson = useCallback(
    (rawName: string, clientId: string | null = null, email?: string): Person => {
      const clean = rawName.trim();
      const existing = directory.people.find((p) => p.name.toLowerCase() === clean.toLowerCase());
      if (existing) return existing;
      const created: Person = {
        id: `person-${slugify(clean)}-${Date.now().toString(36).slice(-3)}`,
        name: clean,
        email,
        clientId,
        isInternal: !clientId,
      };
      setDirectory((prev) => ({ ...prev, people: [...prev.people, created] }));
      return created;
    },
    [directory.people]
  );

  const handleCreatePerson = useCallback(
    (p: Omit<Person, 'id'>) => {
      pushWorkspaceHistory(`Added person "${p.name}"`);
      setDirectory((prev) => ({
        ...prev,
        people: [
          ...prev.people,
          { ...p, id: `person-${slugify(p.name)}-${Date.now().toString(36).slice(-3)}` },
        ],
      }));
    },
    [pushWorkspaceHistory]
  );

  const handleUpdatePerson = useCallback(
    (updated: Person, previousName?: string) => {
      pushWorkspaceHistory(`Updated person "${updated.name}"`, {
        coalesceKey: `person-edit-${updated.id}`,
      });
      setDirectory((prev) => ({
        ...prev,
        people: prev.people.map((p) => (p.id === updated.id ? updated : p)),
      }));
      if (previousName && previousName !== updated.name && updated.name.trim()) {
        setNotes((prev) =>
          prev.map((n) =>
            n.participants.includes(previousName)
              ? {
                  ...n,
                  participants: n.participants.map((part) =>
                    part === previousName ? updated.name : part
                  ),
                }
              : n
          )
        );
      }
    },
    [pushWorkspaceHistory]
  );

  const handleDeletePerson = useCallback(
    (personId: string) => {
      const target = directory.people.find((p) => p.id === personId);
      if (!target) return;
      pushWorkspaceHistory(`Deleted person "${target.name}"`, { showToast: true });
      recordTombstone('people', target.name.trim().toLowerCase());
      setDirectory((prev) => ({
        ...prev,
        people: prev.people.filter((p) => p.id !== personId),
      }));
      setNotes((prev) =>
        prev.map((n) =>
          n.participants.some((part) => part.toLowerCase() === target.name.toLowerCase())
            ? {
                ...n,
                participants: n.participants.filter(
                  (part) => part.toLowerCase() !== target.name.toLowerCase()
                ),
                updatedAt: new Date().toISOString(),
              }
            : n
        )
      );
      if (
        noteFilter.kind === 'person' &&
        noteFilter.personName?.toLowerCase() === target.name.toLowerCase()
      ) {
        setNoteFilter({ kind: 'all' });
      }
    },
    [directory.people, noteFilter, pushWorkspaceHistory, recordTombstone]
  );

  const handleAddClient = useCallback(
    (name: string, domain?: string, options?: { recordHistory?: boolean }): string => {
      const existing = directory.clients.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (existing) return existing.id;
      if (options?.recordHistory !== false) {
        pushWorkspaceHistory(`Added client "${name}"`);
      }
      const id = `client-${slugify(name)}`;
      const created: Client = {
        id,
        name,
        domain,
        color: CLIENT_PALETTE[directory.clients.length % CLIENT_PALETTE.length],
      };
      setDirectory((prev) => ({ ...prev, clients: [...prev.clients, created] }));
      return id;
    },
    [directory.clients, pushWorkspaceHistory]
  );

  const handleUpdateClient = useCallback(
    (updated: Client) => {
      pushWorkspaceHistory(`Updated client "${updated.name}"`, {
        coalesceKey: `client-edit-${updated.id}`,
      });
      setDirectory((prev) => ({
        ...prev,
        clients: prev.clients.map((c) => (c.id === updated.id ? updated : c)),
      }));
    },
    [pushWorkspaceHistory]
  );

  const handleDeleteClient = useCallback(
    (clientId: string) => {
      const target = directory.clients.find((c) => c.id === clientId);
      if (!target) return;
      pushWorkspaceHistory(`Deleted client "${target.name}"`, { showToast: true });
      recordTombstone('clients', clientId);

      const removedProjectIds = new Set(
        directory.projects.filter((p) => p.clientId === clientId).map((p) => p.id)
      );
      for (const pid of removedProjectIds) {
        recordTombstone('projects', pid);
      }

      const nextDir: WorkspaceDirectory = {
        ...directory,
        clients: directory.clients.filter((c) => c.id !== clientId),
        projects: directory.projects.filter((p) => p.clientId !== clientId),
        people: directory.people.map((p) =>
          p.clientId === clientId ? { ...p, clientId: null, isInternal: true } : p
        ),
      };
      setDirectory(nextDir);

      const nowIso = new Date().toISOString();
      setNotes((prev) =>
        prev.map((n) => {
          if (n.clientId !== clientId) return n;
          const moved: Note = {
            ...n,
            scope: 'inbox',
            clientId: null,
            projectId: null,
            updatedAt: nowIso,
          };
          const nextPath = computeNoteFilePath(moved, nextDir);
          const withPath = { ...moved, filePath: nextPath };
          syncSingleNoteToDisk(withPath, n.filePath, nextDir);
          return withPath;
        })
      );

      if (
        (noteFilter.kind === 'client' && noteFilter.clientId === clientId) ||
        (noteFilter.kind === 'project' &&
          (noteFilter.clientId === clientId ||
            (noteFilter.projectId && removedProjectIds.has(noteFilter.projectId))))
      ) {
        setNoteFilter({ kind: 'all' });
      }
    },
    [directory, noteFilter, pushWorkspaceHistory, recordTombstone, syncSingleNoteToDisk]
  );

  const handleAddProject = useCallback(
    (
      name: string,
      scope: 'client' | 'internal',
      clientId: string | null,
      options?: { recordHistory?: boolean }
    ): string => {
      const existing = directory.projects.find(
        (p) => p.name.toLowerCase() === name.toLowerCase() && p.clientId === clientId
      );
      if (existing) return existing.id;
      if (options?.recordHistory !== false) {
        pushWorkspaceHistory(`Added project "${name}"`);
      }
      const clientObj = clientId ? directory.clients.find((c) => c.id === clientId) : null;
      const id = `proj-${clientObj ? `${slugify(clientObj.name)}-` : ''}${slugify(name)}`;
      const created: Project = {
        id,
        name,
        scope,
        clientId,
        status: 'active',
      };
      setDirectory((prev) => ({ ...prev, projects: [...prev.projects, created] }));
      return id;
    },
    [directory.clients, directory.projects, pushWorkspaceHistory]
  );

  const handleUpdateProject = useCallback(
    (updated: Project) => {
      pushWorkspaceHistory(`Updated project "${updated.name}"`, {
        coalesceKey: `project-edit-${updated.id}`,
      });
      setDirectory((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => (p.id === updated.id ? updated : p)),
      }));
    },
    [pushWorkspaceHistory]
  );

  const handleDeleteProject = useCallback(
    (projectId: string) => {
      const target = directory.projects.find((p) => p.id === projectId);
      if (!target) return;
      pushWorkspaceHistory(`Deleted project "${target.name}"`, { showToast: true });
      recordTombstone('projects', projectId);

      const nextDir: WorkspaceDirectory = {
        ...directory,
        projects: directory.projects.filter((p) => p.id !== projectId),
      };
      setDirectory(nextDir);

      const nowIso = new Date().toISOString();
      setNotes((prev) =>
        prev.map((n) => {
          if (n.projectId !== projectId) return n;
          const unassigned: Note = {
            ...n,
            projectId: null,
            updatedAt: nowIso,
          };
          const nextPath = computeNoteFilePath(unassigned, nextDir);
          const withPath = { ...unassigned, filePath: nextPath };
          syncSingleNoteToDisk(withPath, n.filePath, nextDir);
          return withPath;
        })
      );

      if (noteFilter.kind === 'project' && noteFilter.projectId === projectId) {
        setNoteFilter(
          target.clientId ? { kind: 'client', clientId: target.clientId } : { kind: 'internal' }
        );
      }
    },
    [directory, noteFilter, pushWorkspaceHistory, recordTombstone, syncSingleNoteToDisk]
  );

  const handleAddLabel = useCallback(
    (rawLabel: string) => {
      const norm = normalizeLabel(rawLabel);
      if (!norm || directory.customLabels.includes(norm)) return;
      pushWorkspaceHistory(`Added #${norm} label`);
      setDirectory((prev) =>
        prev.customLabels.includes(norm)
          ? prev
          : { ...prev, customLabels: [...prev.customLabels, norm] }
      );
    },
    [directory.customLabels, pushWorkspaceHistory]
  );

  const handleDeleteLabel = useCallback(
    (rawLabel: string) => {
      const norm = normalizeLabel(rawLabel);
      if (!norm) return;
      pushWorkspaceHistory(`Deleted #${norm} label`, { showToast: true });

      setDirectory((prev) => ({
        ...prev,
        customLabels: prev.customLabels.filter((l) => normalizeLabel(l) !== norm),
      }));

      setNotes((prev) =>
        prev.map((n) => {
          const cleaned = removeLabelFromNote(n, norm);
          if (cleaned !== n) {
            syncSingleNoteToDisk(cleaned, n.filePath);
          }
          return cleaned;
        })
      );

      if (noteFilter.kind === 'label' && noteFilter.label === norm) {
        setNoteFilter({ kind: 'all' });
      }
    },
    [noteFilter, pushWorkspaceHistory, syncSingleNoteToDisk]
  );

  const handleUpdateRemoteTaskStatus = useCallback(
    (task: ParsedTask, nextStatus: TaskStatus) => {
      const target = notes.find((n) => n.id === task.noteId);
      if (!target) return;
      pushWorkspaceHistory(`Task status → ${nextStatus}`);
      const nextBody = updateTaskInBody(target.body, task.lineIndex, { status: nextStatus });
      commitNoteToStateAndDisk({ ...target, body: nextBody, updatedAt: new Date().toISOString() });
    },
    [notes, commitNoteToStateAndDisk, pushWorkspaceHistory]
  );

  const handleDeleteRemoteTask = useCallback(
    (task: ParsedTask) => {
      const target = notes.find((n) => n.id === task.noteId);
      if (!target) return;
      pushWorkspaceHistory(`Deleted task "${task.text.slice(0, 34)}"`, { showToast: true });
      const nextBody = deleteTaskFromBody(target.body, task.lineIndex);
      commitNoteToStateAndDisk({ ...target, body: nextBody, updatedAt: new Date().toISOString() });
    },
    [notes, commitNoteToStateAndDisk, pushWorkspaceHistory]
  );

  const handleUpdateRemoteDecisionStatus = useCallback(
    (decision: ParsedDecision, nextStatus: DecisionStatus) => {
      const target = notes.find((n) => n.id === decision.noteId);
      if (!target) return;
      pushWorkspaceHistory(`Decision status → ${nextStatus}`);
      const nextBody = updateDecisionInBody(target.body, decision.lineIndex, { status: nextStatus });
      commitNoteToStateAndDisk({ ...target, body: nextBody, updatedAt: new Date().toISOString() });
    },
    [notes, commitNoteToStateAndDisk, pushWorkspaceHistory]
  );

  const handleDeleteRemoteDecision = useCallback(
    (decision: ParsedDecision) => {
      const target = notes.find((n) => n.id === decision.noteId);
      if (!target) return;
      pushWorkspaceHistory(`Deleted decision "${decision.text.slice(0, 34)}"`, { showToast: true });
      const nextBody = deleteDecisionFromBody(target.body, decision.lineIndex);
      commitNoteToStateAndDisk({ ...target, body: nextBody, updatedAt: new Date().toISOString() });
    },
    [notes, commitNoteToStateAndDisk, pushWorkspaceHistory]
  );

  const runFullWorkspaceSync = useCallback(
    async (targetHandle?: FsDirectoryHandle, options?: { silent?: boolean }) => {
      const handle = targetHandle || dirHandleRef.current;
      if (!handle) return;

      await flushPendingNoteWrites();
      const isGdrive = handle.providerKind === 'gdrive';

      try {
        setIsSyncing(true);
        if (!options?.silent) {
          setSyncStatus(
            isGdrive ? `Syncing Google Drive (${handle.name})…` : `Syncing ${handle.name}…`
          );
        }
        const synced = await syncWorkspaceWithFolder(
          handle,
          notesRef.current,
          directoryRef.current,
          tombstonesRef.current
        );
        if (!isGdrive && synced.effectiveRoot !== handle) {
          setDirHandle(synced.effectiveRoot);
          dirHandleRef.current = synced.effectiveRoot;
        }
        setNotes(synced.notes);
        setDirectory(synced.directory);
        setTombstones(synced.tombstones);
        tombstonesRef.current = synced.tombstones;
        setLastSyncedAt(new Date().toISOString());
        lastSyncTimestampMsRef.current = Date.now();

        const isEditingDraft = draftBaselineRef.current?.id === activeNoteId;
        if (
          !isEditingDraft &&
          synced.notes.length > 0 &&
          !synced.notes.some((n) => n.id === activeNoteId)
        ) {
          setActiveNoteId(synced.notes[0].id);
        }

        setSyncStatus(
          isGdrive ? `Google Drive: ${handle.name}` : `Synced: ${synced.effectiveRoot.name}`
        );
      } catch {
        setSyncStatus(
          isGdrive ? `Reconnect Drive: ${handle.name}` : 'Sync warning — check folder access'
        );
      } finally {
        setIsSyncing(false);
      }
    },
    [activeNoteId, flushPendingNoteWrites]
  );

  // Auto-sync when returning to the browser tab / unlocking phone or periodically while open
  useEffect(() => {
    const checkAutoSync = () => {
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      const handle = dirHandleRef.current;
      if (!handle || dirPermissionRef.current !== 'granted') return;
      if (handle.providerKind === 'gdrive' && !isGoogleDriveTokenValid(gdriveConfigRef.current)) {
        return;
      }
      if (Date.now() - lastSyncTimestampMsRef.current < 8000) return;
      void runFullWorkspaceSync(handle, { silent: true });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void flushPendingNoteWrites();
      } else if (document.visibilityState === 'visible') {
        checkAutoSync();
      }
    };

    window.addEventListener('focus', checkAutoSync);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const interval = window.setInterval(checkAutoSync, 45_000);

    return () => {
      window.removeEventListener('focus', checkAutoSync);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [flushPendingNoteWrites, runFullWorkspaceSync]);

  const handleTriggerSyncNow = useCallback(async () => {
    if (dirHandleRef.current && dirPermissionRef.current === 'prompt') {
      const granted = await requestHandlePermission(dirHandleRef.current);
      if (granted) {
        setDirPermission('granted');
        dirPermissionRef.current = 'granted';
        await runFullWorkspaceSync(dirHandleRef.current);
        return;
      }
    }
    if (dirHandleRef.current && dirPermissionRef.current === 'granted') {
      await runFullWorkspaceSync(dirHandleRef.current);
      return;
    }
    setShowSyncModal(true);
  }, [runFullWorkspaceSync]);

  const handlePickLocalFolder = useCallback(async () => {
    try {
      const picked = await pickSyncDirectory();
      if (!picked) return;
      // Disable Google Drive mode if switching to a local folder
      if (gdriveConfigRef.current.enabled) {
        const disabledGdrive = { ...gdriveConfigRef.current, enabled: false };
        saveGoogleDriveConfig(disabledGdrive);
        setGdriveConfig(disabledGdrive);
        gdriveConfigRef.current = disabledGdrive;
      }
      setDirHandle(picked);
      dirHandleRef.current = picked;
      setDirPermission('granted');
      dirPermissionRef.current = 'granted';
      await runFullWorkspaceSync(picked);
    } catch {
      // User cancelled picker
    }
  }, [runFullWorkspaceSync]);

  const handleDisconnectLocalFolder = useCallback(async () => {
    await idbSet('syncDirHandle', null);
    setDirHandle(null);
    dirHandleRef.current = null;
    setDirPermission('denied');
    dirPermissionRef.current = 'denied';
    setSyncStatus('IndexedDB Local');
  }, []);

  const handleConnectGoogleDrive = useCallback(
    async (nextConfig: GoogleDriveConfig, duplicateFolderIds?: string[]) => {
      setGdriveConfig(nextConfig);
      gdriveConfigRef.current = nextConfig;
      const gdriveHandle = new GoogleDriveDirectoryHandle({
        name: nextConfig.folderName || 'Strata',
        primaryFolderId: nextConfig.folderId,
        duplicateFolderIds,
        accessTokenGetter: () => gdriveConfigRef.current.accessToken,
      });
      setDirHandle(gdriveHandle);
      dirHandleRef.current = gdriveHandle;
      setDirPermission('granted');
      dirPermissionRef.current = 'granted';
      await runFullWorkspaceSync(gdriveHandle);
    },
    [runFullWorkspaceSync]
  );

  const handleDisconnectGoogleDrive = useCallback(() => {
    const nextConfig: GoogleDriveConfig = {
      ...gdriveConfigRef.current,
      enabled: false,
      accessToken: '',
      tokenExpiresAt: 0,
    };
    saveGoogleDriveConfig(nextConfig);
    setGdriveConfig(nextConfig);
    gdriveConfigRef.current = nextConfig;
    setDirHandle(null);
    dirHandleRef.current = null;
    setDirPermission('denied');
    dirPermissionRef.current = 'denied';
    setSyncStatus('IndexedDB Local');
  }, []);

  const handleConnectOrSyncFolder = async () => {
    if (dirHandle && dirPermission === 'prompt') {
      await handleTriggerSyncNow();
      return;
    }
    setShowSyncModal(true);
  };

  const handleResetCleanWorkspace = () => {
    if (!window.confirm('Delete all notes, clients, projects, and people in this browser workspace?')) {
      return;
    }
    pushWorkspaceHistory('Cleared entire workspace', { showToast: true });
    const oldNotes = notes;
    const fresh = makeFreshNote();
    const emptyDir: WorkspaceDirectory = {
      clients: [],
      projects: [],
      people: [],
      customLabels: [],
      sensitiveTerms: [],
    };
    draftBaselineRef.current = fresh;
    setDraftNote(fresh);
    setOverlayStack([]);
    setNotes([]);
    setDirectory(emptyDir);
    setActiveNoteId(fresh.id);
    setNoteFilter({ kind: 'all' });
    setMainView('notes');
    if (dirHandle && dirPermission === 'granted') {
      void syncWorkspaceDiffToDisk(oldNotes, [], emptyDir);
    }
  };

  const shellClass = [
    'app-shell',
    !sidebarOpen ? 'sidebar-collapsed' : '',
    mainView !== 'notes' || !radarOpen ? 'radar-collapsed' : '',
    isFocusMode ? 'focus-mode' : '',
    mainView === 'notes' && overlayStack.length > 0 ? 'has-workspace-overlay' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const activeBreadcrumbLabel = useMemo(() => {
    if (mainView === 'reports') {
      return reportInitialFilter.mode === 'explorer' ? 'Reports Hub' : 'Daily Briefing';
    }
    if (mainView === 'tasks') return 'Tasks Rollup';
    if (mainView === 'decisions') return 'Decision Register';
    if (mainView === 'people') return 'Workspace Directory';
    if (noteFilter.kind === 'inbox') return 'Inbox';
    if (noteFilter.kind === 'internal') return 'Internal Workspace';
    if (noteFilter.kind === 'client') {
      return directory.clients.find((c) => c.id === noteFilter.clientId)?.name || 'Client';
    }
    if (noteFilter.kind === 'project') {
      return directory.projects.find((p) => p.id === noteFilter.projectId)?.name || 'Project';
    }
    if (noteFilter.kind === 'label') return `#${noteFilter.label}`;
    if (noteFilter.kind === 'person') return `@${noteFilter.personName}`;
    return 'All Notes';
  }, [mainView, reportInitialFilter.mode, noteFilter, directory.clients, directory.projects]);

  const internalProjects = useMemo(
    () => directory.projects.filter((p) => p.scope === 'internal'),
    [directory.projects]
  );

  return (
    <div className={shellClass}>
      {aiActivity.isBusy && (
        <div
          className="ai-global-progress no-print"
          role="progressbar"
          aria-label={aiActivity.label || 'AI request in progress'}
        />
      )}
      {/* Mobile Slide-Over Drawer Backdrop */}
      {isMobile && (sidebarOpen || (mainView === 'notes' && radarOpen)) && (
        <div
          className="mobile-drawer-backdrop no-print"
          onClick={() => {
            setSidebarOpen(false);
            setRadarOpen(false);
          }}
        />
      )}

      {/* Left Navigation Sidebar */}
      {sidebarOpen && (
        <nav className="sidebar" aria-label="Workspace Navigation">
          <div className="sidebar-header">
            <div className="brand-mark">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 64 64"
                fill="none"
                className="brand-logo"
                aria-hidden="true"
              >
                <rect width="64" height="64" rx="14" fill="#0F172A" />
                <path d="M16 21L32 14L48 21L32 28L16 21Z" fill="#38BDF8" />
                <path
                  d="M16 32L32 39L48 32"
                  stroke="#94A3B8"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M16 42L32 49L48 42"
                  stroke="#E2E8F0"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>Strata</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                className="btn btn-icon btn-ghost"
                title="Command Palette (Ctrl+K)"
                onClick={() => {
                  if (isMobile) setSidebarOpen(false);
                  setShowCommandPalette(true);
                }}
              >
                <Search size={15} />
              </button>
              <button
                type="button"
                className="btn btn-icon btn-ghost mobile-only"
                title="Close Sidebar"
                aria-label="Close Sidebar"
                onClick={() => setSidebarOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="sidebar-actions">
            <button
              id="btn-new-note"
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={handleSpinUpNote}
              title="Spin up a fresh note immediately (Alt+N)"
            >
              <FilePlus2 size={14} />
              New Note
              <span
                className="kbd desktop-only"
                style={{ background: 'rgba(255,255,255,0.2)', color: '#fff', borderColor: 'transparent' }}
              >
                Alt+N
              </span>
            </button>
          </div>

          <div className="sidebar-scroll">
            {/* Primary Workspace Views */}
            <div className="nav-section">
              <button
                type="button"
                className={`nav-item ${mainView === 'notes' && noteFilter.kind === 'all' ? 'active' : ''}`}
                onClick={() => applyNotesFilter({ kind: 'all' })}
              >
                <span className="nav-item-left">
                  <Layers size={14} /> All Notes
                </span>
                <span className="nav-item-count">{notes.length}</span>
              </button>

              <button
                type="button"
                className={`nav-item ${mainView === 'notes' && noteFilter.kind === 'inbox' ? 'active' : ''}`}
                onClick={() => applyNotesFilter({ kind: 'inbox' })}
              >
                <span className="nav-item-left">
                  <Inbox size={14} /> Inbox
                </span>
                {globalCounts.inboxCount > 0 && (
                  <span className="nav-item-count">{globalCounts.inboxCount}</span>
                )}
              </button>

              <button
                id="nav-daily-briefing"
                type="button"
                className={`nav-item ${mainView === 'reports' && reportInitialFilter.mode !== 'explorer' ? 'active' : ''}`}
                onClick={() => {
                  setReportInitialFilter({ mode: 'daily' });
                  switchPrimaryView('reports');
                }}
              >
                <span className="nav-item-left">
                  <Sun size={14} /> Daily Briefing
                </span>
                {globalCounts.dailyUrgentCount > 0 && (
                  <span className="nav-item-count" title="Tasks due today or overdue">
                    {globalCounts.dailyUrgentCount}
                  </span>
                )}
              </button>

              <button
                type="button"
                className={`nav-item ${mainView === 'tasks' ? 'active' : ''}`}
                onClick={() => switchPrimaryView('tasks')}
              >
                <span className="nav-item-left">
                  <CheckSquare size={14} /> Tasks
                </span>
                <span className="nav-item-count">{globalCounts.openTasks}</span>
              </button>

              <button
                type="button"
                className={`nav-item ${mainView === 'decisions' ? 'active' : ''}`}
                onClick={() => switchPrimaryView('decisions')}
              >
                <span className="nav-item-left">
                  <Gavel size={14} /> Decisions
                </span>
                <span className="nav-item-count">{globalCounts.totalDecisions}</span>
              </button>

              <button
                id="nav-reports"
                type="button"
                className={`nav-item ${mainView === 'reports' && reportInitialFilter.mode === 'explorer' ? 'active' : ''}`}
                onClick={() => {
                  setReportInitialFilter({ mode: 'explorer' });
                  switchPrimaryView('reports');
                }}
              >
                <span className="nav-item-left">
                  <BarChart3 size={14} /> Reports Hub
                </span>
              </button>

              <button
                type="button"
                className={`nav-item ${mainView === 'people' ? 'active' : ''}`}
                onClick={() => switchPrimaryView('people')}
              >
                <span className="nav-item-left">
                  <Users size={14} /> Directory
                </span>
                <span className="nav-item-count">
                  {directory.people.length + directory.clients.length + directory.projects.length}
                </span>
              </button>
            </div>

            {/* Clients & Projects Hierarchy */}
            <div className="nav-section">
              <div className="nav-section-header">
                <span>Clients &amp; Projects</span>
                <button
                  type="button"
                  className="mini-icon-btn"
                  title="Add Client"
                  onClick={() => {
                    setSidebarAddingClient((v) => !v);
                    setSidebarClientInput('');
                  }}
                >
                  <Plus size={13} />
                </button>
              </div>

              {sidebarAddingClient && (
                <form
                  className="sidebar-inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!sidebarClientInput.trim()) return;
                    const cId = handleAddClient(sidebarClientInput.trim());
                    setSidebarClientInput('');
                    setSidebarAddingClient(false);
                    applyNotesFilter({ kind: 'client', clientId: cId });
                  }}
                >
                  <input
                    type="text"
                    className="sidebar-inline-input"
                    placeholder="New client name…"
                    autoFocus
                    value={sidebarClientInput}
                    onChange={(e) => setSidebarClientInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setSidebarAddingClient(false);
                    }}
                  />
                  <button
                    type="button"
                    className="mini-icon-btn"
                    onClick={() => setSidebarAddingClient(false)}
                  >
                    <X size={12} />
                  </button>
                </form>
              )}

              {directory.clients.map((client) => {
                const clientProjects = directory.projects.filter((p) => p.clientId === client.id);
                const clientNoteCount = notes.filter((n) => n.clientId === client.id).length;
                return (
                  <div key={client.id}>
                    <div className="nav-row-wrap">
                      <button
                        type="button"
                        className={`nav-item ${
                          mainView === 'notes' &&
                          noteFilter.kind === 'client' &&
                          noteFilter.clientId === client.id
                            ? 'active'
                            : ''
                        }`}
                        onClick={() => applyNotesFilter({ kind: 'client', clientId: client.id })}
                      >
                        <span className="nav-item-left">
                          <span className="client-dot" style={{ background: client.color }} />
                          {client.name}
                        </span>
                        <span className="nav-item-count">{clientNoteCount}</span>
                      </button>
                      <div className="nav-row-actions">
                        <button
                          type="button"
                          className="mini-icon-btn"
                          title={`Add project under ${client.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSidebarAddingProjectFor((curr) =>
                              curr === client.id ? null : client.id
                            );
                            setSidebarProjectInput('');
                          }}
                        >
                          <Plus size={12} />
                        </button>
                        <button
                          type="button"
                          className="mini-icon-btn danger"
                          title={`Delete client ${client.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteClient(client.id);
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>

                    {sidebarAddingProjectFor === client.id && (
                      <form
                        className="sidebar-inline-form"
                        style={{ paddingLeft: 18 }}
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!sidebarProjectInput.trim()) return;
                          const pId = handleAddProject(
                            sidebarProjectInput.trim(),
                            'client',
                            client.id
                          );
                          setSidebarProjectInput('');
                          setSidebarAddingProjectFor(null);
                          applyNotesFilter({ kind: 'project', clientId: client.id, projectId: pId });
                        }}
                      >
                        <input
                          type="text"
                          className="sidebar-inline-input"
                          placeholder={`Project for ${client.name}…`}
                          autoFocus
                          value={sidebarProjectInput}
                          onChange={(e) => setSidebarProjectInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setSidebarAddingProjectFor(null);
                          }}
                        />
                        <button
                          type="button"
                          className="mini-icon-btn"
                          onClick={() => setSidebarAddingProjectFor(null)}
                        >
                          <X size={12} />
                        </button>
                      </form>
                    )}

                    {clientProjects.map((proj) => (
                      <div key={proj.id} className="nav-row-wrap">
                        <button
                          type="button"
                          className={`nav-item tree-indent ${
                            mainView === 'notes' &&
                            noteFilter.kind === 'project' &&
                            noteFilter.projectId === proj.id
                              ? 'active'
                              : ''
                          }`}
                          onClick={() =>
                            applyNotesFilter({
                              kind: 'project',
                              clientId: client.id,
                              projectId: proj.id,
                            })
                          }
                        >
                          <span className="nav-item-left">
                            <ChevronRight size={12} />
                            {proj.name}
                          </span>
                        </button>
                        <div className="nav-row-actions">
                          <button
                            type="button"
                            className="mini-icon-btn danger"
                            title={`Delete project ${proj.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteProject(proj.id);
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}

              {/* Internal Workspace & Internal Projects */}
              <div className="nav-row-wrap">
                <button
                  type="button"
                  className={`nav-item ${
                    mainView === 'notes' && noteFilter.kind === 'internal' ? 'active' : ''
                  }`}
                  onClick={() => applyNotesFilter({ kind: 'internal' })}
                >
                  <span className="nav-item-left">
                    <span className="client-dot" style={{ background: 'var(--text-muted)' }} />
                    Internal Workspace
                  </span>
                </button>
                <div className="nav-row-actions">
                  <button
                    type="button"
                    className="mini-icon-btn"
                    title="Add internal project"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSidebarAddingProjectFor((curr) =>
                        curr === 'internal' ? null : 'internal'
                      );
                      setSidebarProjectInput('');
                    }}
                  >
                    <Plus size={12} />
                  </button>
                </div>
              </div>

              {sidebarAddingProjectFor === 'internal' && (
                <form
                  className="sidebar-inline-form"
                  style={{ paddingLeft: 18 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!sidebarProjectInput.trim()) return;
                    const pId = handleAddProject(sidebarProjectInput.trim(), 'internal', null);
                    setSidebarProjectInput('');
                    setSidebarAddingProjectFor(null);
                    applyNotesFilter({ kind: 'project', projectId: pId });
                  }}
                >
                  <input
                    type="text"
                    className="sidebar-inline-input"
                    placeholder="Internal project name…"
                    autoFocus
                    value={sidebarProjectInput}
                    onChange={(e) => setSidebarProjectInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setSidebarAddingProjectFor(null);
                    }}
                  />
                  <button
                    type="button"
                    className="mini-icon-btn"
                    onClick={() => setSidebarAddingProjectFor(null)}
                  >
                    <X size={12} />
                  </button>
                </form>
              )}

              {internalProjects.map((proj) => (
                <div key={proj.id} className="nav-row-wrap">
                  <button
                    type="button"
                    className={`nav-item tree-indent ${
                      mainView === 'notes' &&
                      noteFilter.kind === 'project' &&
                      noteFilter.projectId === proj.id
                        ? 'active'
                        : ''
                    }`}
                    onClick={() =>
                      applyNotesFilter({
                        kind: 'project',
                        projectId: proj.id,
                      })
                    }
                  >
                    <span className="nav-item-left">
                      <ChevronRight size={12} />
                      {proj.name}
                    </span>
                  </button>
                  <div className="nav-row-actions">
                    <button
                      type="button"
                      className="mini-icon-btn danger"
                      title={`Delete project ${proj.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteProject(proj.id);
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Unified #Labels / Topics */}
            <div className="nav-section">
              <div className="nav-section-header">
                <span>Topics &amp; #Labels</span>
                <button
                  type="button"
                  className="mini-icon-btn"
                  title="Add #label"
                  onClick={() => {
                    setSidebarAddingLabel((v) => !v);
                    setSidebarLabelInput('');
                  }}
                >
                  <Plus size={13} />
                </button>
              </div>

              {sidebarAddingLabel && (
                <form
                  className="sidebar-inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const norm = normalizeLabel(sidebarLabelInput);
                    if (!norm) return;
                    handleAddLabel(norm);
                    setSidebarLabelInput('');
                    setSidebarAddingLabel(false);
                  }}
                >
                  <input
                    type="text"
                    className="sidebar-inline-input"
                    placeholder="New #label…"
                    autoFocus
                    value={sidebarLabelInput}
                    onChange={(e) => setSidebarLabelInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setSidebarAddingLabel(false);
                    }}
                  />
                  <button
                    type="button"
                    className="mini-icon-btn"
                    onClick={() => setSidebarAddingLabel(false)}
                  >
                    <X size={12} />
                  </button>
                </form>
              )}

              {allWorkspaceLabels.length === 0 ? (
                <div style={{ padding: '4px 8px', fontSize: 11.5, color: 'var(--text-muted)' }}>
                  Type <code>#topic</code> in any note
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '4px 6px' }}>
                  {allWorkspaceLabels.map((lbl) => (
                    <span
                      key={lbl}
                      className="pill pill-label"
                      onClick={() => applyNotesFilter({ kind: 'label', label: lbl })}
                      onDoubleClick={() => {
                        if (mainView === 'notes') {
                          openOverlay({ kind: 'report', label: lbl });
                        } else {
                          setReportInitialFilter({ label: lbl });
                          switchPrimaryView('reports');
                        }
                      }}
                      title="Click to filter notes · Double-click to open Topic Report"
                    >
                      #{lbl}
                      <button
                        type="button"
                        className="pill-remove"
                        title={`Delete #${lbl}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteLabel(lbl);
                        }}
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Storage, Google Drive & Folder Sync Footer */}
          <div className="sidebar-footer">
            <div className="sync-banner">
              <button
                type="button"
                onClick={() => setShowSyncModal(true)}
                title="Open Multi-Device & Google Drive Sync settings"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  minWidth: 0,
                  flex: 1,
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  cursor: 'pointer',
                  textAlign: 'left',
                  color: 'inherit',
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background:
                      dirHandle && dirPermission === 'granted'
                        ? 'hsl(154, 72%, 40%)'
                        : 'var(--text-muted)',
                  }}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {syncStatus}
                </span>
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                {dirHandle && (
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    disabled={isSyncing}
                    onClick={() => void handleTriggerSyncNow()}
                    title="Sync Now with connected folder / Google Drive"
                    aria-label="Sync Now"
                  >
                    <RefreshCw size={12} className={isSyncing ? 'ai-spin' : ''} />
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-xs btn-soft"
                  onClick={() => {
                    if (isMobile) setSidebarOpen(false);
                    setShowSyncModal(true);
                  }}
                  title="Configure Multi-Device & Google Drive Sync"
                >
                  {dirHandle?.providerKind === 'gdrive' ? (
                    <Cloud size={12} />
                  ) : (
                    <FolderSync size={12} />
                  )}
                  {dirHandle && dirPermission === 'granted' ? 'Sync' : 'Connect'}
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={() => exportWorkspaceZip(notes, directory)}
                title="Export all notes as clean .md files inside a .zip archive"
              >
                <Download size={12} /> Export .zip
              </button>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={() => fileImportRef.current?.click()}
                title="Import .md files or a Strata .zip archive"
              >
                <Upload size={12} /> Import
              </button>
              <button
                type="button"
                className="btn btn-xs btn-danger-ghost"
                onClick={handleResetCleanWorkspace}
                title="Wipe all local workspace data"
              >
                <RotateCcw size={12} />
              </button>
              <input
                ref={fileImportRef}
                type="file"
                accept=".md,.zip"
                multiple
                style={{ display: 'none' }}
                onChange={async (e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    const res = await importFilesIntoWorkspace(e.target.files, notes, directory);
                    pushWorkspaceHistory('Imported Markdown files', { showToast: true });
                    setNotes(res.notes);
                    setDirectory(res.directory);
                    if (dirHandle && dirPermission === 'granted') {
                      void syncWorkspaceDiffToDisk(notes, res.notes, res.directory);
                    }
                    if (res.notes[0]) openNoteEditor(res.notes[0].id);
                    e.target.value = '';
                  }
                }}
              />
            </div>
          </div>
        </nav>
      )}

      {/* Center Workspace Column */}
      <main className="main-column">
        <header className="topbar">
          {isMobile ? (
            <>
              <div className="topbar-left">
                <button
                  type="button"
                  className="btn btn-icon btn-ghost"
                  onClick={() => {
                    setRadarOpen(false);
                    setSidebarOpen((v) => !v);
                  }}
                  title="Spaces, Clients & Sync"
                  aria-label="Open Workspace Spaces & Sync"
                >
                  <PanelLeft size={17} />
                </button>

                {mainView === 'notes' && mobileNotesPane === 'editor' ? (
                  <button
                    type="button"
                    className="mobile-back-btn"
                    onClick={() => setMobileNotesPane('list')}
                  >
                    <ChevronLeft size={15} />
                    {noteFilter.kind === 'all' ? `Notes (${notes.length})` : activeBreadcrumbLabel}
                  </button>
                ) : (
                  <span className="mobile-topbar-title">{activeBreadcrumbLabel}</span>
                )}
              </div>

              <div className="topbar-right">
                {!(mainView === 'notes' && mobileNotesPane === 'list') && (
                  <button
                    type="button"
                    className="btn btn-icon btn-ghost"
                    onClick={handleSpinUpNote}
                    title="New Note"
                    aria-label="New Note"
                  >
                    <FilePlus2 size={16} />
                  </button>
                )}

                <button
                  type="button"
                  className={`btn btn-icon ${
                    dirHandle && dirPermission === 'granted' ? 'btn-soft' : 'btn-ghost'
                  }`}
                  onClick={() => setShowSyncModal(true)}
                  title={syncStatus}
                  aria-label="Multi-Device & Google Drive Sync"
                >
                  {isSyncing ? (
                    <RefreshCw size={15} className="ai-spin" />
                  ) : dirHandle?.providerKind === 'gdrive' ? (
                    <Cloud size={16} />
                  ) : (
                    <FolderSync size={16} />
                  )}
                </button>

                <button
                  type="button"
                  className="btn btn-icon btn-ghost"
                  onClick={() => setShowCommandPalette(true)}
                  title="Search & Quick Jump"
                  aria-label="Search & Quick Jump"
                >
                  <Search size={16} />
                </button>

                {mainView === 'notes' && mobileNotesPane === 'editor' && (
                  <button
                    type="button"
                    className={`btn btn-icon ${radarOpen ? 'btn-soft' : 'btn-ghost'}`}
                    onClick={() => {
                      setSidebarOpen(false);
                      setRadarOpen((v) => !v);
                    }}
                    title="Timeline"
                    aria-label="Toggle Timeline"
                  >
                    <History size={16} />
                  </button>
                )}

                <button
                  type="button"
                  className={`btn btn-icon ${aiActivity.isBusy ? 'ai-pill-busy' : 'btn-ghost'}`}
                  onClick={() => setShowAiSettings(true)}
                  title={
                    aiActivity.isBusy
                      ? `${aiActivity.label} (${aiActivity.providerLabel})`
                      : 'Workspace & AI Settings'
                  }
                  aria-label={
                    aiActivity.isBusy
                      ? aiActivity.label || 'AI request in progress'
                      : 'Workspace & AI Settings'
                  }
                >
                  {aiActivity.isBusy ? <Loader2 size={15} className="ai-spin" /> : <Settings size={16} />}
                </button>

                <button
                  type="button"
                  className="btn btn-icon btn-ghost"
                  onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
                  title="Toggle Light / Dark Theme"
                  aria-label="Toggle Theme"
                >
                  {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="topbar-left">
                <button
                  type="button"
                  className="btn btn-icon btn-ghost"
                  onClick={() => setSidebarOpen((v) => !v)}
                  title="Toggle Navigation Sidebar"
                >
                  <PanelLeft size={16} />
                </button>

                {mainView === 'notes' && (
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => setNoteListOpen((v) => !v)}
                  >
                    {noteListOpen ? 'Hide List' : 'Show List'}
                  </button>
                )}

                <div className="breadcrumbs">
                  <span>{activeBreadcrumbLabel}</span>
                  {mainView === 'notes' && activeNote && (
                    <>
                      <ChevronRight size={13} />
                      <span className="breadcrumb-active">
                        {activeNote.title ||
                          (draftNote?.id === activeNote.id ? 'New Note' : 'Untitled Note')}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="topbar-right">
                {!sidebarOpen && (
                  <button
                    type="button"
                    className="btn btn-xs btn-primary"
                    onClick={handleSpinUpNote}
                    title="Spin up a fresh note immediately (Alt+N)"
                  >
                    <FilePlus2 size={12} /> New Note <span className="kbd" style={{ background: 'rgba(255,255,255,0.2)', color: '#fff', borderColor: 'transparent' }}>Alt+N</span>
                  </button>
                )}

                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={() => setShowCommandPalette(true)}
                >
                  <Search size={12} /> Quick Jump <span className="kbd">Ctrl+K</span>
                </button>

                <button
                  type="button"
                  className={`btn btn-xs ${aiActivity.isBusy ? 'ai-pill-busy' : 'btn-ghost'}`}
                  onClick={() => setShowAiSettings(true)}
                  title={
                    aiActivity.isBusy
                      ? `${aiActivity.label} (${aiActivity.providerLabel})`
                      : 'Configure AI Provider & Workspace Settings'
                  }
                >
                  {aiActivity.isBusy ? (
                    <>
                      <Loader2 size={13} className="ai-spin" />
                      {aiActivity.label || 'AI working…'}
                    </>
                  ) : (
                    <>
                      <KeyRound size={13} />
                      {aiConfig.provider === 'local' ? 'AI: Local' : `AI: ${aiConfig.provider.toUpperCase()}`}
                    </>
                  )}
                </button>

                <button
                  type="button"
                  className={`btn btn-xs ${
                    dirHandle && dirPermission === 'granted' ? 'btn-soft' : 'btn-ghost'
                  }`}
                  onClick={() => setShowSyncModal(true)}
                  title={`${syncStatus} — Click for Multi-Device & Google Drive Sync`}
                >
                  {isSyncing ? (
                    <RefreshCw size={12} className="ai-spin" />
                  ) : dirHandle?.providerKind === 'gdrive' ? (
                    <Cloud size={13} />
                  ) : (
                    <FolderSync size={13} />
                  )}
                  <span>
                    {dirHandle && dirPermission === 'granted' ? dirHandle.name : 'Sync'}
                  </span>
                </button>

                <button
                  id="btn-workspace-settings"
                  type="button"
                  className="btn btn-icon btn-ghost"
                  onClick={() => setShowAiSettings(true)}
                  title="Workspace & Initial Focus Mode Settings"
                  aria-label="Workspace Settings"
                >
                  <Settings size={15} />
                </button>

                <button
                  type="button"
                  className="btn btn-icon btn-ghost"
                  onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
                  title="Toggle Light / Dark Theme"
                >
                  {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
                </button>

                {mainView === 'notes' && (
                  <>
                    <button
                      id="btn-focus-mode"
                      type="button"
                      className={`btn btn-xs ${isFocusMode ? 'btn-soft' : 'btn-ghost'}`}
                      onClick={handleToggleFocusMode}
                      aria-pressed={isFocusMode}
                      title={
                        isFocusMode
                          ? 'Exit Focus Mode and restore side panels (Alt+Z or Ctrl+\\)'
                          : 'Focus Mode — hide all side panels and center note (Alt+Z or Ctrl+\\)'
                      }
                    >
                      {isFocusMode ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                      {isFocusMode ? 'Exit Focus' : 'Focus'}
                      <span className="kbd">Alt+Z</span>
                    </button>

                    <button
                      type="button"
                      className={`btn btn-xs ${radarOpen ? 'btn-soft' : ''}`}
                      onClick={() => setRadarOpen((v) => !v)}
                      title="Toggle Related Notes Timeline"
                    >
                      <History size={13} /> Timeline
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </header>

        {mainView === 'notes' && (
          <div
            className={[
              'notes-workspace',
              !isMobile && !noteListOpen ? 'list-hidden' : '',
              isMobile ? (mobileNotesPane === 'list' ? 'mobile-pane-list' : 'mobile-pane-editor') : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {(isMobile || noteListOpen) && (
              <section className="note-list-pane" aria-label="Notes List">
                <div className="note-list-header">
                  <div className="search-input-wrap">
                    <Search size={13} />
                    <input
                      type="text"
                      className="search-input"
                      placeholder="Filter notes, @people, #labels…"
                      value={listSearch}
                      onChange={(e) => setListSearch(e.target.value)}
                    />
                  </div>
                  {noteFilter.kind !== 'all' && (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: 11.5,
                      }}
                    >
                      <span style={{ fontWeight: 600, color: 'var(--accent-text)' }}>
                        Filter: {activeBreadcrumbLabel}
                      </span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {noteFilter.kind === 'label' && noteFilter.label && (
                          <button
                            type="button"
                            className="btn btn-xs btn-soft"
                            onClick={() =>
                              openOverlay({ kind: 'report', label: noteFilter.label })
                            }
                          >
                            Topic Report
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          onClick={() => setNoteFilter({ kind: 'all' })}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="note-list-items">
                  {filteredNotesList.length === 0 ? (
                    <div
                      style={{
                        padding: 16,
                        textAlign: 'center',
                        color: 'var(--text-muted)',
                        fontSize: 12.5,
                      }}
                    >
                      No notes in this view yet.
                      <div style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          className="btn btn-xs btn-primary"
                          onClick={handleSpinUpNote}
                        >
                          + Spin Up Note
                        </button>
                      </div>
                    </div>
                  ) : (
                    filteredNotesList.map((n) => {
                      const client = n.clientId
                        ? directory.clients.find((c) => c.id === n.clientId)
                        : null;
                      const preview = stripMarkdownFormatting(n.body);
                      return (
                        <div key={n.id} className="note-card-wrap">
                          <button
                            type="button"
                            className={`note-card-item ${n.id === activeNote.id ? 'active' : ''}`}
                            onClick={() => openNoteEditor(n.id)}
                          >
                            <div className="note-card-title">{n.title || 'Untitled Note'}</div>
                            <div className="note-card-meta">
                              <span>{n.date}</span>
                              {isDailyBriefingNote(n) && (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 3,
                                    color: 'var(--accent-text)',
                                    fontWeight: 600,
                                  }}
                                >
                                  <Sun size={10} /> Daily Report
                                </span>
                              )}
                              {client && (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <span className="client-dot" style={{ background: client.color }} />
                                  {client.name}
                                </span>
                              )}
                              {n.scope === 'inbox' && <span>Inbox</span>}
                            </div>
                            {preview && <div className="note-card-snippet">{preview}</div>}
                          </button>
                          <button
                            type="button"
                            className="card-delete-btn"
                            title="Delete note"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteNote(n.id);
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            )}

            <HybridEditor
              key={activeNote.id}
              note={activeNote}
              allNotes={notes}
              directory={directory}
              allWorkspaceLabels={allWorkspaceLabels}
              onUpdateNote={handleUpdateNote}
              onDeleteNote={handleDeleteNote}
              onAddClient={handleAddClient}
              onAddProject={handleAddProject}
              onEnsurePerson={handleEnsurePerson}
              onNavigateLabel={(lbl) => openOverlay({ kind: 'report', label: lbl })}
              onNavigatePerson={(pName) => openOverlay({ kind: 'report', person: pName })}
              onNavigateOrCreateNoteByTitle={handlePeekOrCreateNoteByTitle}
              onOpenAiStructure={() => setShowAiStructure(true)}
              onOpenQuickAsk={() => {
                setSidebarOpen(false);
                setRadarOpen(true);
                setRadarRequestedTab('ask');
                setTimeout(() => {
                  document.getElementById('radar-ask-input')?.focus();
                }, 40);
              }}
              onNotify={(msg) => showToastMessage(msg, null)}
              canUndo={historyUi.canUndoNote}
              canRedo={historyUi.canRedoNote}
              undoLabel={historyUi.noteUndoLabel}
              redoLabel={historyUi.noteRedoLabel}
              onUndo={handleUndoNote}
              onRedo={handleRedoNote}
              pendingSelectionRestore={pendingSelectionRestore}
              onSyncSelection={handleSyncNoteSelection}
            />
          </div>
        )}

        {mainView === 'reports' && (
          <ReportsView
            key={`${reportInitialFilter.mode || 'daily'}-${reportInitialFilter.label || ''}-${reportInitialFilter.clientId || ''}-${reportInitialFilter.person || ''}`}
            notes={notes}
            directory={directory}
            allLabels={allWorkspaceLabels}
            aiConfig={aiConfig}
            initialMode={reportInitialFilter.mode}
            initialLabelFilter={reportInitialFilter.label}
            initialClientFilter={reportInitialFilter.clientId}
            initialPersonFilter={reportInitialFilter.person}
            dailyBriefingState={dailyBriefingState}
            isRefreshingDailyBriefing={isRefreshingDailyBriefing}
            onRefreshDailyBriefing={handleRefreshDailyBriefing}
            onOpenDailyReportNote={handleOpenDailyReportNote}
            onModeChange={(nextMode) => {
              setReportInitialFilter((prev) => ({ ...prev, mode: nextMode }));
            }}
            onOpenNote={openNoteEditor}
            onOpenNoteByTitle={handleOpenOrCreateNoteByTitle}
            onUpdateTaskStatus={handleUpdateRemoteTaskStatus}
            onDeleteTask={handleDeleteRemoteTask}
            onUpdateDecisionStatus={handleUpdateRemoteDecisionStatus}
            onDeleteDecision={handleDeleteRemoteDecision}
            onSaveBriefAsNote={(title, body, cId, pId) => {
              pushWorkspaceHistory(`Saved report "${title || 'Brief'}"`, { showToast: true });
              const raw = makeFreshNote({
                title,
                body,
                scope: cId ? 'client' : 'internal',
                clientId: cId,
                projectId: pId,
                labels: ['report'],
              });
              const saved = { ...raw, filePath: computeNoteFilePath(raw, directory) };
              draftBaselineRef.current = null;
              setDraftNote(null);
              setNotes((prev) => [saved, ...prev]);
              syncSingleNoteToDisk(saved);
              openNewNoteInEditor(saved.id);
            }}
          />
        )}

        {mainView === 'tasks' && (
          <TasksGlobalView
            notes={notes}
            directory={directory}
            onOpenNote={openNoteEditor}
            onOpenNoteByTitle={handleOpenOrCreateNoteByTitle}
            onSelectLabel={(lbl) => applyNotesFilter({ kind: 'label', label: lbl })}
            onUpdateTaskStatus={handleUpdateRemoteTaskStatus}
            onDeleteTask={handleDeleteRemoteTask}
          />
        )}

        {mainView === 'decisions' && (
          <DecisionsGlobalView
            notes={notes}
            directory={directory}
            onOpenNote={openNoteEditor}
            onOpenNoteByTitle={handleOpenOrCreateNoteByTitle}
            onSelectPerson={(pName) => applyNotesFilter({ kind: 'person', personName: pName })}
            onSelectLabel={(lbl) => applyNotesFilter({ kind: 'label', label: lbl })}
            onUpdateDecisionStatus={handleUpdateRemoteDecisionStatus}
            onDeleteDecision={handleDeleteRemoteDecision}
          />
        )}

        {mainView === 'people' && (
          <PeopleDirectoryView
            notes={notes}
            directory={directory}
            allLabels={allWorkspaceLabels}
            onUpdatePerson={handleUpdatePerson}
            onCreatePerson={handleCreatePerson}
            onDeletePerson={handleDeletePerson}
            onAddClient={handleAddClient}
            onUpdateClient={handleUpdateClient}
            onDeleteClient={handleDeleteClient}
            onAddProject={handleAddProject}
            onUpdateProject={handleUpdateProject}
            onDeleteProject={handleDeleteProject}
            onAddLabel={handleAddLabel}
            onDeleteLabel={handleDeleteLabel}
            onFilterNotesByPerson={(name) => applyNotesFilter({ kind: 'person', personName: name })}
            onFilterNotesByClient={(cId) => applyNotesFilter({ kind: 'client', clientId: cId })}
            onFilterNotesByProject={(proj) =>
              applyNotesFilter({
                kind: 'project',
                clientId: proj.clientId || undefined,
                projectId: proj.id,
              })
            }
            onFilterNotesByLabel={(lbl) => applyNotesFilter({ kind: 'label', label: lbl })}
          />
        )}
      </main>

      {/* Mobile Floating New-Note Action on Notes List */}
      {isMobile && mainView === 'notes' && mobileNotesPane === 'list' && (
        <button
          type="button"
          className="mobile-fab no-print"
          onClick={handleSpinUpNote}
          aria-label="Create new note"
        >
          <Plus size={18} />
          New Note
        </button>
      )}

      {/* Mobile Bottom Navigation Bar */}
      <nav className="mobile-bottom-nav no-print" aria-label="Primary Mobile Navigation">
        <button
          type="button"
          className={`mobile-nav-item ${mainView === 'notes' ? 'active' : ''}`}
          onClick={() => {
            setSidebarOpen(false);
            setRadarOpen(false);
            if (mainView === 'notes') {
              setMobileNotesPane((p) => (p === 'editor' ? 'list' : 'editor'));
            } else {
              setMainView('notes');
            }
          }}
        >
          <span className="mobile-nav-icon-wrap">
            <Layers size={18} />
          </span>
          <span>Notes</span>
        </button>

        <button
          type="button"
          className={`mobile-nav-item ${mainView === 'tasks' ? 'active' : ''}`}
          onClick={() => switchPrimaryView('tasks')}
        >
          <span className="mobile-nav-icon-wrap">
            <CheckSquare size={18} />
            {globalCounts.openTasks > 0 && (
              <span className="mobile-nav-badge">{globalCounts.openTasks}</span>
            )}
          </span>
          <span>Tasks</span>
        </button>

        <button
          type="button"
          className={`mobile-nav-item ${mainView === 'decisions' ? 'active' : ''}`}
          onClick={() => switchPrimaryView('decisions')}
        >
          <span className="mobile-nav-icon-wrap">
            <Gavel size={18} />
            {globalCounts.totalDecisions > 0 && (
              <span className="mobile-nav-badge">{globalCounts.totalDecisions}</span>
            )}
          </span>
          <span>Decisions</span>
        </button>

        <button
          type="button"
          className={`mobile-nav-item ${mainView === 'reports' ? 'active' : ''}`}
          onClick={() => {
            setReportInitialFilter({ mode: 'daily' });
            switchPrimaryView('reports');
          }}
        >
          <span className="mobile-nav-icon-wrap">
            <Sun size={18} />
            {globalCounts.dailyUrgentCount > 0 && (
              <span className="mobile-nav-badge">{globalCounts.dailyUrgentCount}</span>
            )}
          </span>
          <span>Daily</span>
        </button>

        <button
          type="button"
          className={`mobile-nav-item ${mainView === 'people' ? 'active' : ''}`}
          onClick={() => switchPrimaryView('people')}
        >
          <span className="mobile-nav-icon-wrap">
            <Users size={18} />
          </span>
          <span>Directory</span>
        </button>
      </nav>

      {/* Right Sidebar: Live Related Notes Timeline */}
      {mainView === 'notes' && radarOpen && (
        <ContextTimeline
          activeNote={activeNote}
          allNotes={notes}
          directory={directory}
          aiConfig={aiConfig}
          requestedTab={radarRequestedTab}
          onClearRequestedTab={() => setRadarRequestedTab(null)}
          onInsertIntoActiveNote={(snippet) => {
            const base = activeNote.body.trimEnd();
            handleUpdateNote(
              {
                ...activeNote,
                body: base ? `${base}\n\n${snippet}` : snippet,
                updatedAt: new Date().toISOString(),
              },
              { label: 'Insert citation', coalesceKey: null }
            );
            if (isMobile) setRadarOpen(false);
          }}
          onOpenNote={(nId) => {
            if (nId !== activeNote.id) {
              openOverlay({ kind: 'note', noteId: nId });
            }
          }}
          onOpenNoteByTitle={handlePeekOrCreateNoteByTitle}
          onSelectPerson={(pName) => openOverlay({ kind: 'report', person: pName })}
          onSelectLabel={(lbl) => openOverlay({ kind: 'report', label: lbl })}
          onToggleRemoteTaskStatus={handleUpdateRemoteTaskStatus}
          onCollapse={() => setRadarOpen(false)}
        />
      )}

      {/* Dismissible Note Context Overlay (#topic reports, @person dossiers/notes, [[Note]] previews) */}
      {mainView === 'notes' && overlayStack.length > 0 && (
        <WorkspaceOverlay
          stack={overlayStack}
          originNoteId={activeNote.id}
          originNoteTitle={activeNote.title}
          notes={notes}
          directory={directory}
          allLabels={allWorkspaceLabels}
          aiConfig={aiConfig}
          suspendEscape={showCommandPalette || showAiStructure || showAiSettings || showSyncModal}
          onNotify={(msg) => showToastMessage(msg, null)}
          onBack={popOverlay}
          onClose={closeOverlay}
          onPushEntry={pushOverlay}
          onOpenNoteInEditor={openNoteEditor}
          onOpenOrPeekNoteByTitle={handlePeekOrCreateNoteByTitle}
          onOpenFullReportsView={(filter) => {
            setReportInitialFilter({ ...filter, mode: 'explorer' });
            switchPrimaryView('reports');
          }}
          onUpdateTaskStatus={handleUpdateRemoteTaskStatus}
          onDeleteTask={handleDeleteRemoteTask}
          onUpdateDecisionStatus={handleUpdateRemoteDecisionStatus}
          onDeleteDecision={handleDeleteRemoteDecision}
          onSaveBriefAsNote={(title, body, cId, pId) => {
            pushWorkspaceHistory(`Saved report "${title || 'Brief'}"`, { showToast: true });
            const raw = makeFreshNote({
              title,
              body,
              scope: cId ? 'client' : 'internal',
              clientId: cId,
              projectId: pId,
              labels: ['report'],
            });
            const saved = { ...raw, filePath: computeNoteFilePath(raw, directory) };
            setNotes((prev) => [saved, ...prev]);
            syncSingleNoteToDisk(saved);
            pushOverlay({ kind: 'note', noteId: saved.id });
          }}
        />
      )}

      {/* Workspace Undo / Redo Toast */}
      {workspaceToast && (
        <div className="undo-toast no-print" role="status" aria-live="polite">
          <span>{workspaceToast.message}</span>
          {workspaceToast.action === 'undo' && historyUi.canUndoWorkspace && (
            <button
              id="btn-toast-undo"
              type="button"
              className="undo-toast-btn"
              onClick={() => {
                handleUndoWorkspace();
              }}
            >
              Undo
            </button>
          )}
          {workspaceToast.action === 'redo' && historyUi.canRedoWorkspace && (
            <button
              id="btn-toast-redo"
              type="button"
              className="undo-toast-btn"
              onClick={() => {
                handleRedoWorkspace();
              }}
            >
              Redo
            </button>
          )}
          <button
            type="button"
            className="mini-icon-btn"
            style={{ color: 'inherit', opacity: 0.7 }}
            onClick={() => setWorkspaceToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Modals */}
      {showSyncModal && (
        <SyncModal
          dirHandle={dirHandle}
          dirPermission={dirPermission}
          gdriveConfig={gdriveConfig}
          syncStatus={syncStatus}
          isSyncing={isSyncing}
          lastSyncedAt={lastSyncedAt}
          noteCount={notes.length}
          onClose={() => setShowSyncModal(false)}
          onTriggerSyncNow={handleTriggerSyncNow}
          onPickLocalFolder={handlePickLocalFolder}
          onDisconnectLocalFolder={handleDisconnectLocalFolder}
          onConnectGoogleDrive={handleConnectGoogleDrive}
          onDisconnectGoogleDrive={handleDisconnectGoogleDrive}
        />
      )}

      {showAiStructure && (
        <AiStructureModal
          note={activeNote}
          allNotes={notes}
          directory={directory}
          aiConfig={aiConfig}
          onClose={() => setShowAiStructure(false)}
          onApply={(updated, newParticipants) => {
            for (const pName of newParticipants) {
              handleEnsurePerson(pName, updated.clientId);
            }
            handleUpdateNote(updated, { label: 'AI Structure', coalesceKey: null });
            setShowAiStructure(false);
          }}
          onOpenAiSettings={() => {
            setShowAiStructure(false);
            setShowAiSettings(true);
          }}
        />
      )}

      {showAiSettings && (
        <AiSettingsModal
          config={aiConfig}
          preferences={preferences}
          sensitiveTerms={directory.sensitiveTerms || []}
          onSave={setAiConfig}
          onSaveSensitiveTerms={(nextTerms) => {
            setDirectory((prev) => ({
              ...prev,
              sensitiveTerms: nextTerms,
            }));
          }}
          onSavePreferences={(nextPrefs) => {
            const layoutChanged = nextPrefs.startupLayout !== preferences.startupLayout;
            setPreferences(nextPrefs);
            if (layoutChanged) {
              if (nextPrefs.startupLayout === 'focus') {
                if (sidebarOpen || noteListOpen || radarOpen) {
                  prevPanelsRef.current = {
                    sidebar: sidebarOpen,
                    noteList: noteListOpen,
                    radar: radarOpen,
                  };
                }
                setMainView('notes');
                setMobileNotesPane('editor');
                setSidebarOpen(false);
                setNoteListOpen(false);
                setRadarOpen(false);
              } else {
                setSidebarOpen(typeof window !== 'undefined' ? window.innerWidth > 860 : true);
                setNoteListOpen(true);
                setRadarOpen(typeof window !== 'undefined' ? window.innerWidth > 1180 : true);
              }
            }
          }}
          onClose={() => setShowAiSettings(false)}
        />
      )}

      {showCommandPalette && (
        <CommandPalette
          notes={notes}
          directory={directory}
          allLabels={allWorkspaceLabels}
          theme={theme}
          isFocusMode={isFocusMode}
          onClose={() => setShowCommandPalette(false)}
          onNewNote={handleSpinUpNote}
          onToggleFocusMode={handleToggleFocusMode}
          onOpenSettings={() => setShowAiSettings(true)}
          onShareEmail={() => {
            const includeMetadata = loadShareIncludeMetadataPreference();
            void shareNoteViaEmail(activeNote, directory, { includeMetadata }).then((res) => {
              showToastMessage(
                res.truncated && res.copiedBackup
                  ? 'Opened Email — full Markdown also copied to clipboard (Ctrl+V)'
                  : 'Opening Email with Markdown note',
                null
              );
            });
          }}
          onShareWhatsApp={() => {
            const includeMetadata = loadShareIncludeMetadataPreference();
            void shareNoteViaWhatsApp(activeNote, directory, { includeMetadata }).then((res) => {
              showToastMessage(
                res.truncated && res.copiedBackup
                  ? 'Opened WhatsApp — full Markdown also copied to clipboard (Ctrl+V)'
                  : 'Opened WhatsApp with Markdown note',
                null
              );
            });
          }}
          onCopyNoteMarkdown={() => {
            const includeMetadata = loadShareIncludeMetadataPreference();
            const md = serializeNoteForShare(activeNote, directory, { includeMetadata });
            void copyTextToClipboard(md).then((ok) => {
              showToastMessage(
                ok
                  ? 'Copied note Markdown — paste (Ctrl+V) into another client/account'
                  : 'Unable to access clipboard',
                null
              );
            });
          }}
          onDeleteCurrentNote={() => handleDeleteNote(activeNote.id)}
          onSelectNote={openNoteEditor}
          onOpenReportForLabel={(lbl) => {
            if (mainView === 'notes') {
              openOverlay({ kind: 'report', label: lbl });
            } else {
              setReportInitialFilter({ mode: 'explorer', label: lbl });
              switchPrimaryView('reports');
            }
          }}
          onOpenPersonNotes={(name) => {
            if (mainView === 'notes') {
              openOverlay({ kind: 'report', person: name });
            } else {
              applyNotesFilter({ kind: 'person', personName: name });
            }
          }}
          onSwitchMainView={(view) => {
            if (view === 'reports') {
              setReportInitialFilter({ mode: 'explorer' });
            }
            switchPrimaryView(view);
          }}
          onOpenDailyBriefing={() => {
            setReportInitialFilter({ mode: 'daily' });
            switchPrimaryView('reports');
          }}
          onOpenDailyReportNote={handleOpenDailyReportNote}
          onTriggerAiStructure={() => {
            switchPrimaryView('notes');
            setMobileNotesPane('editor');
            setShowAiStructure(true);
          }}
          onToggleTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          onConnectFolder={handleConnectOrSyncFolder}
          canUndoNote={mainView === 'notes' && overlayStack.length === 0 && historyUi.canUndoNote}
          canRedoNote={mainView === 'notes' && overlayStack.length === 0 && historyUi.canRedoNote}
          noteUndoLabel={historyUi.noteUndoLabel}
          noteRedoLabel={historyUi.noteRedoLabel}
          onUndoNote={() => {
            handleUndoNote();
          }}
          onRedoNote={() => {
            handleRedoNote();
          }}
          canUndoWorkspace={historyUi.canUndoWorkspace}
          canRedoWorkspace={historyUi.canRedoWorkspace}
          workspaceUndoLabel={historyUi.workspaceUndoLabel}
          workspaceRedoLabel={historyUi.workspaceRedoLabel}
          onUndoWorkspace={() => {
            handleUndoWorkspace();
          }}
          onRedoWorkspace={() => {
            handleRedoWorkspace();
          }}
        />
      )}
    </div>
  );
}

export default App;
