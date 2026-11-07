import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bold,
  Calendar,
  CheckSquare,
  Code2,
  ExternalLink,
  Eye,
  FilePlus2,
  FolderKanban,
  Gavel,
  Hash,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  MailPlus,
  Plus,
  Quote,
  Redo2,
  Sparkles,
  Strikethrough,
  Trash2,
  Undo2,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';
import type {
  DecisionStatus,
  Note,
  NoteScope,
  Person,
  TaskStatus,
  WorkspaceDirectory,
} from '../types';
import {
  detectUnlinkedPeopleInText,
  formatPersonMention,
  getAllNoteLabels,
  normalizeLabel,
  parseMeetingInviteText,
  parseNoteItems,
  removeLabelFromNote,
  resolveKnownPersonName,
  slugify,
} from '../utils/markdown';
import {
  createImageBlockElement,
  domToMarkdown,
  markdownToHtml,
  sanitizePastedHtml,
} from '../utils/docSerializer';
import { resolveImageSrc, saveBlobAsImageAsset } from '../utils/imageStore';
import { NOTE_TEMPLATES } from '../utils/seedData';
import type {
  EditorSelectionSnapshot,
  NoteEditMeta,
  PendingSelectionRestore,
} from '../utils/undoHistory';
import { ImageLightboxModal, type LightboxImageItem } from './ImageLightboxModal';

const IS_MAC_PLATFORM =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const UNDO_SHORTCUT_HINT = IS_MAC_PLATFORM ? '⌘Z' : 'Ctrl+Z';
const REDO_SHORTCUT_HINT = IS_MAC_PLATFORM ? '⇧⌘Z' : 'Ctrl+Y';

interface HybridEditorProps {
  note: Note;
  allNotes: Note[];
  directory: WorkspaceDirectory;
  allWorkspaceLabels: string[];
  onUpdateNote: (updated: Note, meta?: NoteEditMeta) => void;
  onDeleteNote: (noteId: string) => void;
  onAddClient: (name: string, domain?: string, options?: { recordHistory?: boolean }) => string;
  onAddProject: (
    name: string,
    scope: 'client' | 'internal',
    clientId: string | null,
    options?: { recordHistory?: boolean }
  ) => string;
  onEnsurePerson: (name: string, clientId?: string | null, email?: string) => Person;
  onNavigateLabel: (label: string) => void;
  onNavigatePerson: (personName: string) => void;
  onNavigateOrCreateNoteByTitle: (title: string) => void;
  onOpenAiStructure: () => void;
  onOpenQuickAsk: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  undoLabel?: string | null;
  redoLabel?: string | null;
  onUndo?: () => void;
  onRedo?: () => void;
  pendingSelectionRestore?: PendingSelectionRestore | null;
  onSyncSelection?: (selection: EditorSelectionSnapshot) => void;
}

type AutocompleteTrigger = {
  kind: 'person' | 'label' | 'link' | 'slash';
  query: string;
  tokenStart: number;
  cursorPos: number;
  textNode: Text | null;
  rect: { top: number; left: number };
};

type ActiveTokenPopover = {
  kind: 'person' | 'label' | 'link';
  value: string;
  rect: { top: number; left: number };
};

type ActiveFormatState = {
  block: 'p' | 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'blockquote' | 'task' | 'decision';
  bold: boolean;
  italic: boolean;
  strike: boolean;
};

const TASK_CYCLE: TaskStatus[] = ['todo', 'doing', 'waiting', 'done'];
const DECISION_CYCLE: DecisionStatus[] = ['agreed', 'proposed', 'superseded'];

function getOrderedDocBlocks(root: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  Array.from(root.children).forEach((child) => {
    const el = child as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (tag === 'UL' || tag === 'OL') {
      Array.from(el.children).forEach((li) => {
        if (li.tagName.toUpperCase() === 'LI') {
          blocks.push(li as HTMLElement);
        }
      });
    } else {
      blocks.push(el);
    }
  });
  return blocks;
}

function resolvePointInDocBlocks(
  root: HTMLElement,
  blocks: HTMLElement[],
  container: Node,
  offset: number
): { block: number; offset: number } | null {
  if (blocks.length === 0) return null;

  if (container === root) {
    if (offset >= root.childNodes.length) {
      const lastIdx = blocks.length - 1;
      const lastBlk = blocks[lastIdx];
      const len = lastBlk.classList.contains('doc-image-block')
        ? 0
        : (lastBlk.textContent || '').length;
      return { block: lastIdx, offset: len };
    }
    const child = root.childNodes[Math.max(0, offset)] as HTMLElement | undefined;
    if (child) {
      const directIdx = blocks.indexOf(child);
      if (directIdx !== -1) return { block: directIdx, offset: 0 };
      const firstLi = child.querySelector?.('li') as HTMLElement | null;
      if (firstLi) {
        const liIdx = blocks.indexOf(firstLi);
        if (liIdx !== -1) return { block: liIdx, offset: 0 };
      }
    }
    return { block: 0, offset: 0 };
  }

  let curr: Node | null = container;
  let foundBlock: HTMLElement | null = null;
  while (curr && curr !== root) {
    if (curr.nodeType === Node.ELEMENT_NODE) {
      const idx = blocks.indexOf(curr as HTMLElement);
      if (idx !== -1) {
        foundBlock = curr as HTMLElement;
        break;
      }
    }
    curr = curr.parentNode;
  }

  if (!foundBlock) return { block: 0, offset: 0 };
  const blockIdx = blocks.indexOf(foundBlock);
  if (
    foundBlock.classList.contains('doc-image-block') ||
    foundBlock.tagName.toUpperCase() === 'HR'
  ) {
    return { block: blockIdx, offset: 0 };
  }

  try {
    const probe = document.createRange();
    probe.selectNodeContents(foundBlock);
    probe.setEnd(container, offset);
    return { block: blockIdx, offset: probe.toString().length };
  } catch {
    return { block: blockIdx, offset: 0 };
  }
}

function captureDocSelection(root: HTMLElement): EditorSelectionSnapshot {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const blocks = getOrderedDocBlocks(root);
  const startPt = resolvePointInDocBlocks(root, blocks, range.startContainer, range.startOffset);
  const endPt = range.collapsed
    ? startPt
    : resolvePointInDocBlocks(root, blocks, range.endContainer, range.endOffset);
  if (!startPt || !endPt) return null;

  return {
    kind: 'doc',
    startBlock: startPt.block,
    startOffset: startPt.offset,
    endBlock: endPt.block,
    endOffset: endPt.offset,
  };
}

function resolveDomPointFromBlockOffset(
  blk: HTMLElement,
  targetOffset: number
): { node: Node; offset: number } {
  if (blk.classList.contains('doc-image-block') || blk.tagName.toUpperCase() === 'HR') {
    const parent = blk.parentNode;
    if (parent) {
      const idx = Array.from(parent.childNodes).indexOf(blk);
      return { node: parent, offset: Math.max(0, idx) };
    }
    return { node: blk, offset: 0 };
  }

  const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    textNodes.push(n as Text);
  }

  if (textNodes.length === 0) {
    return { node: blk, offset: 0 };
  }

  let remaining = Math.max(0, targetOffset);
  for (let i = 0; i < textNodes.length; i++) {
    const tn = textNodes[i];
    const len = (tn.nodeValue || '').length;
    if (remaining < len) {
      return { node: tn, offset: remaining };
    }
    if (remaining === len) {
      const tokenParent = tn.parentElement?.classList.contains('doc-token')
        ? tn.parentElement
        : null;
      if (
        tokenParent &&
        i + 1 < textNodes.length &&
        !tokenParent.contains(textNodes[i + 1])
      ) {
        return { node: textNodes[i + 1], offset: 0 };
      }
      return { node: tn, offset: len };
    }
    remaining -= len;
  }

  const last = textNodes[textNodes.length - 1];
  return { node: last, offset: (last.nodeValue || '').length };
}

function restoreDocSelection(
  root: HTMLElement,
  snap: Extract<EditorSelectionSnapshot, { kind: 'doc' }>
): void {
  const blocks = getOrderedDocBlocks(root);
  if (blocks.length === 0) {
    root.focus({ preventScroll: true });
    return;
  }

  const startIdx = Math.max(0, Math.min(blocks.length - 1, snap.startBlock));
  const endIdx = Math.max(0, Math.min(blocks.length - 1, snap.endBlock));
  const startBlk = blocks[startIdx];
  const endBlk = blocks[endIdx];

  const startPt = resolveDomPointFromBlockOffset(startBlk, snap.startOffset);
  const endPt =
    startIdx === endIdx && snap.startOffset === snap.endOffset
      ? startPt
      : resolveDomPointFromBlockOffset(endBlk, snap.endOffset);

  root.focus({ preventScroll: true });
  try {
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStart(startPt.node, startPt.offset);
      r.setEnd(endPt.node, endPt.offset);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  } catch {
    // Ignore transient range bounds mismatch
  }

  startBlk.scrollIntoView?.({ block: 'nearest' });
}

function placeCaretAtStart(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  if (el.firstChild && el.firstChild.nodeType === Node.TEXT_NODE) {
    range.setStart(el.firstChild, 0);
  } else {
    range.setStart(el, 0);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtEnd(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function isCaretAtStartOfBlock(block: HTMLElement, range: Range): boolean {
  if (!range.collapsed) return false;
  const probe = document.createRange();
  probe.selectNodeContents(block);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length === 0;
}

function isCaretAtEndOfBlock(block: HTMLElement, range: Range): boolean {
  if (!range.collapsed) return false;
  const probe = document.createRange();
  probe.selectNodeContents(block);
  probe.setStart(range.endContainer, range.endOffset);
  return probe.toString().length === 0;
}

function isGenericClipboardImageName(name: string): boolean {
  const trimmed = (name || '').trim();
  return !trimmed || /^(?:image|blob|clipboard|pasted[-_ ]?image)(?:\.[a-z0-9]+)?$/i.test(trimmed);
}

function extractImageFilesFromDataTransfer(
  dt: DataTransfer | null,
  options?: { fromClipboard?: boolean }
): File[] {
  if (!dt) return [];
  const files: File[] = [];
  const seen = new Set<string>();

  // 1. Read dt.files first; do NOT also iterate dt.items when dt.files already yielded images,
  // because Chromium synthesizes a new File with a fresh lastModified timestamp on each call.
  if (dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i++) {
      const f = dt.files[i];
      if (f.type.startsWith('image/')) {
        const sig = `${f.name}:${f.size}:${f.type}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          files.push(f);
        }
      }
    }
  }

  // 2. Fallback to dt.items ONLY if dt.files yielded zero image files
  if (files.length === 0 && dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) {
          const sig = `${f.name}:${f.size}:${f.type}`;
          if (!seen.has(sig)) {
            seen.add(sig);
            files.push(f);
          }
        }
      }
    }
  }

  // 3. On clipboard paste, OS clipboards often expose multiple MIME representations (e.g. PNG + BMP/JPEG,
  // or a real file alongside a synthesized "image.png" bitmap) for a single copied image.
  if (options?.fromClipboard && files.length > 1) {
    const namedFiles = files.filter((f) => !isGenericClipboardImageName(f.name));
    if (namedFiles.length > 0) {
      return namedFiles;
    }
    const preferred =
      files.find((f) => f.type === 'image/png') ||
      files.find((f) => f.type === 'image/webp') ||
      files[0];
    return [preferred];
  }

  return files;
}

function htmlContainsOnlyImageOrEmpty(rawHtml: string): boolean {
  if (!rawHtml.trim()) return true;
  try {
    const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
    doc.querySelectorAll('style, script, meta, title').forEach((n) => n.remove());
    return !(doc.body.textContent || '').trim();
  } catch {
    return false;
  }
}

function cleanImageLabelFromFile(file: File): string {
  const raw = (file.name || '').replace(/\.[^.]+$/, '').trim();
  if (!raw || /^image$/i.test(raw) || /^blob$/i.test(raw)) {
    return 'Pasted image';
  }
  return raw.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function replaceBlockElement(target: HTMLElement, replacement: HTMLElement): HTMLElement {
  const parent = target.parentElement;
  if (!parent) return replacement;

  // If replacing an <li> inside a <ul> or <ol>, split or unwrap the list cleanly
  if (target.tagName === 'LI' && (parent.tagName === 'UL' || parent.tagName === 'OL')) {
    const list = parent;
    const prevItems: Element[] = [];
    const nextItems: Element[] = [];
    let seenTarget = false;
    Array.from(list.children).forEach((child) => {
      if (child === target) {
        seenTarget = true;
      } else if (!seenTarget) {
        prevItems.push(child);
      } else {
        nextItems.push(child);
      }
    });

    const frag = document.createDocumentFragment();
    if (prevItems.length > 0) {
      const beforeList = document.createElement(list.tagName.toLowerCase());
      prevItems.forEach((item) => beforeList.appendChild(item));
      frag.appendChild(beforeList);
    }
    frag.appendChild(replacement);
    if (nextItems.length > 0) {
      const afterList = document.createElement(list.tagName.toLowerCase());
      nextItems.forEach((item) => afterList.appendChild(item));
      frag.appendChild(afterList);
    }
    list.replaceWith(frag);
    return replacement;
  }

  target.replaceWith(replacement);
  return replacement;
}

function findEditableBlock(node: Node | null, root: HTMLElement): HTMLElement | null {
  let curr: Node | null = node;
  while (curr && curr !== root) {
    if (curr.nodeType === Node.ELEMENT_NODE) {
      const el = curr as HTMLElement;
      if (el.classList.contains('doc-image-block')) {
        return null;
      }
      const tag = el.tagName.toUpperCase();
      if (
        tag === 'P' ||
        tag === 'H1' ||
        tag === 'H2' ||
        tag === 'H3' ||
        tag === 'LI' ||
        tag === 'BLOCKQUOTE' ||
        tag === 'DIV'
      ) {
        return el;
      }
    }
    curr = curr.parentNode;
  }
  return null;
}

function getSelectedEditableBlocks(root: HTMLElement): HTMLElement[] {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return [];

  if (range.collapsed) {
    const single = findEditableBlock(range.startContainer, root);
    return single ? [single] : [];
  }

  const candidates: HTMLElement[] = [];
  Array.from(root.children).forEach((child) => {
    const el = child as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (tag === 'FIGURE' || tag === 'HR' || el.classList.contains('doc-image-block')) {
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      Array.from(el.children).forEach((li) => {
        if (range.intersectsNode(li)) candidates.push(li as HTMLElement);
      });
    } else if (range.intersectsNode(el)) {
      candidates.push(el);
    }
  });
  return candidates;
}

export const HybridEditor: React.FC<HybridEditorProps> = ({
  note,
  allNotes,
  directory,
  allWorkspaceLabels,
  onUpdateNote,
  onDeleteNote,
  onAddClient,
  onAddProject,
  onEnsurePerson,
  onNavigateLabel,
  onNavigatePerson,
  onNavigateOrCreateNoteByTitle,
  onOpenAiStructure,
  onOpenQuickAsk,
  canUndo = false,
  canRedo = false,
  undoLabel = null,
  redoLabel = null,
  onUndo,
  onRedo,
  pendingSelectionRestore = null,
  onSyncSelection,
}) => {
  const [rawMode, setRawMode] = useState(false);
  const [participantInput, setParticipantInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteRawText, setInviteRawText] = useState('');
  const [newClientPrompt, setNewClientPrompt] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newProjectPrompt, setNewProjectPrompt] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [showInsertMenu, setShowInsertMenu] = useState(false);
  const [lightbox, setLightbox] = useState<{ images: LightboxImageItem[]; index: number } | null>(
    null
  );
  const [isDragOverPage, setIsDragOverPage] = useState(false);

  const [autocomplete, setAutocomplete] = useState<AutocompleteTrigger | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  const [activeToken, setActiveToken] = useState<ActiveTokenPopover | null>(null);
  const [activeFormat, setActiveFormat] = useState<ActiveFormatState>({
    block: 'p',
    bold: false,
    italic: false,
    strike: false,
  });

  const docRef = useRef<HTMLDivElement | null>(null);
  const rawTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const savedInsertRangeRef = useRef<Range | null>(null);
  const suppressImageClickUntilRef = useRef<number>(0);
  const lastSyncedNoteIdRef = useRef<string>('');
  const lastEmittedMarkdownRef = useRef<string>(note.body);
  const isComposingRef = useRef<boolean>(false);
  const selectionBeforeRef = useRef<EditorSelectionSnapshot>(null);
  const lastHandledRestoreNonceRef = useRef<number>(0);
  const pendingInputMetaRef = useRef<{
    label: string;
    coalesceKey: string | null;
    wordBoundary?: boolean;
  } | null>(null);
  const noteRef = useRef<Note>(note);
  noteRef.current = note;
  const peopleRef = useRef<Person[]>(directory.people);
  peopleRef.current = directory.people;
  const labelsRef = useRef<string[]>(allWorkspaceLabels);
  labelsRef.current = allWorkspaceLabels;

  const parsedItems = useMemo(
    () => parseNoteItems(note, directory.people),
    [note, directory.people]
  );

  const combinedLabels = useMemo(() => getAllNoteLabels(note), [note]);

  const unlinkedPeople = useMemo(
    () => detectUnlinkedPeopleInText(note.body, directory.people),
    [note.body, directory.people]
  );

  const availableProjects = useMemo(() => {
    if (note.scope === 'client') {
      return directory.projects.filter((p) => p.scope === 'client' && p.clientId === note.clientId);
    }
    if (note.scope === 'internal') {
      return directory.projects.filter((p) => p.scope === 'internal');
    }
    return [];
  }, [directory.projects, note.scope, note.clientId]);

  const captureCurrentEditorSelection = useCallback((): EditorSelectionSnapshot => {
    const active = document.activeElement;
    if (active && active === titleInputRef.current) {
      return {
        kind: 'title',
        start: titleInputRef.current.selectionStart ?? titleInputRef.current.value.length,
        end: titleInputRef.current.selectionEnd ?? titleInputRef.current.value.length,
      };
    }
    if (active && active === rawTextareaRef.current) {
      return {
        kind: 'raw',
        start: rawTextareaRef.current.selectionStart ?? rawTextareaRef.current.value.length,
        end: rawTextareaRef.current.selectionEnd ?? rawTextareaRef.current.value.length,
      };
    }
    if (docRef.current) {
      return captureDocSelection(docRef.current);
    }
    return null;
  }, []);

  const recordPreEditSelection = useCallback(() => {
    const snap = captureCurrentEditorSelection();
    if (snap) {
      selectionBeforeRef.current = snap;
      onSyncSelection?.(snap);
    }
  }, [captureCurrentEditorSelection, onSyncSelection]);

  const syncTitleSelectionBefore = useCallback(() => {
    const el = titleInputRef.current;
    if (el && el.value === noteRef.current.title) {
      const snap: EditorSelectionSnapshot = {
        kind: 'title',
        start: el.selectionStart ?? el.value.length,
        end: el.selectionEnd ?? el.value.length,
      };
      selectionBeforeRef.current = snap;
      onSyncSelection?.(snap);
    }
  }, [onSyncSelection]);

  const syncRawSelectionBefore = useCallback(() => {
    const el = rawTextareaRef.current;
    if (el && el.value === noteRef.current.body) {
      const snap: EditorSelectionSnapshot = {
        kind: 'raw',
        start: el.selectionStart ?? el.value.length,
        end: el.selectionEnd ?? el.value.length,
      };
      selectionBeforeRef.current = snap;
      onSyncSelection?.(snap);
    }
  }, [onSyncSelection]);

  const patchNote = useCallback(
    (partial: Partial<Note>, meta?: NoteEditMeta) => {
      const current = noteRef.current;
      const selectionBefore =
        meta?.selectionBefore !== undefined ? meta.selectionBefore : selectionBeforeRef.current;
      const selectionAfter =
        meta?.selectionAfter !== undefined ? meta.selectionAfter : captureCurrentEditorSelection();
      onUpdateNote(
        {
          ...current,
          ...partial,
          updatedAt: new Date().toISOString(),
        },
        {
          ...meta,
          selectionBefore,
          selectionAfter,
        }
      );
      selectionBeforeRef.current = selectionAfter;
    },
    [captureCurrentEditorSelection, onUpdateNote]
  );

  const syncEmptyAttr = useCallback(() => {
    const el = docRef.current;
    if (!el) return;
    const hasImage = Boolean(el.querySelector('figure.doc-image-block, img'));
    const singleChild = el.children.length <= 1 ? (el.firstElementChild as HTMLElement | null) : null;
    const isPlainEmpty =
      !hasImage &&
      !el.textContent?.trim() &&
      (!singleChild ||
        (singleChild.tagName === 'P' &&
          !singleChild.classList.contains('doc-task') &&
          !singleChild.classList.contains('doc-decision')));
    el.setAttribute('data-empty', isPlainEmpty ? 'true' : 'false');
  }, []);

  // Hydrate contentEditable DOM ONLY when switching notes, leaving rawMode, or when note.body changed externally
  useEffect(() => {
    if (rawMode) return;
    const el = docRef.current;
    if (!el) return;

    const noteChanged = lastSyncedNoteIdRef.current !== note.id;
    const externalBodyChanged = note.body !== lastEmittedMarkdownRef.current;

    if (noteChanged || externalBodyChanged || el.innerHTML === '') {
      el.innerHTML = markdownToHtml(note.body, directory.people);
      lastSyncedNoteIdRef.current = note.id;
      lastEmittedMarkdownRef.current = note.body;
      syncEmptyAttr();
    }
  }, [note.id, note.body, rawMode, directory.people, syncEmptyAttr]);

  const emitMarkdownFromDom = useCallback(
    (meta?: NoteEditMeta) => {
      const el = docRef.current;
      if (!el) return;
      const rawTrimmed = el.innerHTML.trim();
      if (rawTrimmed === '' || /^<br\s*\/?>$/i.test(rawTrimmed)) {
        el.innerHTML = '<p><br></p>';
        placeCaretAtStart(el.firstElementChild as HTMLElement);
      } else if (el.childNodes.length === 1 && el.firstChild?.nodeType === Node.TEXT_NODE) {
        const txtNode = el.firstChild as Text;
        const sel = window.getSelection();
        const savedOffset = sel && sel.anchorNode === txtNode ? sel.anchorOffset : txtNode.length;
        const p = document.createElement('p');
        el.replaceChild(p, txtNode);
        p.appendChild(txtNode);
        if (sel) {
          const r = document.createRange();
          r.setStart(txtNode, savedOffset);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      }
      syncEmptyAttr();
      const md = domToMarkdown(el);
      if (md !== lastEmittedMarkdownRef.current) {
        lastEmittedMarkdownRef.current = md;
        patchNote({ body: md }, meta);
      }
    },
    [patchNote, syncEmptyAttr]
  );

  // Refresh active toolbar button state & token link chip when selection moves
  const refreshSelectionToolbarState = useCallback(() => {
    const root = docRef.current;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
      setActiveToken(null);
      return;
    }

    const blockEl = findEditableBlock(sel.anchorNode, root);
    let blockType: ActiveFormatState['block'] = 'p';
    if (blockEl) {
      const tag = blockEl.tagName.toUpperCase();
      if (blockEl.classList.contains('doc-task')) blockType = 'task';
      else if (blockEl.classList.contains('doc-decision')) blockType = 'decision';
      else if (tag === 'H1') blockType = 'h1';
      else if (tag === 'H2') blockType = 'h2';
      else if (tag === 'H3') blockType = 'h3';
      else if (tag === 'BLOCKQUOTE') blockType = 'blockquote';
      else if (tag === 'LI') {
        blockType = blockEl.parentElement?.tagName.toUpperCase() === 'OL' ? 'ol' : 'ul';
      }
    }

    let bold = false;
    let italic = false;
    let strike = false;
    try {
      bold = document.queryCommandState('bold');
      italic = document.queryCommandState('italic');
      strike = document.queryCommandState('strikeThrough');
    } catch {
      // Ignore queryCommandState exceptions in non-standard contexts
    }

    setActiveFormat({ block: blockType, bold, italic, strike });

    // Check if cursor rests inside an inline @person, #label, or [[note]] token
    let node: Node | null = sel.anchorNode;
    let foundToken: HTMLElement | null = null;
    while (node && node !== root) {
      if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).classList.contains('doc-token')) {
        foundToken = node as HTMLElement;
        break;
      }
      node = node.parentNode;
    }

    if (foundToken && sel.isCollapsed) {
      const rect = foundToken.getBoundingClientRect();
      const top = Math.min(window.innerHeight - 56, rect.bottom + 6);
      const left = Math.max(12, Math.min(window.innerWidth - 240, rect.left));
      if (foundToken.classList.contains('doc-person')) {
        const name = (foundToken.getAttribute('data-person') || foundToken.textContent || '').replace(/^@+/, '').trim();
        if (name) {
          setActiveToken({ kind: 'person', value: name, rect: { top, left } });
          return;
        }
      } else if (foundToken.classList.contains('doc-label')) {
        const lbl = normalizeLabel(foundToken.textContent || '');
        if (lbl) {
          setActiveToken({ kind: 'label', value: lbl, rect: { top, left } });
          return;
        }
      } else if (foundToken.classList.contains('doc-link')) {
        const title = (foundToken.textContent || '').trim();
        if (title) {
          setActiveToken({ kind: 'link', value: title, rect: { top, left } });
          return;
        }
      }
    }
    setActiveToken(null);
  }, []);

  // Restore logical caret/selection after Undo or Redo hydration
  useEffect(() => {
    if (
      !pendingSelectionRestore ||
      pendingSelectionRestore.noteId !== note.id ||
      pendingSelectionRestore.nonce === lastHandledRestoreNonceRef.current
    ) {
      return;
    }
    lastHandledRestoreNonceRef.current = pendingSelectionRestore.nonce;

    const snap = pendingSelectionRestore.selection;
    if (snap?.kind === 'title' && titleInputRef.current) {
      const input = titleInputRef.current;
      const maxLen = input.value.length;
      const start = Math.max(0, Math.min(maxLen, snap.start));
      const end = Math.max(start, Math.min(maxLen, snap.end));
      input.focus({ preventScroll: true });
      try {
        input.setSelectionRange(start, end);
      } catch {
        // Ignore selection range errors
      }
      const actual: EditorSelectionSnapshot = { kind: 'title', start, end };
      selectionBeforeRef.current = actual;
      onSyncSelection?.(actual);
    } else if (rawMode && rawTextareaRef.current) {
      const ta = rawTextareaRef.current;
      const maxLen = ta.value.length;
      const start = snap?.kind === 'raw' ? Math.max(0, Math.min(maxLen, snap.start)) : maxLen;
      const end = snap?.kind === 'raw' ? Math.max(start, Math.min(maxLen, snap.end)) : start;
      ta.focus({ preventScroll: true });
      try {
        ta.setSelectionRange(start, end);
      } catch {
        // Ignore selection range errors
      }
      const actual: EditorSelectionSnapshot = { kind: 'raw', start, end };
      selectionBeforeRef.current = actual;
      onSyncSelection?.(actual);
    } else if (!rawMode && docRef.current) {
      if (snap?.kind === 'doc') {
        restoreDocSelection(docRef.current, snap);
        const actual = captureDocSelection(docRef.current);
        selectionBeforeRef.current = actual;
        onSyncSelection?.(actual);
      } else {
        selectionBeforeRef.current = captureDocSelection(docRef.current);
      }
    }

    queueMicrotask(() => {
      setAutocomplete(null);
      setActiveToken(null);
      refreshSelectionToolbarState();
    });
  }, [
    note.id,
    note.body,
    note.title,
    onSyncSelection,
    pendingSelectionRestore,
    rawMode,
    refreshSelectionToolbarState,
  ]);

  useEffect(() => {
    const onSelectionChange = () => {
      if (!rawMode) {
        refreshSelectionToolbarState();
        if (!isComposingRef.current && !pendingInputMetaRef.current && docRef.current) {
          const snap = captureDocSelection(docRef.current);
          if (snap) {
            selectionBeforeRef.current = snap;
            onSyncSelection?.(snap);
          }
        }
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [onSyncSelection, rawMode, refreshSelectionToolbarState]);

  useEffect(() => {
    const el = docRef.current;
    if (rawMode || !el) return;

    const onNativeBeforeInput = (ev: InputEvent) => {
      const inputType = typeof ev.inputType === 'string' ? ev.inputType : '';
      if (inputType === 'historyUndo') {
        ev.preventDefault();
        pendingInputMetaRef.current = null;
        onUndo?.();
        return;
      }
      if (inputType === 'historyRedo') {
        ev.preventDefault();
        pendingInputMetaRef.current = null;
        onRedo?.();
        return;
      }

      const snap = captureDocSelection(el);
      if (snap) {
        selectionBeforeRef.current = snap;
        onSyncSelection?.(snap);
      }

      if (inputType === 'insertText' || inputType === 'insertCompositionText') {
        pendingInputMetaRef.current = {
          label: 'Typing',
          coalesceKey: 'doc-type',
          wordBoundary: Boolean(ev.data && /\s/.test(ev.data)),
        };
      } else if (inputType === 'deleteByCut') {
        pendingInputMetaRef.current = { label: 'Cut', coalesceKey: null };
      } else if (inputType.startsWith('delete')) {
        pendingInputMetaRef.current = {
          label: 'Delete text',
          coalesceKey:
            inputType === 'deleteContentBackward' || inputType === 'deleteContentForward'
              ? 'doc-delete'
              : null,
        };
      } else if (inputType.startsWith('format')) {
        pendingInputMetaRef.current = { label: 'Formatting', coalesceKey: null };
      } else if (inputType === 'insertParagraph' || inputType === 'insertLineBreak') {
        pendingInputMetaRef.current = { label: 'New paragraph', coalesceKey: null };
      } else if (inputType) {
        pendingInputMetaRef.current = { label: 'Edit note', coalesceKey: null };
      }
    };

    el.addEventListener('beforeinput', onNativeBeforeInput);
    return () => el.removeEventListener('beforeinput', onNativeBeforeInput);
  }, [onRedo, onSyncSelection, onUndo, rawMode]);

  const handleScopeOrClientChange = (val: string) => {
    if (val === '__new_client__') {
      setNewClientPrompt(true);
      return;
    }
    if (val === 'inbox') {
      patchNote({ scope: 'inbox', clientId: null, projectId: null }, { label: 'Change space', coalesceKey: null });
    } else if (val === 'internal') {
      patchNote({ scope: 'internal', clientId: null, projectId: null }, { label: 'Change space', coalesceKey: null });
    } else if (val.startsWith('client:')) {
      const cId = val.slice('client:'.length);
      const validProj = directory.projects.some((p) => p.id === note.projectId && p.clientId === cId);
      patchNote(
        {
          scope: 'client',
          clientId: cId,
          projectId: validProj ? note.projectId : null,
        },
        { label: 'Change space', coalesceKey: null }
      );
    }
  };

  const handleAddParticipant = (rawName: string) => {
    const trimmed = rawName.trim().replace(/^@+/, '');
    if (!trimmed) return;
    const person = onEnsurePerson(trimmed, note.clientId);
    const nextParticipants = note.participants.includes(person.name)
      ? note.participants
      : [...note.participants, person.name];

    const inferredPatch: Partial<Note> = { participants: nextParticipants };
    if (note.scope === 'inbox' && !note.clientId && person.clientId) {
      inferredPatch.scope = 'client';
      inferredPatch.clientId = person.clientId;
    }
    patchNote(inferredPatch, { label: 'Add participant', coalesceKey: null });
    setParticipantInput('');
  };

  const handleAddHeaderLabel = (rawLbl: string) => {
    const norm = normalizeLabel(rawLbl);
    if (!norm) return;
    if (!note.labels.includes(norm)) {
      patchNote({ labels: [...note.labels, norm] }, { label: 'Add label', coalesceKey: null });
    }
    setLabelInput('');
  };

  const handleApplyInvite = () => {
    const parsed = parseMeetingInviteText(inviteRawText, directory);
    for (const np of parsed.newPeople) {
      onEnsurePerson(np.name, np.clientId, np.email);
    }
    const mergedParticipants = Array.from(new Set([...note.participants, ...parsed.participants]));
    const nextClientId = note.clientId || parsed.inferredClientId;
    const nextScope: NoteScope = nextClientId ? 'client' : note.scope;

    patchNote(
      {
        title: parsed.title || note.title,
        date: parsed.date || note.date,
        participants: mergedParticipants,
        clientId: nextClientId,
        scope: nextScope,
      },
      { label: 'Import meeting invite', coalesceKey: null }
    );
    setInviteRawText('');
    setShowInviteModal(false);
  };

  const handleApplyTemplate = (templateId: string) => {
    const tpl = NOTE_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    const nextBody = note.body.trim() ? `${note.body.trim()}\n\n${tpl.body}` : tpl.body;
    const nextTitle = !note.title.trim() && tpl.titlePrefix ? tpl.titlePrefix : note.title;
    lastEmittedMarkdownRef.current = '__FORCE_SYNC__';
    patchNote({ title: nextTitle, body: nextBody }, { label: `Insert ${tpl.label}`, coalesceKey: null });
    setShowInsertMenu(false);
  };

  const linkNaturalPersonEverywhere = (person: Person) => {
    const esc = person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const updatedBody = note.body.replace(
      new RegExp(`(?<!@\\[?)\\b${esc}\\b`, 'g'),
      formatPersonMention(person.name)
    );
    lastEmittedMarkdownRef.current = '__FORCE_SYNC__';
    patchNote({ body: updatedBody }, { label: `Link @${person.name}`, coalesceKey: null });
  };

  const captureCurrentDocRange = useCallback((): Range | null => {
    const root = docRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    return root.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
  }, []);

  const insertImageBlocksAtRange = useCallback(
    (figures: HTMLElement[], explicitRange?: Range | null) => {
      const root = docRef.current;
      if (!root || figures.length === 0) return;

      recordPreEditSelection();

      const frag = document.createDocumentFragment();
      figures.forEach((fig) => frag.appendChild(fig));
      const lastFigure = figures[figures.length - 1];

      const ensureTrailingParagraph = (afterEl: HTMLElement): HTMLElement => {
        const next = afterEl.nextElementSibling as HTMLElement | null;
        if (
          next &&
          !next.classList.contains('doc-image-block') &&
          next.tagName.toUpperCase() !== 'HR'
        ) {
          if (next.tagName.toUpperCase() === 'UL' || next.tagName.toUpperCase() === 'OL') {
            const firstLi = next.querySelector('li') as HTMLElement | null;
            if (firstLi) return firstLi;
          } else {
            return next;
          }
        }
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        afterEl.after(p);
        return p;
      };

      let activeRange: Range | null = null;
      if (explicitRange && root.contains(explicitRange.commonAncestorContainer)) {
        activeRange = explicitRange.cloneRange();
      } else {
        activeRange = captureCurrentDocRange();
      }

      if (!activeRange) {
        const onlyChild =
          root.children.length === 1 ? (root.firstElementChild as HTMLElement | null) : null;
        const isOnlyEmptyPara =
          onlyChild &&
          onlyChild.tagName.toUpperCase() === 'P' &&
          !onlyChild.classList.contains('doc-task') &&
          !onlyChild.classList.contains('doc-decision') &&
          !onlyChild.querySelector('img') &&
          !(onlyChild.textContent || '').trim();

        if (isOnlyEmptyPara && onlyChild) {
          root.insertBefore(frag, onlyChild);
          root.focus();
          placeCaretAtStart(onlyChild);
        } else {
          root.appendChild(frag);
          const p = ensureTrailingParagraph(lastFigure);
          root.focus();
          placeCaretAtStart(p);
        }
        emitMarkdownFromDom({ label: 'Insert image', coalesceKey: null });
        refreshSelectionToolbarState();
        return;
      }

      if (!activeRange.collapsed) {
        activeRange.deleteContents();
      }

      let blk = findEditableBlock(activeRange.startContainer, root);

      // If inside an <li>, unwrap/split the list at a temporary paragraph first so <figure> stays top-level
      if (
        blk &&
        blk.tagName.toUpperCase() === 'LI' &&
        blk.parentElement &&
        (blk.parentElement.tagName.toUpperCase() === 'UL' ||
          blk.parentElement.tagName.toUpperCase() === 'OL')
      ) {
        const isEmptyLi = !(blk.textContent || '').trim() && !blk.querySelector('img');
        if (isEmptyLi) {
          const tempP = document.createElement('p');
          tempP.innerHTML = '<br>';
          blk = replaceBlockElement(blk, tempP);
        } else {
          const listEl = blk.parentElement;
          const afterItems: Element[] = [];
          let passedCurrent = false;
          Array.from(listEl.children).forEach((child) => {
            if (child === blk) {
              passedCurrent = true;
            } else if (passedCurrent) {
              afterItems.push(child);
            }
          });
          listEl.after(frag);
          if (afterItems.length > 0) {
            const afterList = document.createElement(listEl.tagName.toLowerCase());
            afterItems.forEach((li) => afterList.appendChild(li));
            lastFigure.after(afterList);
            const firstAfterLi = afterList.firstElementChild as HTMLElement | null;
            root.focus();
            if (firstAfterLi) placeCaretAtStart(firstAfterLi);
          } else {
            const p = ensureTrailingParagraph(lastFigure);
            root.focus();
            placeCaretAtStart(p);
          }
          emitMarkdownFromDom({ label: 'Insert image', coalesceKey: null });
          refreshSelectionToolbarState();
          return;
        }
      }

      if (!blk) {
        if (activeRange.startContainer === root) {
          const refNode = root.childNodes[activeRange.startOffset] || null;
          root.insertBefore(frag, refNode);
        } else {
          let topChild: Node | null = activeRange.startContainer;
          while (topChild && topChild.parentNode !== root) {
            topChild = topChild.parentNode;
          }
          if (topChild && topChild.parentNode === root) {
            (topChild as Element).after(frag);
          } else {
            root.appendChild(frag);
          }
        }
        const targetCaretEl = ensureTrailingParagraph(lastFigure);
        root.focus();
        placeCaretAtStart(targetCaretEl);
        emitMarkdownFromDom({ label: 'Insert image', coalesceKey: null });
        refreshSelectionToolbarState();
        return;
      }

      const isPlainEmptyBlock =
        (blk.tagName.toUpperCase() === 'P' || blk.tagName.toUpperCase() === 'DIV') &&
        !blk.classList.contains('doc-task') &&
        !blk.classList.contains('doc-decision') &&
        !blk.querySelector('img') &&
        !(blk.textContent || '').trim();

      if (isPlainEmptyBlock || isCaretAtStartOfBlock(blk, activeRange)) {
        blk.before(frag);
        root.focus();
        placeCaretAtStart(blk);
      } else if (isCaretAtEndOfBlock(blk, activeRange)) {
        blk.after(frag);
        const targetCaretEl = ensureTrailingParagraph(lastFigure);
        root.focus();
        placeCaretAtStart(targetCaretEl);
      } else {
        const tailRange = document.createRange();
        tailRange.selectNodeContents(blk);
        tailRange.setStart(activeRange.startContainer, activeRange.startOffset);
        const tailFrag = tailRange.extractContents();
        if (!blk.innerHTML.trim()) {
          blk.innerHTML = '<br>';
        }
        const nextBlock = document.createElement('p');
        if (blk.classList.contains('doc-task')) {
          nextBlock.className = 'doc-task';
          nextBlock.setAttribute('data-status', 'todo');
        }
        nextBlock.appendChild(tailFrag);
        if (!nextBlock.innerHTML.trim()) {
          nextBlock.innerHTML = '<br>';
        }
        blk.after(frag, nextBlock);
        root.focus();
        placeCaretAtStart(nextBlock);
      }

      emitMarkdownFromDom({ label: 'Insert image', coalesceKey: null });
      refreshSelectionToolbarState();
    },
    [captureCurrentDocRange, emitMarkdownFromDom, recordPreEditSelection, refreshSelectionToolbarState]
  );

  const insertImageFiles = useCallback(
    async (files: File[], explicitRange?: Range | null) => {
      if (files.length === 0) return;
      const uploaded = await Promise.all(
        files.map(async (file) => {
          const { assetPath } = await saveBlobAsImageAsset(file);
          const alt = cleanImageLabelFromFile(file);
          return { assetPath, alt };
        })
      );

      if (rawMode) {
        syncRawSelectionBefore();
        const mdSnippet = uploaded.map((u) => `![${u.alt}](${u.assetPath})`).join('\n\n');
        const ta = rawTextareaRef.current;
        const currentBody = noteRef.current.body;
        if (ta) {
          const start = ta.selectionStart ?? currentBody.length;
          const end = ta.selectionEnd ?? start;
          const before = currentBody.slice(0, start);
          const after = currentBody.slice(end);
          const prefix = before.length > 0 && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
          const suffix = after.length > 0 && !after.startsWith('\n') ? '\n\n' : '\n';
          const updated = `${before}${prefix}${mdSnippet}${suffix}${after}`;
          lastEmittedMarkdownRef.current = '__FORCE_SYNC__';
          patchNote({ body: updated }, { label: 'Insert image', coalesceKey: null });
        } else {
          const updated = currentBody.trim() ? `${currentBody.trim()}\n\n${mdSnippet}\n` : `${mdSnippet}\n`;
          lastEmittedMarkdownRef.current = '__FORCE_SYNC__';
          patchNote({ body: updated }, { label: 'Insert image', coalesceKey: null });
        }
        return;
      }

      const figures = uploaded.map((u) =>
        createImageBlockElement({
          src: u.assetPath,
          alt: u.alt,
        })
      );
      insertImageBlocksAtRange(figures, explicitRange);
    },
    [insertImageBlocksAtRange, patchNote, rawMode, syncRawSelectionBefore]
  );

  const handleTriggerImageUpload = () => {
    savedInsertRangeRef.current = captureCurrentDocRange();
    setShowInsertMenu(false);
    imageInputRef.current?.click();
  };

  const openLightboxForElement = useCallback((targetEl: HTMLElement) => {
    const root = docRef.current;
    if (!root) return;

    const allImgs = Array.from(root.querySelectorAll('img')) as HTMLImageElement[];
    if (allImgs.length === 0) return;

    const targetImg =
      targetEl.tagName.toUpperCase() === 'IMG'
        ? (targetEl as HTMLImageElement)
        : (targetEl.querySelector('img') as HTMLImageElement | null);

    let activeIdx = 0;
    const items: LightboxImageItem[] = [];

    allImgs.forEach((imgEl) => {
      const fig = imgEl.closest('figure.doc-image-block') as HTMLElement | null;
      const rawSrc =
        fig?.getAttribute('data-src') ||
        imgEl.getAttribute('data-src') ||
        imgEl.getAttribute('src') ||
        '';
      const resolvedSrc = resolveImageSrc(rawSrc) || imgEl.currentSrc || imgEl.src;
      if (!resolvedSrc) return;
      const alt =
        fig?.getAttribute('data-alt') || imgEl.getAttribute('alt') || 'Pasted image';
      if (targetImg && imgEl === targetImg) {
        activeIdx = items.length;
      }
      items.push({ src: resolvedSrc, alt });
    });

    if (items.length > 0) {
      setLightbox({ images: items, index: activeIdx });
    }
  }, []);

  // Detect @, #, [[, or / autocomplete triggers at exact caret location in contentEditable or raw textarea
  const detectDocAutocomplete = useCallback(() => {
    const root = docRef.current;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
      setAutocomplete(null);
      return;
    }

    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE) {
      setAutocomplete(null);
      return;
    }

    // Do not re-trigger autocomplete inside an already-created token span
    const parentEl = range.startContainer.parentElement;
    if (parentEl && parentEl.classList.contains('doc-token')) {
      setAutocomplete(null);
      return;
    }

    const textNode = range.startContainer as Text;
    const cursorPos = range.startOffset;
    const uptoCursor = (textNode.nodeValue || '').slice(0, cursorPos).replace(/\u00A0/g, ' ');

    const rawRect = range.getBoundingClientRect();
    const fallbackRect = parentEl ? parentEl.getBoundingClientRect() : root.getBoundingClientRect();
    const anchorTop = rawRect.top > 0 ? rawRect.bottom : fallbackRect.bottom;
    const anchorLeft = rawRect.left > 0 ? rawRect.left : fallbackRect.left;
    const popRect = {
      top: Math.min(window.innerHeight - 250, anchorTop + 6),
      left: Math.max(12, Math.min(window.innerWidth - 300, anchorLeft)),
    };

    const linkMatch = uptoCursor.match(/\[\[([^\]]{0,35})$/);
    if (linkMatch) {
      setAutocomplete({
        kind: 'link',
        query: linkMatch[1],
        tokenStart: cursorPos - linkMatch[0].length,
        cursorPos,
        textNode,
        rect: popRect,
      });
      setAcIndex(0);
      return;
    }

    const personMatch = uptoCursor.match(/(?:^|[\s(])@([\p{L}\p{N}._-]{0,28}(?:\s[\p{L}\p{N}._-]{0,28})?)$/u);
    if (personMatch) {
      const rawQuery = personMatch[1];
      const qLower = rawQuery.toLowerCase();
      const validAcrossSpace =
        !/\s/.test(rawQuery) ||
        peopleRef.current.some((p) => p.name.toLowerCase().startsWith(qLower));
      if (validAcrossSpace) {
        const atIdx = uptoCursor.lastIndexOf('@');
        const hasDirectoryMatch = peopleRef.current.some(
          (p) => !qLower.trim() || p.name.toLowerCase().includes(qLower.trim()) || (p.role || '').toLowerCase().includes(qLower.trim())
        );
        setAutocomplete({
          kind: 'person',
          query: rawQuery,
          tokenStart: atIdx,
          cursorPos,
          textNode,
          rect: popRect,
        });
        setAcIndex(hasDirectoryMatch ? 0 : -1);
        return;
      }
    }

    const labelMatch = uptoCursor.match(/(?:^|[\s(])#([\p{L}\p{N}_-]{0,28})$/u);
    if (labelMatch) {
      const hashIdx = uptoCursor.lastIndexOf('#');
      const qLower = labelMatch[1].toLowerCase();
      const hasLabelMatch = labelsRef.current.some((l) => !qLower || l.includes(qLower));
      setAutocomplete({
        kind: 'label',
        query: labelMatch[1],
        tokenStart: hashIdx,
        cursorPos,
        textNode,
        rect: popRect,
      });
      setAcIndex(hasLabelMatch ? 0 : -1);
      return;
    }

    const slashMatch = uptoCursor.match(/(?:^|\s)\/([a-z0-9-]{0,16})$/i);
    if (slashMatch) {
      const slashIdx = uptoCursor.lastIndexOf('/');
      setAutocomplete({
        kind: 'slash',
        query: slashMatch[1].toLowerCase(),
        tokenStart: slashIdx,
        cursorPos,
        textNode,
        rect: popRect,
      });
      setAcIndex(0);
      return;
    }

    setAutocomplete(null);
  }, []);

  const detectRawAutocomplete = (value: string, cursorPos: number, el: HTMLTextAreaElement) => {
    const uptoCursor = value.slice(0, cursorPos);
    const rect = el.getBoundingClientRect();
    const popRect = {
      top: Math.min(window.innerHeight - 250, rect.top + 48),
      left: Math.max(12, Math.min(window.innerWidth - 300, rect.left + 16)),
    };

    const linkMatch = uptoCursor.match(/\[\[([^\]]{0,35})$/);
    if (linkMatch) {
      setAutocomplete({
        kind: 'link',
        query: linkMatch[1],
        tokenStart: cursorPos - linkMatch[0].length,
        cursorPos,
        textNode: null,
        rect: popRect,
      });
      setAcIndex(0);
      return;
    }

    const personMatch = uptoCursor.match(/(?:^|[\s(])@([\p{L}\p{N}._-]{0,28}(?:\s[\p{L}\p{N}._-]{0,28})?)$/u);
    if (personMatch) {
      const rawQuery = personMatch[1];
      const qLower = rawQuery.toLowerCase();
      const validAcrossSpace =
        !/\s/.test(rawQuery) ||
        peopleRef.current.some((p) => p.name.toLowerCase().startsWith(qLower));
      if (validAcrossSpace) {
        const hasDirectoryMatch = peopleRef.current.some(
          (p) => !qLower.trim() || p.name.toLowerCase().includes(qLower.trim()) || (p.role || '').toLowerCase().includes(qLower.trim())
        );
        setAutocomplete({
          kind: 'person',
          query: rawQuery,
          tokenStart: uptoCursor.lastIndexOf('@'),
          cursorPos,
          textNode: null,
          rect: popRect,
        });
        setAcIndex(hasDirectoryMatch ? 0 : -1);
        return;
      }
    }

    const labelMatch = uptoCursor.match(/(?:^|[\s(])#([\p{L}\p{N}_-]{0,28})$/u);
    if (labelMatch) {
      const qLower = labelMatch[1].toLowerCase();
      const hasLabelMatch = labelsRef.current.some((l) => !qLower || l.includes(qLower));
      setAutocomplete({
        kind: 'label',
        query: labelMatch[1],
        tokenStart: uptoCursor.lastIndexOf('#'),
        cursorPos,
        textNode: null,
        rect: popRect,
      });
      setAcIndex(hasLabelMatch ? 0 : -1);
      return;
    }

    setAutocomplete(null);
  };

  const autocompleteItems = useMemo(() => {
    if (!autocomplete) return [];
    const q = autocomplete.query.trim().toLowerCase();

    if (autocomplete.kind === 'person') {
      const matches = directory.people
        .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.role || '').toLowerCase().includes(q))
        .slice(0, 6)
        .map((p) => {
          const clientName = p.clientId ? directory.clients.find((c) => c.id === p.clientId)?.name : 'Internal';
          return {
            id: p.id,
            label: `@${p.name}`,
            sub: [p.role, clientName].filter(Boolean).join(' · '),
            replacement: `${formatPersonMention(p.name)} `,
            tokenValue: p.name,
            createPersonName: null as string | null,
          };
        });
      if (q.length >= 2 && !/\s/.test(autocomplete.query) && !directory.people.some((p) => p.name.toLowerCase() === q)) {
        const displayNew = autocomplete.query.trim();
        matches.push({
          id: '__create_person__',
          label: `+ Add "${displayNew}" to People`,
          sub: 'Tab or click · Space to keep typing',
          replacement: `${formatPersonMention(displayNew)} `,
          tokenValue: displayNew,
          createPersonName: displayNew,
        });
      }
      return matches;
    }

    if (autocomplete.kind === 'label') {
      const matches = allWorkspaceLabels
        .filter((l) => !q || l.includes(q))
        .slice(0, 7)
        .map((l) => ({
          id: l,
          label: `#${l}`,
          sub: 'Topic / Label',
          replacement: `#${l} `,
          tokenValue: l,
          createPersonName: null as string | null,
        }));
      const normQ = normalizeLabel(q);
      if (normQ && !allWorkspaceLabels.includes(normQ)) {
        matches.push({
          id: '__create_label__',
          label: `+ Create #${normQ}`,
          sub: 'Tab or click · Space to keep typing',
          replacement: `#${normQ} `,
          tokenValue: normQ,
          createPersonName: null,
        });
      }
      return matches;
    }

    if (autocomplete.kind === 'link') {
      return allNotes
        .filter((n) => n.id !== note.id && (!q || n.title.toLowerCase().includes(q)))
        .slice(0, 7)
        .map((n) => ({
          id: n.id,
          label: n.title || 'Untitled',
          sub: n.date,
          replacement: `[[${n.title}]] `,
          tokenValue: n.title || 'Untitled',
          createPersonName: null as string | null,
        }));
    }

    if (autocomplete.kind === 'slash') {
      const dueStr = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const commands = [
        { id: 'image', label: '/image — Upload or insert image', sub: 'Resizable image', replacement: '__INSERT_IMAGE__', tokenValue: '' },
        { id: 'task', label: '/task — Action item checkbox', sub: 'Checklist task', replacement: '__BLOCK_TASK__', tokenValue: '' },
        { id: 'decision', label: '/decision — Agreed decision', sub: 'Decision record', replacement: '__BLOCK_DECISION__', tokenValue: '' },
        { id: 'proposed', label: '/proposed — Proposed decision', sub: 'Proposed status', replacement: '__BLOCK_PROPOSED__', tokenValue: '' },
        { id: 'h1', label: '/h1 — Large section heading', sub: 'Heading 1', replacement: '__BLOCK_H1__', tokenValue: '' },
        { id: 'h2', label: '/h2 — Section heading', sub: 'Heading 2', replacement: '__BLOCK_H2__', tokenValue: '' },
        { id: 'bullet', label: '/bullet — Bullet list', sub: 'Unordered list', replacement: '__BLOCK_UL__', tokenValue: '' },
        { id: 'quote', label: '/quote — Callout / Rationale quote', sub: 'Blockquote', replacement: '__BLOCK_QUOTE__', tokenValue: '' },
        { id: 'due', label: '/due — Insert due date (+3d)', sub: `due:${dueStr}`, replacement: `due:${dueStr} `, tokenValue: `due:${dueStr}` },
        { id: 'ask', label: '/ask — Query past notes context', sub: 'Open Context Ask', replacement: '__OPEN_ASK__', tokenValue: '' },
      ];
      return commands
        .filter((c) => !q || c.id.includes(q) || c.label.toLowerCase().includes(q))
        .map((c) => ({ ...c, createPersonName: null as string | null }));
    }

    return [];
  }, [autocomplete, directory.people, directory.clients, allWorkspaceLabels, allNotes, note.id]);

  // Toolbar & Slash block conversion on continuous document page
  const applyBlockStyle = useCallback(
    (targetStyle: 'p' | 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'blockquote' | 'task' | 'decision' | 'proposed') => {
      const root = docRef.current;
      if (!root) return;
      root.focus();
      recordPreEditSelection();

      if (targetStyle === 'ul' || targetStyle === 'ol') {
        // Clear custom task/decision classes first so native list toggle works cleanly
        getSelectedEditableBlocks(root).forEach((blk) => {
          blk.classList.remove('doc-task', 'doc-decision', 'doc-rationale');
          blk.removeAttribute('data-status');
        });
        document.execCommand(targetStyle === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
        emitMarkdownFromDom({
          label: targetStyle === 'ul' ? 'Bullet list' : 'Numbered list',
          coalesceKey: null,
        });
        refreshSelectionToolbarState();
        return;
      }

      let blocks = getSelectedEditableBlocks(root);
      if (blocks.length === 0) {
        const first = (root.firstElementChild as HTMLElement) || document.createElement('p');
        if (!first.parentElement) {
          first.innerHTML = '<br>';
          root.appendChild(first);
        }
        blocks = [first];
      }

      const allAlreadySame = blocks.every((b) => {
        if (targetStyle === 'task') return b.classList.contains('doc-task');
        if (targetStyle === 'decision' || targetStyle === 'proposed') return b.classList.contains('doc-decision');
        if (targetStyle === 'blockquote') return b.tagName.toUpperCase() === 'BLOCKQUOTE';
        return (
          b.tagName.toUpperCase() === targetStyle.toUpperCase() &&
          !b.classList.contains('doc-task') &&
          !b.classList.contains('doc-decision')
        );
      });

      let lastCreated: HTMLElement | null = null;

      blocks.forEach((blk) => {
        const inner = blk.innerHTML || '<br>';
        let nextEl: HTMLElement;

        if (allAlreadySame && targetStyle !== 'p') {
          nextEl = document.createElement('p');
        } else if (targetStyle === 'task') {
          nextEl = document.createElement('p');
          nextEl.className = 'doc-task';
          nextEl.setAttribute('data-status', 'todo');
        } else if (targetStyle === 'decision' || targetStyle === 'proposed') {
          nextEl = document.createElement('p');
          nextEl.className = 'doc-decision';
          nextEl.setAttribute('data-status', targetStyle === 'proposed' ? 'proposed' : 'agreed');
        } else if (targetStyle === 'blockquote') {
          nextEl = document.createElement('blockquote');
          if (blk.previousElementSibling?.classList.contains('doc-decision')) {
            nextEl.className = 'doc-rationale';
          }
        } else {
          nextEl = document.createElement(targetStyle);
        }

        nextEl.innerHTML = inner;
        lastCreated = replaceBlockElement(blk, nextEl);
      });

      if (lastCreated) {
        placeCaretAtEnd(lastCreated);
      }
      emitMarkdownFromDom({ label: 'Format block', coalesceKey: null });
      refreshSelectionToolbarState();
    },
    [emitMarkdownFromDom, recordPreEditSelection, refreshSelectionToolbarState]
  );

  const applyInlineCommand = (cmd: 'bold' | 'italic' | 'strikeThrough') => {
    const root = docRef.current;
    if (!root) return;
    root.focus();
    recordPreEditSelection();
    document.execCommand(cmd);
    const label = cmd === 'bold' ? 'Bold' : cmd === 'italic' ? 'Italic' : 'Strikethrough';
    emitMarkdownFromDom({ label, coalesceKey: null });
    refreshSelectionToolbarState();
  };

  const applyAutocompleteItem = (item: (typeof autocompleteItems)[number]) => {
    if (!autocomplete) return;
    recordPreEditSelection();
    if (item.replacement === '__OPEN_ASK__') {
      if (autocomplete.textNode) {
        const r = document.createRange();
        r.setStart(autocomplete.textNode, autocomplete.tokenStart);
        r.setEnd(autocomplete.textNode, autocomplete.cursorPos);
        r.deleteContents();
        emitMarkdownFromDom({ label: 'Slash command', coalesceKey: null });
      }
      setAutocomplete(null);
      onOpenQuickAsk();
      return;
    }

    if (item.replacement === '__INSERT_IMAGE__') {
      if (autocomplete.textNode && docRef.current?.contains(autocomplete.textNode)) {
        const r = document.createRange();
        r.setStart(autocomplete.textNode, autocomplete.tokenStart);
        r.setEnd(autocomplete.textNode, autocomplete.cursorPos);
        r.deleteContents();
        const blk = findEditableBlock(r.startContainer, docRef.current);
        if (blk && !blk.textContent?.trim()) {
          blk.innerHTML = '<br>';
          r.setStart(blk, 0);
          r.collapse(true);
        }
        savedInsertRangeRef.current = r.cloneRange();
        emitMarkdownFromDom({ label: 'Slash command', coalesceKey: null });
      }
      setAutocomplete(null);
      imageInputRef.current?.click();
      return;
    }

    if (item.createPersonName) {
      onEnsurePerson(item.createPersonName, note.clientId);
    }

    const tokenLabel =
      autocomplete.kind === 'person'
        ? 'Insert @person'
        : autocomplete.kind === 'label'
        ? 'Insert #label'
        : autocomplete.kind === 'link'
        ? 'Insert [[note]] link'
        : 'Slash command';

    if (rawMode && rawTextareaRef.current) {
      syncRawSelectionBefore();
      const full = note.body;
      const updated =
        full.slice(0, autocomplete.tokenStart) + item.replacement + full.slice(autocomplete.cursorPos);
      lastEmittedMarkdownRef.current = '__FORCE_SYNC__';
      patchNote({ body: updated }, { label: tokenLabel, coalesceKey: null });
      setAutocomplete(null);
      return;
    }

    const root = docRef.current;
    if (!root || !autocomplete.textNode || !root.contains(autocomplete.textNode)) {
      setAutocomplete(null);
      return;
    }

    const delRange = document.createRange();
    delRange.setStart(autocomplete.textNode, autocomplete.tokenStart);
    delRange.setEnd(autocomplete.textNode, autocomplete.cursorPos);
    delRange.deleteContents();

    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(delRange);
    }

    // Handle slash block conversions cleanly in-place
    if (item.replacement.startsWith('__BLOCK_')) {
      const blk = findEditableBlock(delRange.startContainer, root);
      if (blk && !blk.textContent?.trim()) {
        blk.innerHTML = '<br>';
      }
      setAutocomplete(null);
      if (item.replacement === '__BLOCK_TASK__') applyBlockStyle('task');
      else if (item.replacement === '__BLOCK_DECISION__') applyBlockStyle('decision');
      else if (item.replacement === '__BLOCK_PROPOSED__') applyBlockStyle('proposed');
      else if (item.replacement === '__BLOCK_H1__') applyBlockStyle('h1');
      else if (item.replacement === '__BLOCK_H2__') applyBlockStyle('h2');
      else if (item.replacement === '__BLOCK_UL__') applyBlockStyle('ul');
      else if (item.replacement === '__BLOCK_QUOTE__') applyBlockStyle('blockquote');
      return;
    }

    // Insert rich inline token span + trailing space outside the span
    const span = document.createElement('span');
    if (autocomplete.kind === 'person') {
      span.className = 'doc-token doc-person';
      span.setAttribute('data-person', item.tokenValue);
      span.setAttribute('data-mention-text', item.tokenValue);
      span.textContent = `@${item.tokenValue}`;
    } else if (autocomplete.kind === 'label') {
      span.className = 'doc-token doc-label';
      span.setAttribute('data-label', item.tokenValue);
      span.textContent = `#${item.tokenValue}`;
    } else if (autocomplete.kind === 'link') {
      span.className = 'doc-token doc-link';
      span.setAttribute('data-link', item.tokenValue);
      span.textContent = item.tokenValue;
    } else {
      span.className = 'doc-token doc-due';
      span.textContent = item.tokenValue;
    }

    const endNode = delRange.endContainer;
    const isAtLineEnd =
      endNode.nodeType === Node.TEXT_NODE
        ? delRange.endOffset >= (endNode.nodeValue || '').length &&
          (!endNode.nextSibling || endNode.nextSibling.nodeName === 'BR')
        : delRange.endOffset >= endNode.childNodes.length;
    const trailingSpace = document.createTextNode(isAtLineEnd ? '\u00A0' : ' ');
    delRange.insertNode(trailingSpace);
    delRange.insertNode(span);

    if (sel) {
      const afterRange = document.createRange();
      afterRange.setStart(trailingSpace, 1);
      afterRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(afterRange);
    }

    setAutocomplete(null);
    setActiveToken(null);
    emitMarkdownFromDom({ label: tokenLabel, coalesceKey: null });
  };

  // Auto-convert Markdown prefixes (# , ## , - , 1. , [] , [d] , > ) into live WYSIWYG blocks on Space
  const tryApplyAutoMarkdownPrefix = (): boolean => {
    const root = docRef.current;
    if (!root) return false;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;

    const blk = findEditableBlock(range.startContainer, root);
    if (!blk) return false;

    const probe = document.createRange();
    probe.selectNodeContents(blk);
    probe.setEnd(range.startContainer, range.startOffset);
    const prefix = probe.toString().replace(/\u00A0/g, ' ');

    const stripPrefixAndConvert = (createNewBlock: () => HTMLElement) => {
      probe.deleteContents();
      const next = createNewBlock();
      next.innerHTML = blk.innerHTML.trim() ? blk.innerHTML : '<br>';
      const mounted = replaceBlockElement(blk, next);
      placeCaretAtStart(mounted);
      emitMarkdownFromDom({ label: 'Format block', coalesceKey: null });
      refreshSelectionToolbarState();
      return true;
    };

    const tag = blk.tagName.toUpperCase();
    const isPlainParagraph =
      (tag === 'P' || tag === 'DIV') &&
      !blk.classList.contains('doc-task') &&
      !blk.classList.contains('doc-decision');

    // Inside a fresh <li> (e.g. user typed "- " which became <li>, then typed "[ ] " or "[D] ")
    if (tag === 'LI') {
      const liTaskMatch = prefix.match(/^\[([ /?xX])\]\s$/);
      if (liTaskMatch) {
        const ch = liTaskMatch[1].toLowerCase();
        const st: TaskStatus = ch === 'x' ? 'done' : ch === '/' ? 'doing' : ch === '?' ? 'waiting' : 'todo';
        return stripPrefixAndConvert(() => {
          const p = document.createElement('p');
          p.className = 'doc-task';
          p.setAttribute('data-status', st);
          return p;
        });
      }
      const liDecMatch = prefix.match(/^\[D(?::(agreed|proposed|superseded))?\]\s$/i);
      if (liDecMatch) {
        const st = (liDecMatch[1] || 'agreed').toLowerCase();
        return stripPrefixAndConvert(() => {
          const p = document.createElement('p');
          p.className = 'doc-decision';
          p.setAttribute('data-status', st);
          return p;
        });
      }
      return false;
    }

    if (!isPlainParagraph) return false;

    if (prefix === '# ') {
      return stripPrefixAndConvert(() => document.createElement('h1'));
    }
    if (prefix === '## ') {
      return stripPrefixAndConvert(() => document.createElement('h2'));
    }
    if (prefix === '### ') {
      return stripPrefixAndConvert(() => document.createElement('h3'));
    }
    if (prefix === '> ') {
      return stripPrefixAndConvert(() => {
        const bq = document.createElement('blockquote');
        if (blk.previousElementSibling?.classList.contains('doc-decision')) {
          bq.className = 'doc-rationale';
        }
        return bq;
      });
    }
    if (/^(?:[-*]\s*)?\[([ /?xX])?\]\s$/.test(prefix)) {
      const m = prefix.match(/\[([ /?xX])?\]/);
      const ch = (m?.[1] || ' ').toLowerCase();
      const st: TaskStatus = ch === 'x' ? 'done' : ch === '/' ? 'doing' : ch === '?' ? 'waiting' : 'todo';
      return stripPrefixAndConvert(() => {
        const p = document.createElement('p');
        p.className = 'doc-task';
        p.setAttribute('data-status', st);
        return p;
      });
    }
    if (/^(?:[-*]\s*)?\[D(?::(agreed|proposed|superseded))?\]\s$/i.test(prefix)) {
      const m = prefix.match(/\[D(?::(agreed|proposed|superseded))?\]/i);
      const st = (m?.[1] || 'agreed').toLowerCase();
      return stripPrefixAndConvert(() => {
        const p = document.createElement('p');
        p.className = 'doc-decision';
        p.setAttribute('data-status', st);
        return p;
      });
    }
    if (prefix === '- ' || prefix === '* ') {
      probe.deleteContents();
      const li = document.createElement('li');
      li.innerHTML = blk.innerHTML.trim() ? blk.innerHTML : '<br>';
      const prev = blk.previousElementSibling;
      if (prev && prev.tagName.toUpperCase() === 'UL') {
        prev.appendChild(li);
        blk.remove();
      } else {
        const ul = document.createElement('ul');
        ul.appendChild(li);
        blk.replaceWith(ul);
      }
      placeCaretAtStart(li);
      emitMarkdownFromDom({ label: 'Bullet list', coalesceKey: null });
      refreshSelectionToolbarState();
      return true;
    }
    if (prefix === '1. ') {
      probe.deleteContents();
      const li = document.createElement('li');
      li.innerHTML = blk.innerHTML.trim() ? blk.innerHTML : '<br>';
      const prev = blk.previousElementSibling;
      if (prev && prev.tagName.toUpperCase() === 'OL') {
        prev.appendChild(li);
        blk.remove();
      } else {
        const ol = document.createElement('ol');
        ol.appendChild(li);
        blk.replaceWith(ol);
      }
      placeCaretAtStart(li);
      emitMarkdownFromDom({ label: 'Numbered list', coalesceKey: null });
      refreshSelectionToolbarState();
      return true;
    }

    return false;
  };

  const createPersonTokenSpan = (rawName: string): HTMLElement => {
    const clean = rawName.trim();
    const exact = peopleRef.current.find((p) => p.name.toLowerCase() === clean.toLowerCase());
    const display = exact ? exact.name : clean;
    const resolved = resolveKnownPersonName(clean, peopleRef.current);
    const span = document.createElement('span');
    span.className = 'doc-token doc-person';
    span.setAttribute('data-person', resolved);
    span.setAttribute('data-mention-text', display);
    span.textContent = `@${display}`;
    return span;
  };

  const createLabelTokenSpan = (rawLbl: string): HTMLElement => {
    const norm = normalizeLabel(rawLbl);
    const span = document.createElement('span');
    span.className = 'doc-token doc-label';
    span.setAttribute('data-label', norm);
    span.textContent = `#${norm}`;
    return span;
  };

  const replaceSliceInTextNode = (
    textNode: Text,
    startOffset: number,
    endOffset: number,
    spanEl: HTMLElement,
    trailingOutsideText: string
  ) => {
    const rawVal = textNode.nodeValue || '';
    const beforeStr = rawVal.slice(0, startOffset);
    const restAfterEnd = rawVal.slice(endOffset);
    const isAtLineEnd = !restAfterEnd && (!textNode.nextSibling || textNode.nextSibling.nodeName === 'BR');
    const safeTrailing =
      isAtLineEnd && trailingOutsideText.endsWith(' ')
        ? `${trailingOutsideText.slice(0, -1)}\u00A0`
        : trailingOutsideText;

    textNode.nodeValue = beforeStr;
    const afterNode = document.createTextNode(safeTrailing + restAfterEnd);
    textNode.after(spanEl, afterNode);
    if (!beforeStr) {
      textNode.remove();
    }

    const sel = window.getSelection();
    if (sel) {
      const nextRange = document.createRange();
      nextRange.setStart(afterNode, safeTrailing.length);
      nextRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nextRange);
    }
  };

  // Ensure spaces, punctuation, or subsequent words (including via mobile IME/composition) never stay trapped inside .doc-token
  const normalizeInlineTokensInActiveBlock = () => {
    const root = docRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return;
    const blk = findEditableBlock(sel.anchorNode, root);
    if (!blk) return;

    const tokens = Array.from(blk.querySelectorAll('span.doc-token')) as HTMLElement[];
    for (const tokenEl of tokens) {
      const isPerson = tokenEl.classList.contains('doc-person');
      const isLabel = tokenEl.classList.contains('doc-label');
      if (!isPerson && !isLabel) continue;

      let caretOffsetInToken: number | null = null;
      if (sel.isCollapsed && tokenEl.contains(sel.anchorNode)) {
        const r = document.createRange();
        r.selectNodeContents(tokenEl);
        r.setEnd(sel.anchorNode!, sel.anchorOffset);
        caretOffsetInToken = r.toString().length;
      }

      const raw = (tokenEl.textContent || '').replace(/\u00A0/g, ' ');
      const sigil = isPerson ? '@' : '#';

      if (!raw.startsWith(sigil) || raw.length <= 1 || /^[@#]\s/.test(raw)) {
        const isAtEnd = !tokenEl.nextSibling || tokenEl.nextSibling.nodeName === 'BR';
        const safeRaw = isAtEnd && raw.endsWith(' ') ? `${raw.slice(0, -1)}\u00A0` : raw;
        const plain = document.createTextNode(safeRaw);
        tokenEl.replaceWith(plain);
        if (caretOffsetInToken !== null) {
          const r = document.createRange();
          r.setStart(plain, Math.min(plain.length, caretOffsetInToken));
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        }
        continue;
      }

      const body = raw.slice(1);
      let validLen = body.length;

      if (isPerson) {
        const expected = (tokenEl.getAttribute('data-mention-text') || tokenEl.getAttribute('data-person') || '').trim();
        if (expected.includes(' ')) {
          if (
            body.toLowerCase().startsWith(expected.toLowerCase()) &&
            (body.length === expected.length || /^[ \t\n,.;:!?)[\]]/.test(body.slice(expected.length)))
          ) {
            validLen = expected.length;
          } else if (expected.toLowerCase().startsWith(body.toLowerCase())) {
            validLen = body.length;
          } else {
            const bIdx = body.search(/[ \t\n,.;:!?)[\]]/);
            validLen = bIdx === -1 ? body.length : bIdx;
          }
        } else {
          const bIdx = body.search(/[ \t\n,.;:!?)[\]]/);
          validLen = bIdx === -1 ? body.length : bIdx;
        }
      } else {
        const bIdx = body.search(/[ \t\n,.;:!?)[\]]/);
        validLen = bIdx === -1 ? body.length : bIdx;
      }

      if (1 + validLen < raw.length) {
        const kept = body.slice(0, validLen);
        const overflowRaw = raw.slice(1 + validLen);
        const isAtEnd = !tokenEl.nextSibling || tokenEl.nextSibling.nodeName === 'BR';
        const safeOverflow =
          isAtEnd && overflowRaw.endsWith(' ')
            ? `${overflowRaw.slice(0, -1)}\u00A0`
            : overflowRaw;

        tokenEl.textContent = `${sigil}${kept}`;
        if (isPerson) {
          tokenEl.setAttribute('data-mention-text', kept);
          tokenEl.setAttribute('data-person', resolveKnownPersonName(kept, peopleRef.current));
        } else {
          tokenEl.setAttribute('data-label', normalizeLabel(kept));
        }

        const outNode = document.createTextNode(safeOverflow);
        tokenEl.after(outNode);

        if (caretOffsetInToken !== null) {
          const r = document.createRange();
          if (caretOffsetInToken <= 1 + validLen && tokenEl.firstChild) {
            r.setStart(tokenEl.firstChild, Math.min((tokenEl.firstChild.nodeValue || '').length, caretOffsetInToken));
          } else {
            r.setStart(outNode, Math.min(outNode.length, Math.max(0, caretOffsetInToken - (1 + validLen))));
          }
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      }
    }
  };

  // Automatically detect when a typed @mention, #label, @[Full Name], or [[Note]] is finished (on Space, punctuation, or closing bracket)
  const tryFinalizeInlineTriggerAtCaret = (): boolean => {
    const root = docRef.current;
    const sel = window.getSelection();
    if (!root || !sel || !sel.isCollapsed || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
      return false;
    }

    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;
    const parentEl = range.startContainer.parentElement;
    if (parentEl && (parentEl.classList.contains('doc-token') || parentEl.tagName.toUpperCase() === 'CODE')) {
      return false;
    }

    const textNode = range.startContainer as Text;
    const cursorPos = range.startOffset;
    const uptoCursor = (textNode.nodeValue || '').slice(0, cursorPos).replace(/\u00A0/g, ' ');
    const afterCursor = (textNode.nodeValue || '').slice(cursorPos);

    // 1. Bracketed person mention @[Full Name]
    const bracketPerson = uptoCursor.match(/(?:^|[\s(])(@\[([^\][\n]{1,50})\])$/);
    if (bracketPerson && bracketPerson[2].trim()) {
      const fullToken = bracketPerson[1];
      const startIdx = cursorPos - fullToken.length;
      const span = createPersonTokenSpan(bracketPerson[2].trim());
      replaceSliceInTextNode(textNode, startIdx, cursorPos, span, afterCursor.startsWith(' ') ? '' : ' ');
      return true;
    }

    // 2. Wiki note link [[Note Title]]
    const wikiLink = uptoCursor.match(/(\[\[([^\][\n]{1,80})\]\])$/);
    if (wikiLink && wikiLink[2].trim()) {
      const fullToken = wikiLink[1];
      const title = wikiLink[2].trim();
      const startIdx = cursorPos - fullToken.length;
      const span = document.createElement('span');
      span.className = 'doc-token doc-link';
      span.setAttribute('data-link', title);
      span.textContent = title;
      replaceSliceInTextNode(textNode, startIdx, cursorPos, span, afterCursor.startsWith(' ') ? '' : ' ');
      return true;
    }

    // 3. #label followed by space or punctuation
    const labelDone = uptoCursor.match(/(?:^|[\s(])(#([\p{L}][\p{L}\p{N}_-]{1,38}))([ \t,.;:!?)])$/u);
    if (labelDone) {
      const hashToken = labelDone[1];
      const lblName = labelDone[2];
      const delim = labelDone[3];
      const startIdx = cursorPos - hashToken.length - delim.length;
      const span = createLabelTokenSpan(lblName);
      replaceSliceInTextNode(textNode, startIdx, cursorPos, span, delim);
      return true;
    }

    // 4. Unbracketed @person followed by punctuation (@daniel, / @daniel. / @daniel:)
    const personPunct = uptoCursor.match(/(?:^|[\s(])(@([\p{L}][\p{L}\p{N}\s._-]{0,40}?[\p{L}\p{N}._-]))([,.;:!?)])$/u);
    if (personPunct) {
      const candidate = personPunct[2];
      const delim = personPunct[3];
      const isValidCandidate =
        !/\s/.test(candidate) ||
        peopleRef.current.some((p) => p.name.toLowerCase() === candidate.replace(/\s+/g, ' ').toLowerCase());
      if (isValidCandidate) {
        const atToken = personPunct[1];
        const startIdx = cursorPos - atToken.length - delim.length;
        const span = createPersonTokenSpan(candidate.replace(/\s+/g, ' '));
        replaceSliceInTextNode(textNode, startIdx, cursorPos, span, delim);
        return true;
      }
    }

    // 5. Unbracketed @person followed by space (or space + next word when no known multi-word person matches)
    const personSpace = uptoCursor.match(/(?:^|[\s(])(@([\p{L}][\p{L}\p{N}._-]{0,30}(?:\s+[\p{L}\p{N}._-]{0,30})*\s?))$/u);
    if (personSpace && /\s/.test(personSpace[2])) {
      const atTokenWithTrail = personSpace[1]; // starts with '@'
      const segment = personSpace[2]; // text after '@'
      const segNorm = segment.replace(/\s+/g, ' ');
      const segLower = segNorm.toLowerCase();
      const startIdx = cursorPos - atTokenWithTrail.length;

      if (segment.endsWith(' ')) {
        const trimmed = segNorm.trimEnd();
        const trimmedLower = trimmed.toLowerCase();
        const hasLongerKnownPerson = peopleRef.current.some((p) =>
          p.name.toLowerCase().startsWith(`${trimmedLower} `)
        );
        const isKnownOrSingleWord =
          !/\s/.test(trimmed) ||
          peopleRef.current.some((p) => p.name.toLowerCase() === trimmedLower);

        if (!hasLongerKnownPerson && isKnownOrSingleWord && trimmed.length >= 1) {
          const trailingSpaces = segment.slice( segment.trimEnd().length ) || ' ';
          const span = createPersonTokenSpan(trimmed);
          replaceSliceInTextNode(textNode, startIdx, cursorPos, span, trailingSpaces);
          return true;
        }
      } else {
        const stillMatchesKnownPerson = peopleRef.current.some((p) =>
          p.name.toLowerCase().startsWith(segLower)
        );
        if (!stillMatchesKnownPerson) {
          // Find longest prefix of words before the last space that is a known person, else take first word
          const words = segment.split(/(\s+)/); // preserves exact whitespace separators
          let bestName = words[0];
          let acc = words[0];
          for (let i = 2; i < words.length - 1; i += 2) {
            acc += words[i - 1] + words[i];
            const normAcc = acc.replace(/\s+/g, ' ').toLowerCase();
            if (peopleRef.current.some((p) => p.name.toLowerCase() === normAcc)) {
              bestName = acc;
            }
          }
          if (bestName.trim().length >= 1) {
            const overflowSuffix = segment.slice(bestName.length);
            const span = createPersonTokenSpan(bestName.replace(/\s+/g, ' '));
            replaceSliceInTextNode(textNode, startIdx, cursorPos, span, overflowSuffix);
            return true;
          }
        }
      }
    }

    return false;
  };

  // Prevent typing spaces/punctuation at the right edge of an inline token from bleeding token color
  const handleDocBeforeInput = (e: React.FormEvent<HTMLDivElement>) => {
    const native = e.nativeEvent as Partial<InputEvent>;
    const data =
      typeof native.data === 'string'
        ? native.data
        : typeof (e as unknown as { data?: unknown }).data === 'string'
        ? (e as unknown as { data: string }).data
        : null;
    if (!data || !/^[ \t,.;:!?)]/.test(data)) return;

    const root = docRef.current;
    const sel = window.getSelection();
    if (!root || !sel || !sel.isCollapsed || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    let tokenEl: HTMLElement | null = null;
    let curr: Node | null = range.startContainer;
    while (curr && curr !== root) {
      if (curr.nodeType === Node.ELEMENT_NODE && (curr as HTMLElement).classList.contains('doc-token')) {
        tokenEl = curr as HTMLElement;
        break;
      }
      curr = curr.parentNode;
    }
    if (!tokenEl) return;

    const endProbe = document.createRange();
    endProbe.selectNodeContents(tokenEl);
    endProbe.setStart(range.startContainer, range.startOffset);
    if (endProbe.toString().length === 0) {
      e.preventDefault();
      pendingInputMetaRef.current = null;
      const isAtLineEnd = !tokenEl.nextSibling || tokenEl.nextSibling.nodeName === 'BR';
      const outChar = data === ' ' && isAtLineEnd ? '\u00A0' : data;
      const textNode = document.createTextNode(outChar);
      tokenEl.after(textNode);
      const nextRange = document.createRange();
      nextRange.setStart(textNode, textNode.length);
      nextRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nextRange);
      setActiveToken(null);
      emitMarkdownFromDom({
        label: 'Typing',
        coalesceKey: 'doc-type',
        wordBoundary: /\s/.test(data),
      });
    }
  };

  const handleDocInput = () => {
    if (isComposingRef.current) return;
    const inputMeta = pendingInputMetaRef.current;
    pendingInputMetaRef.current = null;
    if (tryApplyAutoMarkdownPrefix()) {
      setAutocomplete(null);
      return;
    }
    normalizeInlineTokensInActiveBlock();
    if (tryFinalizeInlineTriggerAtCaret()) {
      setAutocomplete(null);
      setActiveToken(null);
      emitMarkdownFromDom({ label: 'Mention / tag', coalesceKey: null });
      return;
    }
    emitMarkdownFromDom(inputMeta ?? { label: 'Typing', coalesceKey: 'doc-type' });
    detectDocAutocomplete();
  };

  const handleDocKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (autocomplete && autocompleteItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIndex((i) => (i < 0 ? 0 : (i + 1) % autocompleteItems.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIndex((i) => (i <= 0 ? autocompleteItems.length - 1 : i - 1));
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        applyAutocompleteItem(autocompleteItems[acIndex >= 0 ? acIndex : 0]);
        return;
      }
      if (e.key === 'Enter') {
        if (acIndex >= 0 && autocompleteItems[acIndex]) {
          e.preventDefault();
          applyAutocompleteItem(autocompleteItems[acIndex]);
          return;
        }
        // User pressed Enter at the end of a line after typing a new @person or #label without selecting '+ Add':
        // finalize the mention/label token cleanly and allow Enter to create the next line normally!
        if (
          autocomplete.textNode &&
          docRef.current?.contains(autocomplete.textNode) &&
          autocomplete.query.trim().length >= 1
        ) {
          if (autocomplete.kind === 'person' && !/\s/.test(autocomplete.query.trim())) {
            recordPreEditSelection();
            const span = createPersonTokenSpan(autocomplete.query.trim());
            replaceSliceInTextNode(autocomplete.textNode, autocomplete.tokenStart, autocomplete.cursorPos, span, '');
            emitMarkdownFromDom({ label: 'Mention / tag', coalesceKey: null });
          } else if (autocomplete.kind === 'label') {
            recordPreEditSelection();
            const span = createLabelTokenSpan(autocomplete.query.trim());
            replaceSliceInTextNode(autocomplete.textNode, autocomplete.tokenStart, autocomplete.cursorPos, span, '');
            emitMarkdownFromDom({ label: 'Mention / tag', coalesceKey: null });
          }
        }
        setAutocomplete(null);
        setActiveToken(null);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAutocomplete(null);
        return;
      }
    }

    const root = docRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const blk = findEditableBlock(range.startContainer, root);

    // Smooth ArrowUp from very top of document into Note Title
    if (
      e.key === 'ArrowUp' &&
      !e.shiftKey &&
      blk &&
      blk === root.firstElementChild &&
      isCaretAtStartOfBlock(blk, range)
    ) {
      e.preventDefault();
      titleInputRef.current?.focus();
      return;
    }

    // Smooth Enter behavior on Tasks, Decisions, Headings, and Blockquotes
    if (e.key === 'Enter' && !e.shiftKey && range.collapsed && blk) {
      const tag = blk.tagName.toUpperCase();
      const isTask = blk.classList.contains('doc-task');
      const isDec = blk.classList.contains('doc-decision');
      const isHeading = tag === 'H1' || tag === 'H2' || tag === 'H3';
      const isQuote = tag === 'BLOCKQUOTE';

      if (isTask || isDec || isHeading || isQuote) {
        e.preventDefault();
        recordPreEditSelection();
        const isEmpty = !(blk.textContent || '').trim();

        // Pressing Enter on an empty Task, Decision, or Quote exits back to normal Paragraph
        if (isEmpty && (isTask || isDec || isQuote)) {
          const p = document.createElement('p');
          p.innerHTML = '<br>';
          blk.replaceWith(p);
          placeCaretAtStart(p);
          emitMarkdownFromDom({ label: 'Convert to paragraph', coalesceKey: null });
          refreshSelectionToolbarState();
          return;
        }

        // Split content after caret into the next block
        const tailRange = document.createRange();
        tailRange.selectNodeContents(blk);
        tailRange.setStart(range.startContainer, range.startOffset);
        const tailFrag = tailRange.extractContents();

        if (!blk.innerHTML.trim()) {
          blk.innerHTML = '<br>';
        }

        const nextBlock = document.createElement('p');
        if (isTask) {
          nextBlock.className = 'doc-task';
          nextBlock.setAttribute('data-status', 'todo');
        }
        nextBlock.appendChild(tailFrag);
        if (!nextBlock.innerHTML.trim()) {
          nextBlock.innerHTML = '<br>';
        }

        blk.after(nextBlock);
        placeCaretAtStart(nextBlock);
        emitMarkdownFromDom({ label: 'New paragraph', coalesceKey: null });
        refreshSelectionToolbarState();
        return;
      }
    }

    // Smooth Backspace at start of Task, Decision, Heading, or Quote converts to normal Paragraph;
    // or removes an immediately preceding image block
    if (e.key === 'Backspace' && range.collapsed && blk && isCaretAtStartOfBlock(blk, range)) {
      const tag = blk.tagName.toUpperCase();
      const isTask = blk.classList.contains('doc-task');
      const isDec = blk.classList.contains('doc-decision');
      const isHeading = tag === 'H1' || tag === 'H2' || tag === 'H3';
      const isQuote = tag === 'BLOCKQUOTE';

      if (isTask || isDec || isHeading || isQuote) {
        e.preventDefault();
        recordPreEditSelection();
        const p = document.createElement('p');
        p.innerHTML = blk.innerHTML || '<br>';
        blk.replaceWith(p);
        placeCaretAtStart(p);
        emitMarkdownFromDom({ label: 'Convert to paragraph', coalesceKey: null });
        refreshSelectionToolbarState();
        return;
      }

      const prevEl = blk.previousElementSibling as HTMLElement | null;
      if (prevEl && prevEl.classList.contains('doc-image-block')) {
        e.preventDefault();
        recordPreEditSelection();
        prevEl.remove();
        emitMarkdownFromDom({ label: 'Remove image', coalesceKey: null });
        return;
      }
    }

    // Delete at end of block removes an immediately following image block
    if (e.key === 'Delete' && range.collapsed && blk && isCaretAtEndOfBlock(blk, range)) {
      const nextEl = blk.nextElementSibling as HTMLElement | null;
      if (nextEl && nextEl.classList.contains('doc-image-block')) {
        e.preventDefault();
        recordPreEditSelection();
        nextEl.remove();
        emitMarkdownFromDom({ label: 'Remove image', coalesceKey: null });
        return;
      }
    }
  };

  // Drag-to-resize handles on note images (left edge, right edge, bottom-right corner)
  const handleDocPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const handleEl = target.closest('[data-resize-dir]') as HTMLElement | null;
    if (!handleEl) return;

    const figureEl = handleEl.closest('figure.doc-image-block') as HTMLElement | null;
    const root = docRef.current;
    if (!figureEl || !root) return;

    e.preventDefault();
    e.stopPropagation();
    recordPreEditSelection();

    const dir = handleEl.getAttribute('data-resize-dir') || 'se';
    const imgEl = figureEl.querySelector('img');
    const startRect = (imgEl || figureEl).getBoundingClientRect();
    const startWidth = Math.max(80, startRect.width);
    const startX = e.clientX;
    const maxAllowedWidth = Math.max(160, root.clientWidth);
    const minAllowedWidth = Math.min(120, maxAllowedWidth);
    let latestPx = Math.round(startWidth);

    figureEl.classList.add('is-resizing');

    const onPointerMove = (ev: PointerEvent) => {
      const deltaX = dir === 'w' ? startX - ev.clientX : ev.clientX - startX;
      const clamped = Math.round(
        Math.max(minAllowedWidth, Math.min(maxAllowedWidth, startWidth + deltaX))
      );
      latestPx = clamped;
      figureEl.style.width = `${clamped}px`;
      figureEl.setAttribute('data-width', String(clamped));

      const pct = Math.round((clamped / maxAllowedWidth) * 100);
      const pill = figureEl.querySelector('.doc-image-size-pill');
      if (pill) {
        pill.textContent = `${clamped}px · ${pct}%`;
      }
      figureEl
        .querySelectorAll('.doc-image-preset[data-preset]')
        .forEach((btn) => btn.classList.remove('active'));
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      figureEl.classList.remove('is-resizing');
      const pill = figureEl.querySelector('.doc-image-size-pill');
      if (pill) {
        pill.textContent = `${latestPx}px`;
      }
      suppressImageClickUntilRef.current = performance.now() + 260;
      emitMarkdownFromDom({ label: 'Resize image', coalesceKey: null });
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  // Interactive left-gutter click on Task Checkbox or Decision Status Badge + Ctrl/Cmd+Click on links
  const handleDocMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    if (
      target.closest('[data-img-action]') ||
      target.closest('[data-resize-dir]') ||
      target.closest('figure.doc-image-block')
    ) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Ctrl/Cmd + Click on @person, #label, or [[note]] navigates immediately (just like Microsoft Word!)
    const tokenEl = target.closest('.doc-token') as HTMLElement | null;
    if (tokenEl && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (tokenEl.classList.contains('doc-person')) {
        onNavigatePerson((tokenEl.textContent || '').replace(/^@+/, '').trim());
      } else if (tokenEl.classList.contains('doc-label')) {
        onNavigateLabel(normalizeLabel(tokenEl.textContent || ''));
      } else if (tokenEl.classList.contains('doc-link')) {
        onNavigateOrCreateNoteByTitle((tokenEl.textContent || '').trim());
      }
      return;
    }

    const taskEl = target.closest('.doc-task') as HTMLElement | null;
    if (taskEl) {
      const rect = taskEl.getBoundingClientRect();
      if (e.clientX - rect.left <= 30) {
        e.preventDefault();
        recordPreEditSelection();
        const curr = (taskEl.getAttribute('data-status') || 'todo') as TaskStatus;
        const next = TASK_CYCLE[(TASK_CYCLE.indexOf(curr) + 1) % TASK_CYCLE.length];
        taskEl.setAttribute('data-status', next);
        emitMarkdownFromDom({ label: 'Update task status', coalesceKey: null });
        return;
      }
    }

    const decEl = target.closest('.doc-decision') as HTMLElement | null;
    if (decEl) {
      const rect = decEl.getBoundingClientRect();
      if (e.clientX - rect.left <= 98) {
        e.preventDefault();
        recordPreEditSelection();
        const curr = (decEl.getAttribute('data-status') || 'agreed') as DecisionStatus;
        const next = DECISION_CYCLE[(DECISION_CYCLE.indexOf(curr) + 1) % DECISION_CYCLE.length];
        decEl.setAttribute('data-status', next);
        emitMarkdownFromDom({ label: 'Update decision status', coalesceKey: null });
      }
    }
  };

  const handleDocClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    const actionBtn = target.closest('[data-img-action]') as HTMLElement | null;
    if (actionBtn) {
      e.preventDefault();
      e.stopPropagation();
      const figureEl = actionBtn.closest('figure.doc-image-block') as HTMLElement | null;
      if (!figureEl) return;

      const action = actionBtn.getAttribute('data-img-action');
      if (action === 'preset') {
        recordPreEditSelection();
        const preset = actionBtn.getAttribute('data-preset') || '100%';
        figureEl.style.width = preset;
        figureEl.setAttribute('data-width', preset);
        figureEl.querySelectorAll('.doc-image-preset[data-preset]').forEach((btn) => {
          btn.classList.toggle('active', btn.getAttribute('data-preset') === preset);
        });
        const pill = figureEl.querySelector('.doc-image-size-pill');
        if (pill) {
          pill.textContent = preset;
        }
        emitMarkdownFromDom({ label: 'Resize image', coalesceKey: null });
        return;
      }

      if (action === 'zoom') {
        openLightboxForElement(figureEl);
        return;
      }

      if (action === 'delete') {
        recordPreEditSelection();
        const root = docRef.current;
        const nextSib = figureEl.nextElementSibling as HTMLElement | null;
        const prevSib = figureEl.previousElementSibling as HTMLElement | null;
        figureEl.remove();
        if (root && root.children.length === 0) {
          const p = document.createElement('p');
          p.innerHTML = '<br>';
          root.appendChild(p);
          placeCaretAtStart(p);
        } else if (nextSib && !nextSib.classList.contains('doc-image-block')) {
          placeCaretAtStart(nextSib);
        } else if (prevSib && !prevSib.classList.contains('doc-image-block')) {
          placeCaretAtEnd(prevSib);
        }
        emitMarkdownFromDom({ label: 'Remove image', coalesceKey: null });
        return;
      }
    }

    if (target.closest('[data-resize-dir]')) {
      return;
    }

    const clickedImg = target.closest('img') as HTMLImageElement | null;
    if (clickedImg && docRef.current?.contains(clickedImg)) {
      if (performance.now() < suppressImageClickUntilRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      openLightboxForElement(clickedImg);
    }
  };

  const handleDocMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const root = docRef.current;
    if (!root) return;
    const target = e.target as HTMLElement;
    const taskEl = target.closest('.doc-task') as HTMLElement | null;
    if (taskEl && e.clientX - taskEl.getBoundingClientRect().left <= 30) {
      root.style.cursor = 'pointer';
      return;
    }
    const decEl = target.closest('.doc-decision') as HTMLElement | null;
    if (decEl && e.clientX - decEl.getBoundingClientRect().left <= 98) {
      root.style.cursor = 'pointer';
      return;
    }
    if (root.style.cursor) {
      root.style.cursor = '';
    }
  };

  const handleDocPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const root = docRef.current;
    if (!root) return;

    recordPreEditSelection();

    const htmlData = e.clipboardData.getData('text/html');
    const plainData = e.clipboardData.getData('text/plain');
    const imageFiles = extractImageFilesFromDataTransfer(e.clipboardData, { fromClipboard: true });

    // Direct clipboard image paste (screenshots, copied browser images, or copied image files)
    if (imageFiles.length > 0 && (!htmlData || htmlContainsOnlyImageOrEmpty(htmlData))) {
      e.preventDefault();
      const capturedRange = captureCurrentDocRange();
      void insertImageFiles(imageFiles, capturedRange);
      return;
    }

    e.preventDefault();

    const looksLikeMarkdown =
      /(?:^|\n)\s*(?:#{1,3}\s|[-*]\s*\[(?:[ /?xX]|D)|[-*]\s+|\d+\.\s+|>\s|!\[[^\]]*\]\([^)]+\))/i.test(
        plainData
      ) || /@\[[^\]]+\]|\[\[[^\]]+\]\]/.test(plainData);

    let cleanHtml = '';
    if (htmlData && !looksLikeMarkdown) {
      cleanHtml = sanitizePastedHtml(htmlData, directory.people);
    }
    if (!cleanHtml && plainData) {
      cleanHtml = markdownToHtml(plainData.replace(/\r\n/g, '\n'), directory.people);
    }
    if (!cleanHtml) return;

    document.execCommand('insertHTML', false, cleanHtml);
    emitMarkdownFromDom({ label: 'Paste', coalesceKey: null });
    refreshSelectionToolbarState();
  };

  const handleRawPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = extractImageFilesFromDataTransfer(e.clipboardData, { fromClipboard: true });
    const htmlData = e.clipboardData.getData('text/html');
    const plainData = e.clipboardData.getData('text/plain');

    if (
      imageFiles.length > 0 &&
      !plainData.trim() &&
      (!htmlData || htmlContainsOnlyImageOrEmpty(htmlData))
    ) {
      e.preventDefault();
      void insertImageFiles(imageFiles, null);
    }
  };

  const handleSheetDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!isDragOverPage) setIsDragOverPage(true);
    }
  };

  const handleSheetDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDragOverPage(false);
    }
  };

  const handleSheetDrop = (e: React.DragEvent<HTMLDivElement>) => {
    setIsDragOverPage(false);
    const imageFiles = extractImageFilesFromDataTransfer(e.dataTransfer);
    if (imageFiles.length === 0) return;

    e.preventDefault();
    e.stopPropagation();

    let dropRange: Range | null = null;
    if (
      !rawMode &&
      docRef.current &&
      'caretRangeFromPoint' in document &&
      typeof document.caretRangeFromPoint === 'function'
    ) {
      const candidate = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (candidate && docRef.current.contains(candidate.commonAncestorContainer)) {
        dropRange = candidate;
      }
    }
    void insertImageFiles(imageFiles, dropRange ?? captureCurrentDocRange());
  };

  const scopeSelectValue =
    note.scope === 'client' && note.clientId
      ? `client:${note.clientId}`
      : note.scope === 'internal'
      ? 'internal'
      : 'inbox';

  const activeClientObj = note.clientId
    ? directory.clients.find((c) => c.id === note.clientId)
    : undefined;
  const activeProjectObj = note.projectId
    ? directory.projects.find((p) => p.id === note.projectId)
    : undefined;

  return (
    <div
      className="editor-scroll"
      onClick={() => {
        setAutocomplete(null);
        setShowInsertMenu(false);
      }}
    >
      {/* Unified Sticky Word-Style Formatting & Actions Ribbon */}
      <div className="doc-ribbon no-print" onClick={(e) => e.stopPropagation()}>
        <div className="doc-ribbon-group">
          <button
            id="btn-editor-undo"
            type="button"
            className="doc-fmt-btn"
            disabled={!canUndo}
            aria-label="Undo"
            title={
              canUndo && undoLabel
                ? `Undo: ${undoLabel} (${UNDO_SHORTCUT_HINT})`
                : `Undo (${UNDO_SHORTCUT_HINT})`
            }
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onUndo?.()}
          >
            <Undo2 size={14} />
          </button>
          <button
            id="btn-editor-redo"
            type="button"
            className="doc-fmt-btn"
            disabled={!canRedo}
            aria-label="Redo"
            title={
              canRedo && redoLabel
                ? `Redo: ${redoLabel} (${REDO_SHORTCUT_HINT})`
                : `Redo (${REDO_SHORTCUT_HINT})`
            }
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onRedo?.()}
          >
            <Redo2 size={14} />
          </button>

          {!rawMode && (
            <>
              <span className="doc-ribbon-sep" />

              <select
                className="doc-block-select"
                aria-label="Paragraph style"
                value={
                  activeFormat.block === 'h1' ||
                  activeFormat.block === 'h2' ||
                  activeFormat.block === 'h3' ||
                  activeFormat.block === 'blockquote'
                    ? activeFormat.block
                    : 'p'
                }
                onChange={(e) =>
                  applyBlockStyle(e.target.value as 'p' | 'h1' | 'h2' | 'h3' | 'blockquote')
                }
              >
                <option value="p">Normal text</option>
                <option value="h1">Heading 1</option>
                <option value="h2">Heading 2</option>
                <option value="h3">Heading 3</option>
                <option value="blockquote">Quote</option>
              </select>

              <span className="doc-ribbon-sep" />

              <button
                type="button"
                className={`doc-fmt-btn ${activeFormat.bold ? 'active' : ''}`}
                title="Bold (Ctrl+B)"
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyInlineCommand('bold');
                }}
              >
                <Bold size={14} />
              </button>
              <button
                type="button"
                className={`doc-fmt-btn ${activeFormat.italic ? 'active' : ''}`}
                title="Italic (Ctrl+I)"
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyInlineCommand('italic');
                }}
              >
                <Italic size={14} />
              </button>
              <button
                type="button"
                className={`doc-fmt-btn ${activeFormat.strike ? 'active' : ''}`}
                title="Strikethrough"
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyInlineCommand('strikeThrough');
                }}
              >
                <Strikethrough size={14} />
              </button>

              <span className="doc-ribbon-sep" />

              <button
                type="button"
                className={`doc-fmt-btn ${activeFormat.block === 'ul' ? 'active' : ''}`}
                title="Bullet List (- )"
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyBlockStyle('ul');
                }}
              >
                <List size={14} />
              </button>
              <button
                type="button"
                className={`doc-fmt-btn ${activeFormat.block === 'ol' ? 'active' : ''}`}
                title="Numbered List (1. )"
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyBlockStyle('ol');
                }}
              >
                <ListOrdered size={14} />
              </button>
              <button
                type="button"
                className={`doc-fmt-btn ${activeFormat.block === 'blockquote' ? 'active' : ''}`}
                title="Quote / Decision Rationale (> )"
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyBlockStyle('blockquote');
                }}
              >
                <Quote size={13} />
              </button>

              <span className="doc-ribbon-sep" />

              <button
                type="button"
                className={`doc-fmt-btn doc-fmt-chip ${activeFormat.block === 'task' ? 'active' : ''}`}
                title="Toggle Action Item Checkbox ([] )"
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyBlockStyle('task');
                }}
              >
                <CheckSquare size={13} />
                <span>Task</span>
              </button>
              <button
                type="button"
                className={`doc-fmt-btn doc-fmt-chip ${activeFormat.block === 'decision' ? 'active' : ''}`}
                title="Toggle Decision Line ([D] )"
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyBlockStyle('decision');
                }}
              >
                <Gavel size={13} />
                <span>Decision</span>
              </button>
              <button
                id="btn-insert-image"
                type="button"
                className="doc-fmt-btn doc-fmt-chip"
                title="Insert or upload image (or paste from clipboard with Ctrl+V)"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleTriggerImageUpload();
                }}
              >
                <ImageIcon size={13} />
                <span>Image</span>
              </button>
            </>
          )}
        </div>

        <div className="doc-ribbon-group">
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => setShowInsertMenu((v) => !v)}
              title="Insert Image, Templates, Meeting Invite Parser & Context Ask"
            >
              <Plus size={13} /> Insert ▾
            </button>
            {showInsertMenu && (
              <div className="doc-insert-popover">
                <button
                  type="button"
                  className="doc-insert-item"
                  onClick={handleTriggerImageUpload}
                >
                  <ImageIcon size={13} />
                  <span>Upload Image… (or Paste)</span>
                </button>
                <div className="doc-insert-divider" />
                <div className="doc-insert-section-title">Page Templates</div>
                {NOTE_TEMPLATES.filter((t) => t.id !== 'blank').map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className="doc-insert-item"
                    onClick={() => handleApplyTemplate(tpl.id)}
                  >
                    <FilePlus2 size={13} />
                    <span>{tpl.label}</span>
                  </button>
                ))}
                <div className="doc-insert-divider" />
                <button
                  type="button"
                  className="doc-insert-item"
                  onClick={() => {
                    setShowInsertMenu(false);
                    setShowInviteModal(true);
                  }}
                >
                  <MailPlus size={13} />
                  <span>Paste Teams / Outlook Invite…</span>
                </button>
                <button
                  type="button"
                  className="doc-insert-item"
                  onClick={() => {
                    setShowInsertMenu(false);
                    onOpenQuickAsk();
                  }}
                >
                  <Link2 size={13} />
                  <span>Ask &amp; Pull Citations…</span>
                </button>
              </div>
            )}
          </div>

          <button
            id="btn-ai-structure"
            type="button"
            className="btn btn-xs btn-soft"
            onClick={onOpenAiStructure}
            title="Infer metadata, extract Tasks & Decisions, and preview structured cleanup"
          >
            <Sparkles size={12} />
            <span>Structure</span>
          </button>

          <button
            type="button"
            className={`btn btn-xs ${rawMode ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => {
              setRawMode((v) => !v);
              setAutocomplete(null);
              setActiveToken(null);
            }}
            title="Switch between smooth Page View and Raw Markdown source"
          >
            {rawMode ? <Eye size={13} /> : <Code2 size={13} />}
            <span>{rawMode ? 'Page View' : 'Raw .md'}</span>
          </button>

          <button
            type="button"
            className="btn btn-xs btn-danger-ghost"
            onClick={() => onDeleteNote(note.id)}
            title="Delete this note"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Continuous Word-Like Document Sheet */}
      <div
        className={`word-page-sheet ${isDragOverPage ? 'drag-over-image' : ''}`}
        onDragOver={handleSheetDragOver}
        onDragLeave={handleSheetDragLeave}
        onDrop={handleSheetDrop}
        onClick={(e) => {
          if (e.target === e.currentTarget && docRef.current && !rawMode) {
            docRef.current.focus();
            placeCaretAtEnd(docRef.current);
          }
        }}
      >
        {/* Document Title */}
        <h1 style={{ margin: 0 }}>
          <input
            ref={titleInputRef}
            id="note-title-input"
            type="text"
            className="note-title-input"
            placeholder="Untitled document"
            value={note.title}
            onFocus={syncTitleSelectionBefore}
            onSelect={syncTitleSelectionBefore}
            onChange={(e) => {
              const prevLen = noteRef.current.title.length;
              const nextVal = e.target.value;
              const delta = nextVal.length - prevLen;
              let coalesceKey: string | null = 'title-type';
              let wordBoundary = false;
              if (delta === 1) {
                const pos = (e.target.selectionStart ?? nextVal.length) - 1;
                wordBoundary = /\s/.test(nextVal[pos] || '');
              } else if (delta === -1) {
                coalesceKey = 'title-delete';
              } else if (Math.abs(delta) > 1) {
                coalesceKey = null;
              }
              patchNote({ title: nextVal }, { label: 'Edit title', coalesceKey, wordBoundary });
            }}
            onKeyDown={(e) => {
              syncTitleSelectionBefore();
              if ((e.key === 'Enter' || e.key === 'ArrowDown') && docRef.current) {
                e.preventDefault();
                docRef.current.focus();
                const first = docRef.current.firstElementChild as HTMLElement | null;
                if (first) placeCaretAtStart(first);
              }
            }}
          />
        </h1>

        {/* Mobile Compact Context & Properties Toggle Bar */}
        <button
          type="button"
          className="mobile-props-bar"
          onClick={() => setMobilePropsOpen((v) => !v)}
          aria-expanded={mobilePropsOpen}
        >
          <span className="mobile-props-summary">
            <span>{note.date}</span>
            <span>·</span>
            {activeClientObj ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600, color: 'var(--text-primary)' }}>
                <span className="client-dot" style={{ background: activeClientObj.color }} />
                {activeClientObj.name}
                {activeProjectObj ? ` / ${activeProjectObj.name}` : ''}
              </span>
            ) : note.scope === 'internal' ? (
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                Internal{activeProjectObj ? ` / ${activeProjectObj.name}` : ''}
              </span>
            ) : (
              <span>Inbox</span>
            )}
            {note.participants.length > 0 && <span>· @{note.participants.length}</span>}
            {combinedLabels.length > 0 && <span>· #{combinedLabels.length}</span>}
          </span>
          <span style={{ fontWeight: 600, color: 'var(--accent-text)', flexShrink: 0 }}>
            {mobilePropsOpen ? 'Hide ▴' : 'Properties ▾'}
          </span>
        </button>

        {/* Subtle Document Properties Header */}
        <div className={`meta-grid ${!mobilePropsOpen ? 'mobile-collapsed' : ''}`}>
          <div className="meta-row">
            <span className="meta-label">
              <Calendar size={13} /> Date &amp; Space
            </span>
            <div className="meta-value">
              <input
                type="date"
                className="meta-date-input"
                value={note.date}
                onChange={(e) =>
                  patchNote({ date: e.target.value }, { label: 'Change date', coalesceKey: 'note-date' })
                }
              />
              <select
                id="note-space-select"
                className="meta-select"
                value={scopeSelectValue}
                onChange={(e) => handleScopeOrClientChange(e.target.value)}
              >
                <option value="inbox">Inbox (Unfiled)</option>
                <option value="internal">Internal Workspace</option>
                <optgroup label="Clients">
                  {directory.clients.map((c) => (
                    <option key={c.id} value={`client:${c.id}`}>
                      Client: {c.name}
                    </option>
                  ))}
                </optgroup>
                <option value="__new_client__">+ New Client…</option>
              </select>

              {note.scope !== 'inbox' && (
                <select
                  id="note-project-select"
                  className="meta-select"
                  value={note.projectId || ''}
                  onChange={(e) => {
                    if (e.target.value === '__new_project__') {
                      setNewProjectPrompt(true);
                    } else {
                      patchNote(
                        { projectId: e.target.value || null },
                        { label: 'Change project', coalesceKey: null }
                      );
                    }
                  }}
                >
                  <option value="">General (No specific project)</option>
                  {availableProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      Project: {p.name}
                    </option>
                  ))}
                  <option value="__new_project__">+ New Project…</option>
                </select>
              )}

              {newClientPrompt && (
                <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="text"
                    className="inline-add-input"
                    placeholder="Client name…"
                    value={newClientName}
                    autoFocus
                    onChange={(e) => setNewClientName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newClientName.trim()) {
                        const cId = onAddClient(newClientName.trim(), undefined, {
                          recordHistory: false,
                        });
                        patchNote(
                          { scope: 'client', clientId: cId, projectId: null },
                          { label: 'Change space', coalesceKey: null }
                        );
                        setNewClientName('');
                        setNewClientPrompt(false);
                      } else if (e.key === 'Escape') {
                        setNewClientPrompt(false);
                      }
                    }}
                  />
                  <button type="button" className="btn btn-xs" onClick={() => setNewClientPrompt(false)}>
                    Cancel
                  </button>
                </span>
              )}

              {newProjectPrompt && (
                <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="text"
                    className="inline-add-input"
                    placeholder="Project name…"
                    value={newProjectName}
                    autoFocus
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newProjectName.trim()) {
                        const pScope = note.scope === 'client' ? 'client' : 'internal';
                        const pId = onAddProject(newProjectName.trim(), pScope, note.clientId, {
                          recordHistory: false,
                        });
                        patchNote({ projectId: pId }, { label: 'Change project', coalesceKey: null });
                        setNewProjectName('');
                        setNewProjectPrompt(false);
                      } else if (e.key === 'Escape') {
                        setNewProjectPrompt(false);
                      }
                    }}
                  />
                  <button type="button" className="btn btn-xs" onClick={() => setNewProjectPrompt(false)}>
                    Cancel
                  </button>
                </span>
              )}
            </div>
          </div>

          <div className="meta-row">
            <span className="meta-label" title="Meeting attendees">
              <UserPlus size={13} /> Participants
            </span>
            <div className="meta-value">
              {note.participants.map((pName) => (
                <span key={pName} className="pill pill-person" onClick={() => onNavigatePerson(pName)}>
                  @{pName}
                  <button
                    type="button"
                    className="pill-remove"
                    title="Remove participant"
                    onClick={(e) => {
                      e.stopPropagation();
                      patchNote(
                        { participants: note.participants.filter((x) => x !== pName) },
                        { label: 'Remove participant', coalesceKey: null }
                      );
                    }}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              <input
                type="text"
                list="people-datalist"
                className="inline-add-input"
                placeholder="+ Add participant…"
                value={participantInput}
                onChange={(e) => setParticipantInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    handleAddParticipant(participantInput);
                  }
                }}
                onBlur={() => {
                  if (participantInput.trim()) handleAddParticipant(participantInput);
                }}
              />
              <datalist id="people-datalist">
                {directory.people
                  .filter((p) => !note.participants.includes(p.name))
                  .map((p) => (
                    <option key={p.id} value={p.name} />
                  ))}
              </datalist>
            </div>
          </div>

          <div className="meta-row">
            <span className="meta-label" title="Note-level labels plus any #labels typed inline">
              <Hash size={13} /> Labels
            </span>
            <div className="meta-value">
              {combinedLabels.map((lbl) => (
                <span key={lbl} className="pill pill-label" onClick={() => onNavigateLabel(lbl)}>
                  #{lbl}
                  <button
                    type="button"
                    className="pill-remove"
                    title="Remove #label from this note"
                    onClick={(e) => {
                      e.stopPropagation();
                      lastEmittedMarkdownRef.current = '__FORCE_SYNC__';
                      onUpdateNote(removeLabelFromNote(note, lbl), {
                        label: 'Remove label',
                        coalesceKey: null,
                        selectionBefore: selectionBeforeRef.current,
                        selectionAfter: captureCurrentEditorSelection(),
                      });
                    }}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              <input
                type="text"
                list="labels-datalist"
                className="inline-add-input"
                placeholder="+ #label…"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
                    if (labelInput.trim()) {
                      e.preventDefault();
                      handleAddHeaderLabel(labelInput);
                    }
                  }
                }}
                onBlur={() => {
                  if (labelInput.trim()) handleAddHeaderLabel(labelInput);
                }}
              />
              <datalist id="labels-datalist">
                {allWorkspaceLabels
                  .filter((l) => !combinedLabels.includes(l))
                  .map((l) => (
                    <option key={l} value={l} />
                  ))}
              </datalist>
            </div>
          </div>
        </div>

        {/* Natural Name Detection Banner */}
        {unlinkedPeople.length > 0 && (
          <div className="unlinked-banner no-print">
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
              <UserCheck size={14} />
              Recognized in page:
              {unlinkedPeople.map((p) => (
                <strong key={p.id} style={{ color: 'var(--text-primary)' }}>
                  {p.name}
                </strong>
              ))}
            </span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {unlinkedPeople.map((p) => (
                <React.Fragment key={p.id}>
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => linkNaturalPersonEverywhere(p)}
                  >
                    Link @{p.name}
                  </button>
                  {!note.participants.includes(p.name) && (
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={() => handleAddParticipant(p.name)}
                    >
                      + Participant
                    </button>
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>
        )}

        {/* Document Body: Continuous Word-Like Editable Surface vs Raw Markdown */}
        {rawMode ? (
          <textarea
            ref={rawTextareaRef}
            className="raw-markdown-textarea"
            value={note.body}
            placeholder="Write plain Markdown… Use @[Name], #label, [[Note Title]], - [ ] Task, or - [D:agreed] Decision"
            onFocus={syncRawSelectionBefore}
            onSelect={syncRawSelectionBefore}
            onKeyDown={syncRawSelectionBefore}
            onChange={(e) => {
              const prevLen = noteRef.current.body.length;
              const nextVal = e.target.value;
              const delta = nextVal.length - prevLen;
              lastEmittedMarkdownRef.current = nextVal;
              let coalesceKey: string | null = null;
              let label = 'Edit Markdown';
              let wordBoundary = false;
              if (delta === 1) {
                const pos = (e.target.selectionStart ?? nextVal.length) - 1;
                const ch = nextVal[pos] || '';
                if (ch === '\n') {
                  coalesceKey = null;
                  label = 'New line';
                } else {
                  coalesceKey = 'raw-type';
                  label = 'Typing';
                  wordBoundary = /\s/.test(ch);
                }
              } else if (delta === -1) {
                coalesceKey = 'raw-delete';
                label = 'Delete text';
              } else if (delta > 1) {
                coalesceKey = null;
                label = 'Paste text';
              } else if (delta < -1) {
                coalesceKey = null;
                label = 'Delete selection';
              }
              patchNote({ body: nextVal }, { label, coalesceKey, wordBoundary });
              detectRawAutocomplete(nextVal, e.target.selectionStart ?? 0, e.target);
            }}
            onPaste={handleRawPaste}
          />
        ) : (
          <div
            ref={docRef}
            className="word-doc-body"
            contentEditable
            suppressContentEditableWarning
            spellCheck
            data-placeholder="Start typing anywhere on the page… Paste images from clipboard, or use @person, #label, [[note]], or /"
            onFocus={() => {
              try {
                document.execCommand('defaultParagraphSeparator', false, 'p');
              } catch {
                // Ignore if unsupported
              }
              refreshSelectionToolbarState();
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
              recordPreEditSelection();
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              handleDocInput();
            }}
            onBeforeInput={handleDocBeforeInput}
            onInput={handleDocInput}
            onKeyDown={handleDocKeyDown}
            onPointerDown={handleDocPointerDown}
            onMouseDown={handleDocMouseDown}
            onMouseMove={handleDocMouseMove}
            onClick={handleDocClick}
            onPaste={handleDocPaste}
          />
        )}

        {/* Subtle Page Footer */}
        <div className="word-page-footer no-print">
          <span>
            <FolderKanban size={12} style={{ verticalAlign: '-2px', marginRight: 5 }} />
            {note.filePath ||
              `${note.scope === 'inbox' ? 'Inbox' : note.scope === 'internal' ? 'Internal' : 'Clients'}/${note.date}-${slugify(note.title || 'untitled')}.md`}
          </span>
          <span>
            {parsedItems.decisions.length} decision(s) · {parsedItems.tasks.length} task(s)
          </span>
        </div>
      </div>

      {/* Hidden File Input for Image Insertion (/image, Ribbon Button, Insert Menu) */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
          e.target.value = '';
          if (files.length > 0) {
            const savedRange = savedInsertRangeRef.current;
            savedInsertRangeRef.current = null;
            void insertImageFiles(files, savedRange);
          }
        }}
      />

      {/* Subtle Word-Style Floating Link Chip when Caret is Inside @Person, #Label, or [[Note]] */}
      {activeToken && !autocomplete && (
        <div
          className="doc-token-popover no-print"
          style={{ top: activeToken.rect.top, left: activeToken.rect.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="doc-token-popover-btn"
            onClick={() => {
              if (activeToken.kind === 'person') onNavigatePerson(activeToken.value);
              else if (activeToken.kind === 'label') onNavigateLabel(activeToken.value);
              else onNavigateOrCreateNoteByTitle(activeToken.value);
              setActiveToken(null);
            }}
          >
            <ExternalLink size={12} />
            <span>
              {activeToken.kind === 'person'
                ? `Open @${activeToken.value} notes`
                : activeToken.kind === 'label'
                ? `Open #${activeToken.value} report`
                : `Open "${activeToken.value}"`}
            </span>
          </button>
        </div>
      )}

      {/* Caret-Anchored Autocomplete Popover */}
      {autocomplete && autocompleteItems.length > 0 && (
        <div
          className="autocomplete-popover"
          style={{ top: autocomplete.rect.top, left: autocomplete.rect.left }}
          onClick={(e) => e.stopPropagation()}
        >
          {autocompleteItems.map((item, i) => (
            <button
              key={item.id}
              type="button"
              className={`autocomplete-item ${i === acIndex ? 'selected' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                applyAutocompleteItem(item);
              }}
            >
              <span style={{ fontWeight: 500 }}>{item.label}</span>
              <span className="autocomplete-sub">{item.sub}</span>
            </button>
          ))}
        </div>
      )}

      {/* Paste Outlook / Microsoft Teams Invite Modal */}
      {showInviteModal && (
        <div className="modal-backdrop" onClick={() => setShowInviteModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong>Paste Outlook / Microsoft Teams Invite</strong>
              <button type="button" className="btn btn-icon btn-ghost" onClick={() => setShowInviteModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
                Paste a meeting header or semicolon-separated attendee list. Strata will auto-fill the{' '}
                <strong>Title, Date, Participants</strong>, create any new People records, and infer the{' '}
                <strong>Client</strong> from attendee email domains.
              </p>
              <textarea
                className="form-textarea"
                rows={6}
                autoFocus
                placeholder={`Subject: Q4 Architecture Sync\nDate: 2026-11-06\nRequired: Jane Doe <jane@acme.com>; Alex Rivera <alex@acme.com>`}
                value={inviteRawText}
                onChange={(e) => setInviteRawText(e.target.value)}
              />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setShowInviteModal(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!inviteRawText.trim()}
                onClick={handleApplyInvite}
              >
                Auto-Fill Note Metadata
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full-Screen Large View Image Modal with Zoom & Pan */}
      {lightbox && (
        <ImageLightboxModal
          key={`${lightbox.index}-${lightbox.images[lightbox.index]?.src}`}
          images={lightbox.images}
          initialIndex={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
};
