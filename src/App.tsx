import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  BarChart3,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Compass,
  Download,
  FilePlus2,
  FolderSync,
  Gavel,
  Inbox,
  KeyRound,
  Layers,
  Loader2,
  Maximize2,
  Minimize2,
  Moon,
  PanelLeft,
  Plus,
  RotateCcw,
  Search,
  Sun,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { AiSettingsModal, AiStructureModal } from './components/AiStructureModal';
import { CommandPalette } from './components/CommandPalette';
import { ContextRadar } from './components/ContextRadar';
import {
  DecisionsGlobalView,
  PeopleDirectoryView,
  TasksGlobalView,
} from './components/DirectoryViews';
import { HybridEditor } from './components/HybridEditor';
import { ReportsView } from './components/ReportsView';
import type {
  ActiveMainView,
  AiConfig,
  Client,
  DecisionStatus,
  Note,
  NoteFilter,
  ParsedDecision,
  ParsedTask,
  Person,
  Project,
  TaskStatus,
  WorkspaceDirectory,
} from './types';
import {
  getAiActivitySnapshot,
  loadAiConfig,
  subscribeAiActivity,
} from './utils/aiProvider';
import { hydrateImagesFromIdb } from './utils/imageStore';
import {
  computeNoteFilePath,
  deleteDecisionFromBody,
  deleteTaskFromBody,
  extractInlineMentions,
  getAllNoteLabels,
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
  exportWorkspaceZip,
  type FsDirectoryHandle,
  idbGet,
  idbSet,
  importFilesIntoWorkspace,
  isFolderSyncSupported,
  loadPersistedDirHandle,
  pickSyncDirectory,
  removeNestedFileIfExists,
  requestHandlePermission,
  syncWorkspaceWithFolder,
  writeDirectoryMetadata,
  writeNoteToFolder,
} from './utils/storage';

const CLIENT_PALETTE = ['#0284c7', '#0d9488', '#d97706', '#2563eb', '#059669', '#dc2626'];

interface UndoSnapshot {
  message: string;
  notes: Note[];
  directory: WorkspaceDirectory;
  activeNoteId: string;
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

export function App() {
  const seed = useMemo(() => createSeedWorkspace(), []);

  const [notes, setNotes] = useState<Note[]>(seed.notes);
  const [directory, setDirectory] = useState<WorkspaceDirectory>(seed.directory);
  const [activeNoteId, setActiveNoteId] = useState<string>(seed.notes[0]?.id || '');
  const [mainView, setMainView] = useState<ActiveMainView>('notes');
  const [noteFilter, setNoteFilter] = useState<NoteFilter>({ kind: 'all' });
  const [listSearch, setListSearch] = useState('');

  const [reportInitialFilter, setReportInitialFilter] = useState<{
    label?: string;
    clientId?: string;
    person?: string;
  }>({});

  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 860 : false
  );
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth > 860 : true
  );
  const [noteListOpen, setNoteListOpen] = useState(true);
  const [radarOpen, setRadarOpen] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth > 1180 : true
  );
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

  // Undo toast for fast, safe deletions
  const [undoSnapshot, setUndoSnapshot] = useState<UndoSnapshot | null>(null);
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

  // Local / OneDrive Folder Sync State
  const [dirHandle, setDirHandle] = useState<FsDirectoryHandle | null>(null);
  const [dirPermission, setDirPermission] = useState<'granted' | 'prompt' | 'denied'>('denied');
  const [syncStatus, setSyncStatus] = useState<string>('IndexedDB Local');
  const [hydrated, setHydrated] = useState(false);

  const fileImportRef = useRef<HTMLInputElement | null>(null);

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
      } else {
        setSidebarOpen(true);
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

  // Hydrate workspace from IndexedDB + one-time purge of v1 demo records
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [savedNotes, savedDir, demoPurgedV2, persistedHandle] = await Promise.all([
          idbGet<Note[]>('notes'),
          idbGet<WorkspaceDirectory>('directory'),
          idbGet<boolean>('demoPurgedV2'),
          loadPersistedDirHandle(),
          hydrateImagesFromIdb(),
        ]);

        if (!mounted) return;

        if (savedNotes && savedDir) {
          if (!demoPurgedV2) {
            const purged = purgeLegacyDemoData(savedNotes, savedDir);
            setNotes(purged.notes);
            setDirectory(purged.directory);
            setActiveNoteId(purged.notes[0]?.id || '');
            if (
              typeof window !== 'undefined' &&
              window.innerWidth <= 860 &&
              (purged.notes.length > 1 || purged.notes[0]?.title.trim() || purged.notes[0]?.body.trim())
            ) {
              setMobileNotesPane('list');
            }
            await idbSet('notes', purged.notes);
            await idbSet('directory', purged.directory);
            await idbSet('demoPurgedV2', true);

            if (purged.didPurge && persistedHandle.handle && persistedHandle.permission === 'granted') {
              const keptIds = new Set(purged.notes.map((n) => n.id));
              for (const oldNote of savedNotes) {
                if (!keptIds.has(oldNote.id) && oldNote.filePath) {
                  removeNestedFileIfExists(persistedHandle.handle, oldNote.filePath).catch(() => {});
                }
              }
              writeDirectoryMetadata(persistedHandle.handle, purged.directory).catch(() => {});
            }
          } else {
            const hydratedNotes = savedNotes.length > 0 ? savedNotes : seed.notes;
            setNotes(hydratedNotes);
            setDirectory(savedDir);
            setActiveNoteId(hydratedNotes[0].id);
            if (
              typeof window !== 'undefined' &&
              window.innerWidth <= 860 &&
              (hydratedNotes.length > 1 ||
                hydratedNotes[0]?.title.trim() ||
                hydratedNotes[0]?.body.trim())
            ) {
              setMobileNotesPane('list');
            }
          }
        } else {
          await idbSet('notes', seed.notes);
          await idbSet('directory', seed.directory);
          await idbSet('demoPurgedV2', true);
        }

        if (persistedHandle.handle) {
          setDirHandle(persistedHandle.handle);
          setDirPermission(persistedHandle.permission);
          if (persistedHandle.permission === 'granted') {
            setSyncStatus(`Synced: ${persistedHandle.handle.name}`);
          } else {
            setSyncStatus(`Reconnect: ${persistedHandle.handle.name}`);
          }
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
    if (dirHandle && dirPermission === 'granted') {
      writeDirectoryMetadata(dirHandle, directory).catch(() => {});
    }
  }, [directory, hydrated, dirHandle, dirPermission]);

  const pushUndo = useCallback(
    (message: string) => {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
      setUndoSnapshot({
        message,
        notes,
        directory,
        activeNoteId,
      });
      undoTimerRef.current = window.setTimeout(() => {
        setUndoSnapshot(null);
      }, 7000);
    },
    [notes, directory, activeNoteId]
  );

  const handleUndo = useCallback(() => {
    if (!undoSnapshot) return;
    if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    setNotes(undoSnapshot.notes);
    setDirectory(undoSnapshot.directory);
    setActiveNoteId(undoSnapshot.activeNoteId);
    setUndoSnapshot(null);
    if (dirHandle && dirPermission === 'granted') {
      syncWorkspaceWithFolder(dirHandle, undoSnapshot.notes, undoSnapshot.directory).catch(() => {});
    }
  }, [undoSnapshot, dirHandle, dirPermission]);

  const openNoteEditor = useCallback((id: string) => {
    setActiveNoteId(id);
    setMainView('notes');
    setMobileNotesPane('editor');
    if (typeof window !== 'undefined' && window.innerWidth <= 860) {
      setSidebarOpen(false);
      setRadarOpen(false);
    }
  }, []);

  const applyNotesFilter = useCallback((nextFilter: NoteFilter) => {
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
    setMainView(view);
    if (typeof window !== 'undefined' && window.innerWidth <= 860) {
      setSidebarOpen(false);
      setRadarOpen(false);
    }
  }, []);

  // Global keyboard shortcuts: Ctrl/Cmd+K (Command Palette), Alt+N (Instant New Note)
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

    setNotes((prev) => [fresh, ...prev]);
    setActiveNoteId(fresh.id);
    setMainView('notes');
    setMobileNotesPane('editor');
    if (typeof window !== 'undefined' && window.innerWidth <= 860) {
      setSidebarOpen(false);
      setRadarOpen(false);
    }
    setTimeout(() => {
      document.getElementById('note-title-input')?.focus();
    }, 30);
  }, [noteFilter]);

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
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleSpinUpNote();
      } else if (
        (e.altKey && !e.ctrlKey && !e.metaKey && (e.key.toLowerCase() === 'z' || e.key === 'Ω')) ||
        ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === '\\')
      ) {
        e.preventDefault();
        handleToggleFocusMode();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSpinUpNote, handleToggleFocusMode]);

  const activeNote = useMemo(() => {
    return notes.find((n) => n.id === activeNoteId) || notes[0] || makeFreshNote();
  }, [notes, activeNoteId]);

  const handleOpenOrCreateNoteByTitle = useCallback(
    (targetTitle: string) => {
      const found = notes.find(
        (x) => x.title.toLowerCase() === targetTitle.toLowerCase()
      );
      if (found) {
        openNoteEditor(found.id);
      } else {
        const created = makeFreshNote({
          title: targetTitle,
          scope: activeNote.scope,
          clientId: activeNote.clientId,
          projectId: activeNote.projectId,
        });
        setNotes((prev) => [created, ...prev]);
        openNoteEditor(created.id);
      }
    },
    [notes, activeNote.scope, activeNote.clientId, activeNote.projectId, openNoteEditor]
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
    for (const n of notes) {
      if (n.scope === 'inbox') inboxCount++;
      const items = parseNoteItems(n, directory.people);
      openTasks += items.tasks.filter((t) => t.status !== 'done').length;
      totalDecisions += items.decisions.length;
    }
    return { openTasks, totalDecisions, inboxCount };
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

  const syncSingleNoteToDisk = useCallback(
    async (updatedNote: Note, previousPath?: string, customDir?: WorkspaceDirectory) => {
      if (!dirHandle || dirPermission !== 'granted') return;
      try {
        const nextPath = await writeNoteToFolder(
          dirHandle,
          updatedNote,
          customDir || directory,
          previousPath
        );
        if (nextPath !== updatedNote.filePath) {
          setNotes((prev) =>
            prev.map((n) => (n.id === updatedNote.id ? { ...n, filePath: nextPath } : n))
          );
        }
      } catch {
        setSyncStatus('Sync warning — check folder access');
      }
    },
    [dirHandle, dirPermission, directory]
  );

  const handleUpdateNote = useCallback(
    (updated: Note) => {
      const prevNote = notes.find((n) => n.id === updated.id);
      const computedPath = computeNoteFilePath(updated, directory);
      const withPath = { ...updated, filePath: computedPath };
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? withPath : n)));
      syncSingleNoteToDisk(withPath, prevNote?.filePath);
    },
    [notes, directory, syncSingleNoteToDisk]
  );

  const handleDeleteNote = useCallback(
    (noteId: string) => {
      const target = notes.find((n) => n.id === noteId);
      if (!target) return;
      pushUndo(`Deleted note "${target.title || 'Untitled Note'}"`);
      const remaining = notes.filter((n) => n.id !== noteId);
      if (remaining.length === 0) {
        const fresh = makeFreshNote();
        setNotes([fresh]);
        setActiveNoteId(fresh.id);
        setMobileNotesPane('editor');
      } else {
        setNotes(remaining);
        if (activeNoteId === noteId) setActiveNoteId(remaining[0].id);
        if (typeof window !== 'undefined' && window.innerWidth <= 860) {
          setMobileNotesPane('list');
        }
      }
      if (target.filePath && dirHandle && dirPermission === 'granted') {
        removeNestedFileIfExists(dirHandle, target.filePath);
      }
    },
    [notes, activeNoteId, dirHandle, dirPermission, pushUndo]
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

  const handleUpdatePerson = useCallback(
    (updated: Person, previousName?: string) => {
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
    []
  );

  const handleDeletePerson = useCallback(
    (personId: string) => {
      const target = directory.people.find((p) => p.id === personId);
      if (!target) return;
      pushUndo(`Deleted person "${target.name}"`);
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
    [directory.people, noteFilter, pushUndo]
  );

  const handleAddClient = useCallback(
    (name: string, domain?: string): string => {
      const existing = directory.clients.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (existing) return existing.id;
      const id = `client-${slugify(name)}-${Date.now().toString(36).slice(-3)}`;
      const created: Client = {
        id,
        name,
        domain,
        color: CLIENT_PALETTE[directory.clients.length % CLIENT_PALETTE.length],
      };
      setDirectory((prev) => ({ ...prev, clients: [...prev.clients, created] }));
      return id;
    },
    [directory.clients]
  );

  const handleUpdateClient = useCallback((updated: Client) => {
    setDirectory((prev) => ({
      ...prev,
      clients: prev.clients.map((c) => (c.id === updated.id ? updated : c)),
    }));
  }, []);

  const handleDeleteClient = useCallback(
    (clientId: string) => {
      const target = directory.clients.find((c) => c.id === clientId);
      if (!target) return;
      pushUndo(`Deleted client "${target.name}"`);

      const removedProjectIds = new Set(
        directory.projects.filter((p) => p.clientId === clientId).map((p) => p.id)
      );

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
    [directory, noteFilter, pushUndo, syncSingleNoteToDisk]
  );

  const handleAddProject = useCallback(
    (name: string, scope: 'client' | 'internal', clientId: string | null): string => {
      const id = `proj-${slugify(name)}-${Date.now().toString(36).slice(-3)}`;
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
    []
  );

  const handleUpdateProject = useCallback((updated: Project) => {
    setDirectory((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => (p.id === updated.id ? updated : p)),
    }));
  }, []);

  const handleDeleteProject = useCallback(
    (projectId: string) => {
      const target = directory.projects.find((p) => p.id === projectId);
      if (!target) return;
      pushUndo(`Deleted project "${target.name}"`);

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
    [directory, noteFilter, pushUndo, syncSingleNoteToDisk]
  );

  const handleAddLabel = useCallback((rawLabel: string) => {
    const norm = normalizeLabel(rawLabel);
    if (!norm) return;
    setDirectory((prev) =>
      prev.customLabels.includes(norm)
        ? prev
        : { ...prev, customLabels: [...prev.customLabels, norm] }
    );
  }, []);

  const handleDeleteLabel = useCallback(
    (rawLabel: string) => {
      const norm = normalizeLabel(rawLabel);
      if (!norm) return;
      pushUndo(`Deleted #${norm} label`);

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
    [noteFilter, pushUndo, syncSingleNoteToDisk]
  );

  const handleUpdateRemoteTaskStatus = useCallback(
    (task: ParsedTask, nextStatus: TaskStatus) => {
      const target = notes.find((n) => n.id === task.noteId);
      if (!target) return;
      const nextBody = updateTaskInBody(target.body, task.lineIndex, { status: nextStatus });
      handleUpdateNote({ ...target, body: nextBody, updatedAt: new Date().toISOString() });
    },
    [notes, handleUpdateNote]
  );

  const handleDeleteRemoteTask = useCallback(
    (task: ParsedTask) => {
      const target = notes.find((n) => n.id === task.noteId);
      if (!target) return;
      pushUndo(`Deleted task "${task.text.slice(0, 34)}"`);
      const nextBody = deleteTaskFromBody(target.body, task.lineIndex);
      handleUpdateNote({ ...target, body: nextBody, updatedAt: new Date().toISOString() });
    },
    [notes, handleUpdateNote, pushUndo]
  );

  const handleUpdateRemoteDecisionStatus = useCallback(
    (decision: ParsedDecision, nextStatus: DecisionStatus) => {
      const target = notes.find((n) => n.id === decision.noteId);
      if (!target) return;
      const nextBody = updateDecisionInBody(target.body, decision.lineIndex, { status: nextStatus });
      handleUpdateNote({ ...target, body: nextBody, updatedAt: new Date().toISOString() });
    },
    [notes, handleUpdateNote]
  );

  const handleDeleteRemoteDecision = useCallback(
    (decision: ParsedDecision) => {
      const target = notes.find((n) => n.id === decision.noteId);
      if (!target) return;
      pushUndo(`Deleted decision "${decision.text.slice(0, 34)}"`);
      const nextBody = deleteDecisionFromBody(target.body, decision.lineIndex);
      handleUpdateNote({ ...target, body: nextBody, updatedAt: new Date().toISOString() });
    },
    [notes, handleUpdateNote, pushUndo]
  );

  const handleConnectOrSyncFolder = async () => {
    try {
      if (dirHandle && dirPermission === 'prompt') {
        const granted = await requestHandlePermission(dirHandle);
        if (granted) {
          setDirPermission('granted');
          setSyncStatus(`Syncing ${dirHandle.name}…`);
          const synced = await syncWorkspaceWithFolder(dirHandle, notes, directory);
          setNotes(synced.notes);
          setDirectory(synced.directory);
          setSyncStatus(`Synced: ${dirHandle.name}`);
          return;
        }
      }

      if (!isFolderSyncSupported()) {
        alert(
          'Live folder sync requires opening Strata in Chrome or Microsoft Edge over HTTPS or localhost. Use ZIP Export/Import in the meantime.'
        );
        return;
      }

      const picked = await pickSyncDirectory();
      if (!picked) return;
      setDirHandle(picked);
      setDirPermission('granted');
      setSyncStatus(`Syncing ${picked.name}…`);
      const synced = await syncWorkspaceWithFolder(picked, notes, directory);
      setNotes(synced.notes);
      setDirectory(synced.directory);
      if (synced.notes.length > 0 && !synced.notes.some((n) => n.id === activeNoteId)) {
        setActiveNoteId(synced.notes[0].id);
      }
      setSyncStatus(`Synced: ${picked.name}`);
    } catch {
      // User cancelled picker
    }
  };

  const handleResetCleanWorkspace = () => {
    if (!window.confirm('Delete all notes, clients, projects, and people in this browser workspace?')) {
      return;
    }
    pushUndo('Cleared entire workspace');
    const fresh = makeFreshNote();
    const emptyDir: WorkspaceDirectory = {
      clients: [],
      projects: [],
      people: [],
      customLabels: [],
    };
    setNotes([fresh]);
    setDirectory(emptyDir);
    setActiveNoteId(fresh.id);
    setNoteFilter({ kind: 'all' });
    setMainView('notes');
  };

  const shellClass = [
    'app-shell',
    !sidebarOpen ? 'sidebar-collapsed' : '',
    mainView !== 'notes' || !radarOpen ? 'radar-collapsed' : '',
    isFocusMode ? 'focus-mode' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const activeBreadcrumbLabel = useMemo(() => {
    if (mainView === 'reports') return 'Reports Hub';
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
  }, [mainView, noteFilter, directory.clients, directory.projects]);

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
                className={`nav-item ${mainView === 'reports' ? 'active' : ''}`}
                onClick={() => {
                  setReportInitialFilter({});
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
                        setReportInitialFilter({ label: lbl });
                        switchPrimaryView('reports');
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

          {/* Storage & OneDrive Folder Sync Footer */}
          <div className="sidebar-footer">
            <div className="sync-banner">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {syncStatus}
              </span>
              <button
                type="button"
                className="btn btn-xs btn-soft"
                onClick={handleConnectOrSyncFolder}
                title="Connect or sync a local / OneDrive folder of plain Markdown (.md) notes"
              >
                <FolderSync size={12} />
                {dirHandle && dirPermission === 'granted' ? 'Sync' : 'Folder'}
              </button>
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
                    setNotes(res.notes);
                    setDirectory(res.directory);
                    if (res.notes[0]) setActiveNoteId(res.notes[0].id);
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
                    title="Context Radar"
                    aria-label="Toggle Context Radar"
                  >
                    <Compass size={16} />
                  </button>
                )}

                <button
                  type="button"
                  className={`btn btn-icon ${aiActivity.isBusy ? 'ai-pill-busy' : 'btn-ghost'}`}
                  onClick={() => setShowAiSettings(true)}
                  title={aiActivity.isBusy ? `${aiActivity.label} (${aiActivity.providerLabel})` : 'Configure AI Engine'}
                  aria-label={aiActivity.isBusy ? aiActivity.label || 'AI request in progress' : 'Configure AI Engine'}
                >
                  {aiActivity.isBusy ? <Loader2 size={15} className="ai-spin" /> : <KeyRound size={15} />}
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
                      <span className="breadcrumb-active">{activeNote.title || 'Untitled Note'}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="topbar-right">
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
                      : 'Configure AI Provider (Local Smart Engine, Azure OpenAI, Gemini, OpenAI, Anthropic)'
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
                      title="Toggle Context Radar Sidebar"
                    >
                      <Compass size={13} /> Context Radar
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
                            onClick={() => {
                              setReportInitialFilter({ label: noteFilter.label });
                              switchPrimaryView('reports');
                            }}
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
              onAddClient={(name) => handleAddClient(name)}
              onAddProject={handleAddProject}
              onEnsurePerson={handleEnsurePerson}
              onNavigateLabel={(lbl) => {
                setReportInitialFilter({ label: lbl });
                switchPrimaryView('reports');
              }}
              onNavigatePerson={(pName) => applyNotesFilter({ kind: 'person', personName: pName })}
              onNavigateOrCreateNoteByTitle={handleOpenOrCreateNoteByTitle}
              onOpenAiStructure={() => setShowAiStructure(true)}
              onOpenQuickAsk={() => {
                setSidebarOpen(false);
                setRadarOpen(true);
                setRadarRequestedTab('ask');
                setTimeout(() => {
                  document.getElementById('radar-ask-input')?.focus();
                }, 40);
              }}
            />
          </div>
        )}

        {mainView === 'reports' && (
          <ReportsView
            key={`${reportInitialFilter.label || ''}-${reportInitialFilter.clientId || ''}-${reportInitialFilter.person || ''}`}
            notes={notes}
            directory={directory}
            allLabels={allWorkspaceLabels}
            aiConfig={aiConfig}
            initialLabelFilter={reportInitialFilter.label}
            initialClientFilter={reportInitialFilter.clientId}
            initialPersonFilter={reportInitialFilter.person}
            onOpenNote={openNoteEditor}
            onOpenNoteByTitle={handleOpenOrCreateNoteByTitle}
            onUpdateTaskStatus={handleUpdateRemoteTaskStatus}
            onDeleteTask={handleDeleteRemoteTask}
            onUpdateDecisionStatus={handleUpdateRemoteDecisionStatus}
            onDeleteDecision={handleDeleteRemoteDecision}
            onSaveBriefAsNote={(title, body, cId, pId) => {
              const saved = makeFreshNote({
                title,
                body,
                scope: cId ? 'client' : 'internal',
                clientId: cId,
                projectId: pId,
                labels: ['report'],
              });
              setNotes((prev) => [saved, ...prev]);
              openNoteEditor(saved.id);
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
            onCreatePerson={(p) =>
              setDirectory((prev) => ({
                ...prev,
                people: [
                  ...prev.people,
                  { ...p, id: `person-${slugify(p.name)}-${Date.now().toString(36).slice(-3)}` },
                ],
              }))
            }
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
            setReportInitialFilter({});
            switchPrimaryView('reports');
          }}
        >
          <span className="mobile-nav-icon-wrap">
            <BarChart3 size={18} />
          </span>
          <span>Reports</span>
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

      {/* Right Sidebar: Live Context Radar */}
      {mainView === 'notes' && radarOpen && (
        <ContextRadar
          activeNote={activeNote}
          allNotes={notes}
          directory={directory}
          aiConfig={aiConfig}
          requestedTab={radarRequestedTab}
          onClearRequestedTab={() => setRadarRequestedTab(null)}
          onInsertIntoActiveNote={(snippet) => {
            const base = activeNote.body.trimEnd();
            handleUpdateNote({
              ...activeNote,
              body: base ? `${base}\n\n${snippet}` : snippet,
              updatedAt: new Date().toISOString(),
            });
            if (isMobile) setRadarOpen(false);
          }}
          onOpenNote={openNoteEditor}
          onOpenNoteByTitle={handleOpenOrCreateNoteByTitle}
          onSelectPerson={(pName) => applyNotesFilter({ kind: 'person', personName: pName })}
          onSelectLabel={(lbl) => applyNotesFilter({ kind: 'label', label: lbl })}
          onToggleRemoteTaskStatus={handleUpdateRemoteTaskStatus}
          onCollapse={() => setRadarOpen(false)}
        />
      )}

      {/* Undo Deletion Toast */}
      {undoSnapshot && (
        <div className="undo-toast no-print" role="status" aria-live="polite">
          <span>{undoSnapshot.message}</span>
          <button type="button" className="undo-toast-btn" onClick={handleUndo}>
            Undo
          </button>
          <button
            type="button"
            className="mini-icon-btn"
            style={{ color: 'inherit', opacity: 0.7 }}
            onClick={() => setUndoSnapshot(null)}
            aria-label="Dismiss notification"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Modals */}
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
            handleUpdateNote(updated);
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
          onSave={setAiConfig}
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
          onDeleteCurrentNote={() => handleDeleteNote(activeNote.id)}
          onSelectNote={openNoteEditor}
          onOpenReportForLabel={(lbl) => {
            setReportInitialFilter({ label: lbl });
            switchPrimaryView('reports');
          }}
          onOpenPersonNotes={(name) => applyNotesFilter({ kind: 'person', personName: name })}
          onSwitchMainView={switchPrimaryView}
          onTriggerAiStructure={() => {
            switchPrimaryView('notes');
            setMobileNotesPane('editor');
            setShowAiStructure(true);
          }}
          onToggleTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          onConnectFolder={handleConnectOrSyncFolder}
        />
      )}
    </div>
  );
}

export default App;
