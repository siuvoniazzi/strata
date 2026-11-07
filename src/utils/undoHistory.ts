import type { ActiveMainView, Note, NoteFilter, WorkspaceDirectory } from '../types';

export type EditorSelectionSnapshot =
  | {
      kind: 'doc';
      startBlock: number;
      startOffset: number;
      endBlock: number;
      endOffset: number;
    }
  | {
      kind: 'title';
      start: number;
      end: number;
    }
  | {
      kind: 'raw';
      start: number;
      end: number;
    }
  | null;

export interface PendingSelectionRestore {
  noteId: string;
  selection: EditorSelectionSnapshot;
  nonce: number;
}

export interface NoteEditMeta {
  label?: string;
  /**
   * Consecutive edits sharing the same non-null coalesceKey within a short time window
   * are merged into a single undo step (e.g. typing bursts or Backspace bursts).
   */
  coalesceKey?: string | null;
  /**
   * Signals a natural phrase boundary (such as typing a space) so long continuous
   * typing splits cleanly into word/phrase-sized undo steps.
   */
  wordBoundary?: boolean;
  selectionBefore?: EditorSelectionSnapshot;
  selectionAfter?: EditorSelectionSnapshot;
}

export interface NoteHistoryEntry {
  note: Note;
  wasDraft: boolean;
  selection: EditorSelectionSnapshot;
  label: string;
  seq: number;
}

interface CoalesceGroup {
  key: string;
  startedAt: number;
  lastAt: number;
}

interface NoteHistoryBucket {
  undoStack: NoteHistoryEntry[];
  redoStack: NoteHistoryEntry[];
  lastSelection: EditorSelectionSnapshot;
  activeGroup: CoalesceGroup | null;
}

export interface WorkspaceSnapshotState {
  notes: Note[];
  directory: WorkspaceDirectory;
  activeNoteId: string;
  draftNote: Note | null;
  noteFilter: NoteFilter;
  mainView: ActiveMainView;
}

export interface WorkspaceEditMeta {
  label: string;
  coalesceKey?: string | null;
}

export interface WorkspaceHistoryEntry {
  state: WorkspaceSnapshotState;
  label: string;
  seq: number;
}

export interface HistoryUiSnapshot {
  activeNoteId: string;
  canUndoNote: boolean;
  canRedoNote: boolean;
  noteUndoLabel: string | null;
  noteRedoLabel: string | null;
  canUndoWorkspace: boolean;
  canRedoWorkspace: boolean;
  workspaceUndoLabel: string | null;
  workspaceRedoLabel: string | null;
}

const MAX_NOTE_HISTORY = 100;
const MAX_WORKSPACE_HISTORY = 50;
const COALESCE_IDLE_MS = 750;
const COALESCE_WORD_BOUNDARY_MS = 400;
const COALESCE_MAX_SPAN_MS = 4000;

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function areNotesContentEqual(a: Note, b: Note): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.date === b.date &&
    a.scope === b.scope &&
    a.clientId === b.clientId &&
    a.projectId === b.projectId &&
    areStringArraysEqual(a.participants, b.participants) &&
    areStringArraysEqual(a.labels, b.labels)
  );
}

export function inferNoteChangeLabel(prev: Note, next: Note): string {
  if (prev.title !== next.title && prev.body === next.body) return 'Edit title';
  if (prev.scope !== next.scope || prev.clientId !== next.clientId) return 'Change space';
  if (prev.projectId !== next.projectId) return 'Change project';
  if (prev.date !== next.date) return 'Change date';
  if (!areStringArraysEqual(prev.participants, next.participants)) return 'Update participants';
  if (!areStringArraysEqual(prev.labels, next.labels)) return 'Update labels';
  return 'Edit note';
}

export class UndoHistoryStore {
  private noteBuckets = new Map<string, NoteHistoryBucket>();
  private workspaceUndoStack: WorkspaceHistoryEntry[] = [];
  private workspaceRedoStack: WorkspaceHistoryEntry[] = [];
  private workspaceActiveGroup: CoalesceGroup | null = null;
  private seq = 0;
  private listeners = new Set<() => void>();
  private cachedSnapshot: HistoryUiSnapshot | null = null;

  private getOrCreateBucket(noteId: string): NoteHistoryBucket {
    let bucket = this.noteBuckets.get(noteId);
    if (!bucket) {
      bucket = {
        undoStack: [],
        redoStack: [],
        lastSelection: null,
        activeGroup: null,
      };
      this.noteBuckets.set(noteId, bucket);
    }
    return bucket;
  }

  private emit(): void {
    this.cachedSnapshot = null;
    this.listeners.forEach((listener) => listener());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getUiSnapshot(activeNoteId: string): HistoryUiSnapshot {
    const bucket = this.noteBuckets.get(activeNoteId);
    const noteUndoTop = bucket && bucket.undoStack.length > 0 ? bucket.undoStack[bucket.undoStack.length - 1] : null;
    const noteRedoTop = bucket && bucket.redoStack.length > 0 ? bucket.redoStack[bucket.redoStack.length - 1] : null;
    const wsUndoTop =
      this.workspaceUndoStack.length > 0
        ? this.workspaceUndoStack[this.workspaceUndoStack.length - 1]
        : null;
    const wsRedoTop =
      this.workspaceRedoStack.length > 0
        ? this.workspaceRedoStack[this.workspaceRedoStack.length - 1]
        : null;

    const next: HistoryUiSnapshot = {
      activeNoteId,
      canUndoNote: Boolean(noteUndoTop),
      canRedoNote: Boolean(noteRedoTop),
      noteUndoLabel: noteUndoTop ? noteUndoTop.label : null,
      noteRedoLabel: noteRedoTop ? noteRedoTop.label : null,
      canUndoWorkspace: Boolean(wsUndoTop),
      canRedoWorkspace: Boolean(wsRedoTop),
      workspaceUndoLabel: wsUndoTop ? wsUndoTop.label : null,
      workspaceRedoLabel: wsRedoTop ? wsRedoTop.label : null,
    };

    const prev = this.cachedSnapshot;
    if (
      prev &&
      prev.activeNoteId === next.activeNoteId &&
      prev.canUndoNote === next.canUndoNote &&
      prev.canRedoNote === next.canRedoNote &&
      prev.noteUndoLabel === next.noteUndoLabel &&
      prev.noteRedoLabel === next.noteRedoLabel &&
      prev.canUndoWorkspace === next.canUndoWorkspace &&
      prev.canRedoWorkspace === next.canRedoWorkspace &&
      prev.workspaceUndoLabel === next.workspaceUndoLabel &&
      prev.workspaceRedoLabel === next.workspaceRedoLabel
    ) {
      return prev;
    }

    this.cachedSnapshot = next;
    return next;
  }

  updateNoteSelection(noteId: string, selection: EditorSelectionSnapshot): void {
    const bucket = this.getOrCreateBucket(noteId);
    bucket.lastSelection = selection;
  }

  breakNoteCoalescing(noteId?: string): void {
    if (noteId) {
      const bucket = this.noteBuckets.get(noteId);
      if (bucket) bucket.activeGroup = null;
      return;
    }
    this.noteBuckets.forEach((b) => {
      b.activeGroup = null;
    });
  }

  recordNoteChange(
    prevNote: Note,
    prevWasDraft: boolean,
    nextNote: Note,
    meta?: NoteEditMeta
  ): void {
    if (areNotesContentEqual(prevNote, nextNote)) {
      if (meta?.selectionAfter !== undefined) {
        this.updateNoteSelection(nextNote.id, meta.selectionAfter);
      }
      return;
    }

    const bucket = this.getOrCreateBucket(nextNote.id);
    const now = performance.now();
    const coalesceKey = meta?.coalesceKey ?? null;
    const active = bucket.activeGroup;

    const shouldCoalesce =
      coalesceKey !== null &&
      active !== null &&
      bucket.undoStack.length > 0 &&
      active.key === coalesceKey &&
      now - active.lastAt <= COALESCE_IDLE_MS &&
      now - active.startedAt <= COALESCE_MAX_SPAN_MS &&
      !(meta?.wordBoundary && now - active.startedAt >= COALESCE_WORD_BOUNDARY_MS);

    const nextSeq = ++this.seq;
    const hadRedo = bucket.redoStack.length > 0;
    bucket.redoStack = [];

    if (shouldCoalesce && active) {
      bucket.undoStack[bucket.undoStack.length - 1].seq = nextSeq;
      active.lastAt = now;
      if (meta?.selectionAfter !== undefined) {
        bucket.lastSelection = meta.selectionAfter;
      }
      if (hadRedo) {
        this.emit();
      }
      return;
    }

    const selectionBefore =
      meta?.selectionBefore !== undefined ? meta.selectionBefore : bucket.lastSelection;
    const label = meta?.label || inferNoteChangeLabel(prevNote, nextNote);

    bucket.undoStack.push({
      note: prevNote,
      wasDraft: prevWasDraft,
      selection: selectionBefore,
      label,
      seq: nextSeq,
    });

    if (bucket.undoStack.length > MAX_NOTE_HISTORY) {
      bucket.undoStack.shift();
    }

    bucket.activeGroup = coalesceKey
      ? { key: coalesceKey, startedAt: now, lastAt: now }
      : null;

    if (meta?.selectionAfter !== undefined) {
      bucket.lastSelection = meta.selectionAfter;
    }

    this.emit();
  }

  undoNote(
    noteId: string,
    currentNote: Note,
    currentWasDraft: boolean
  ): { note: Note; wasDraft: boolean; selection: EditorSelectionSnapshot; label: string } | null {
    const bucket = this.noteBuckets.get(noteId);
    if (!bucket || bucket.undoStack.length === 0) return null;

    const entry = bucket.undoStack.pop()!;
    bucket.activeGroup = null;

    bucket.redoStack.push({
      note: currentNote,
      wasDraft: currentWasDraft,
      selection: bucket.lastSelection,
      label: entry.label,
      seq: ++this.seq,
    });

    bucket.lastSelection = entry.selection;
    this.emit();

    return {
      note: entry.note,
      wasDraft: entry.wasDraft,
      selection: entry.selection,
      label: entry.label,
    };
  }

  redoNote(
    noteId: string,
    currentNote: Note,
    currentWasDraft: boolean
  ): { note: Note; wasDraft: boolean; selection: EditorSelectionSnapshot; label: string } | null {
    const bucket = this.noteBuckets.get(noteId);
    if (!bucket || bucket.redoStack.length === 0) return null;

    const entry = bucket.redoStack.pop()!;
    bucket.activeGroup = null;

    bucket.undoStack.push({
      note: currentNote,
      wasDraft: currentWasDraft,
      selection: bucket.lastSelection,
      label: entry.label,
      seq: ++this.seq,
    });

    bucket.lastSelection = entry.selection;
    this.emit();

    return {
      note: entry.note,
      wasDraft: entry.wasDraft,
      selection: entry.selection,
      label: entry.label,
    };
  }

  recordWorkspaceChange(prevState: WorkspaceSnapshotState, meta: WorkspaceEditMeta): void {
    const now = performance.now();
    const coalesceKey = meta.coalesceKey ?? null;
    const active = this.workspaceActiveGroup;

    const shouldCoalesce =
      coalesceKey !== null &&
      active !== null &&
      this.workspaceUndoStack.length > 0 &&
      active.key === coalesceKey &&
      now - active.lastAt <= COALESCE_IDLE_MS &&
      now - active.startedAt <= COALESCE_MAX_SPAN_MS;

    const nextSeq = ++this.seq;
    const hadRedo = this.workspaceRedoStack.length > 0;
    this.workspaceRedoStack = [];

    if (shouldCoalesce && active) {
      this.workspaceUndoStack[this.workspaceUndoStack.length - 1].seq = nextSeq;
      active.lastAt = now;
      if (hadRedo) {
        this.emit();
      }
      return;
    }

    this.workspaceUndoStack.push({
      state: prevState,
      label: meta.label,
      seq: nextSeq,
    });

    if (this.workspaceUndoStack.length > MAX_WORKSPACE_HISTORY) {
      this.workspaceUndoStack.shift();
    }

    this.workspaceActiveGroup = coalesceKey
      ? { key: coalesceKey, startedAt: now, lastAt: now }
      : null;

    this.emit();
  }

  undoWorkspace(
    currentState: WorkspaceSnapshotState
  ): { state: WorkspaceSnapshotState; label: string } | null {
    if (this.workspaceUndoStack.length === 0) return null;

    const entry = this.workspaceUndoStack.pop()!;
    this.workspaceActiveGroup = null;
    this.breakNoteCoalescing();

    this.workspaceRedoStack.push({
      state: currentState,
      label: entry.label,
      seq: ++this.seq,
    });

    this.emit();
    return { state: entry.state, label: entry.label };
  }

  redoWorkspace(
    currentState: WorkspaceSnapshotState
  ): { state: WorkspaceSnapshotState; label: string } | null {
    if (this.workspaceRedoStack.length === 0) return null;

    const entry = this.workspaceRedoStack.pop()!;
    this.workspaceActiveGroup = null;
    this.breakNoteCoalescing();

    this.workspaceUndoStack.push({
      state: currentState,
      label: entry.label,
      seq: ++this.seq,
    });

    this.emit();
    return { state: entry.state, label: entry.label };
  }

  resolveUndoTarget(params: {
    activeNoteId: string;
    inNotesEditor: boolean;
    focusInNoteEditor: boolean;
    workspaceToastActive: boolean;
  }): 'note' | 'workspace' | null {
    const wsTop =
      this.workspaceUndoStack.length > 0
        ? this.workspaceUndoStack[this.workspaceUndoStack.length - 1]
        : null;

    if (!params.inNotesEditor) {
      return wsTop ? 'workspace' : null;
    }

    const bucket = this.noteBuckets.get(params.activeNoteId);
    const noteTop =
      bucket && bucket.undoStack.length > 0 ? bucket.undoStack[bucket.undoStack.length - 1] : null;
    const noteRedoTop =
      bucket && bucket.redoStack.length > 0 ? bucket.redoStack[bucket.redoStack.length - 1] : null;
    const latestNoteSeq = Math.max(noteTop?.seq ?? -1, noteRedoTop?.seq ?? -1);

    if (params.workspaceToastActive && wsTop && wsTop.seq > latestNoteSeq) {
      return 'workspace';
    }

    if (params.focusInNoteEditor) {
      return noteTop ? 'note' : null;
    }

    if (noteTop && wsTop) {
      return wsTop.seq >= noteTop.seq ? 'workspace' : 'note';
    }
    if (wsTop) return 'workspace';
    if (noteTop) return 'note';
    return null;
  }

  resolveRedoTarget(params: {
    activeNoteId: string;
    inNotesEditor: boolean;
    focusInNoteEditor: boolean;
    workspaceToastActive: boolean;
  }): 'note' | 'workspace' | null {
    const wsTop =
      this.workspaceRedoStack.length > 0
        ? this.workspaceRedoStack[this.workspaceRedoStack.length - 1]
        : null;

    if (!params.inNotesEditor) {
      return wsTop ? 'workspace' : null;
    }

    const bucket = this.noteBuckets.get(params.activeNoteId);
    const noteTop =
      bucket && bucket.redoStack.length > 0 ? bucket.redoStack[bucket.redoStack.length - 1] : null;
    const noteUndoTop =
      bucket && bucket.undoStack.length > 0 ? bucket.undoStack[bucket.undoStack.length - 1] : null;
    const latestNoteSeq = Math.max(noteTop?.seq ?? -1, noteUndoTop?.seq ?? -1);

    if (params.workspaceToastActive && wsTop && wsTop.seq > latestNoteSeq) {
      return 'workspace';
    }

    if (params.focusInNoteEditor) {
      return noteTop ? 'note' : null;
    }

    if (noteTop && wsTop) {
      return wsTop.seq >= noteTop.seq ? 'workspace' : 'note';
    }
    if (wsTop) return 'workspace';
    if (noteTop) return 'note';
    return null;
  }
}
