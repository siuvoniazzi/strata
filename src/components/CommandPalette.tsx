import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  CheckSquare,
  FilePlus2,
  FileText,
  FolderSync,
  Gavel,
  Hash,
  Maximize2,
  Minimize2,
  Moon,
  Redo2,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  Undo2,
  User,
  Users,
} from 'lucide-react';
import type { Note, WorkspaceDirectory } from '../types';

interface CommandPaletteProps {
  notes: Note[];
  directory: WorkspaceDirectory;
  allLabels: string[];
  theme: 'light' | 'dark';
  isFocusMode?: boolean;
  canUndoNote?: boolean;
  canRedoNote?: boolean;
  noteUndoLabel?: string | null;
  noteRedoLabel?: string | null;
  onUndoNote?: () => void;
  onRedoNote?: () => void;
  canUndoWorkspace?: boolean;
  canRedoWorkspace?: boolean;
  workspaceUndoLabel?: string | null;
  workspaceRedoLabel?: string | null;
  onUndoWorkspace?: () => void;
  onRedoWorkspace?: () => void;
  onClose: () => void;
  onNewNote: () => void;
  onToggleFocusMode?: () => void;
  onOpenSettings?: () => void;
  onDeleteCurrentNote: () => void;
  onSelectNote: (noteId: string) => void;
  onOpenReportForLabel: (label: string) => void;
  onOpenPersonNotes: (personName: string) => void;
  onSwitchMainView: (view: 'notes' | 'tasks' | 'decisions' | 'reports' | 'people') => void;
  onTriggerAiStructure: () => void;
  onToggleTheme: () => void;
  onConnectFolder: () => void;
}

const IS_MAC_PLATFORM =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const UNDO_SHORTCUT_HINT = IS_MAC_PLATFORM ? '⌘Z' : 'Ctrl+Z';
const REDO_SHORTCUT_HINT = IS_MAC_PLATFORM ? '⇧⌘Z' : 'Ctrl+Y';

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  notes,
  directory,
  allLabels,
  theme,
  isFocusMode = false,
  canUndoNote = false,
  canRedoNote = false,
  noteUndoLabel = null,
  noteRedoLabel = null,
  onUndoNote,
  onRedoNote,
  canUndoWorkspace = false,
  canRedoWorkspace = false,
  workspaceUndoLabel = null,
  workspaceRedoLabel = null,
  onUndoWorkspace,
  onRedoWorkspace,
  onClose,
  onNewNote,
  onToggleFocusMode,
  onOpenSettings,
  onDeleteCurrentNote,
  onSelectNote,
  onOpenReportForLabel,
  onOpenPersonNotes,
  onSwitchMainView,
  onTriggerAiStructure,
  onToggleTheme,
  onConnectFolder,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  const commands = useMemo(() => {
    const list: Array<{
      id: string;
      title: string;
      category: string;
      icon: React.ReactNode;
      action: () => void;
    }> = [
      ...(canUndoNote && onUndoNote
        ? [
            {
              id: 'act-undo-note',
              title: `Undo Note Edit${noteUndoLabel ? ` — ${noteUndoLabel}` : ''} (${UNDO_SHORTCUT_HINT})`,
              category: 'Quick Action',
              icon: <Undo2 size={14} />,
              action: onUndoNote,
            },
          ]
        : []),
      ...(canRedoNote && onRedoNote
        ? [
            {
              id: 'act-redo-note',
              title: `Redo Note Edit${noteRedoLabel ? ` — ${noteRedoLabel}` : ''} (${REDO_SHORTCUT_HINT})`,
              category: 'Quick Action',
              icon: <Redo2 size={14} />,
              action: onRedoNote,
            },
          ]
        : []),
      ...(canUndoWorkspace && onUndoWorkspace
        ? [
            {
              id: 'act-undo-workspace',
              title: `Undo Workspace Action${workspaceUndoLabel ? ` — ${workspaceUndoLabel}` : ''}`,
              category: 'Quick Action',
              icon: <Undo2 size={14} />,
              action: onUndoWorkspace,
            },
          ]
        : []),
      ...(canRedoWorkspace && onRedoWorkspace
        ? [
            {
              id: 'act-redo-workspace',
              title: `Redo Workspace Action${workspaceRedoLabel ? ` — ${workspaceRedoLabel}` : ''}`,
              category: 'Quick Action',
              icon: <Redo2 size={14} />,
              action: onRedoWorkspace,
            },
          ]
        : []),
      {
        id: 'act-new-note',
        title: 'Spin Up New Note (Instant Blank Canvas)',
        category: 'Quick Action',
        icon: <FilePlus2 size={14} />,
        action: onNewNote,
      },
      ...(onToggleFocusMode
        ? [
            {
              id: 'act-focus-mode',
              title: isFocusMode
                ? 'Exit Focus Mode (Restore Side Panels) — Alt+Z'
                : 'Focus Mode — Hide All Side Panels & Center Note (Alt+Z)',
              category: 'Quick Action',
              icon: isFocusMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />,
              action: onToggleFocusMode,
            },
          ]
        : []),
      {
        id: 'act-delete-note',
        title: 'Delete Current Note',
        category: 'Quick Action',
        icon: <Trash2 size={14} />,
        action: onDeleteCurrentNote,
      },
      {
        id: 'act-ai-structure',
        title: 'Structure & Extract Current Note (Preview Diff)',
        category: 'AI & Structure',
        icon: <Sparkles size={14} />,
        action: onTriggerAiStructure,
      },
      {
        id: 'view-directory',
        title: 'Open Directory (Manage People, Clients, Projects & #Labels)',
        category: 'Navigation',
        icon: <Users size={14} />,
        action: () => onSwitchMainView('people'),
      },
      {
        id: 'view-reports',
        title: 'Open Reports Hub (Topics, Tasks, Decisions, Clients)',
        category: 'Navigation',
        icon: <BarChart3 size={14} />,
        action: () => onSwitchMainView('reports'),
      },
      {
        id: 'view-tasks',
        title: 'Open Global Tasks Rollup',
        category: 'Navigation',
        icon: <CheckSquare size={14} />,
        action: () => onSwitchMainView('tasks'),
      },
      {
        id: 'view-decisions',
        title: 'Open Global Decision Register',
        category: 'Navigation',
        icon: <Gavel size={14} />,
        action: () => onSwitchMainView('decisions'),
      },
      {
        id: 'act-folder-sync',
        title: 'Multi-Device & Google Drive / Local Folder Sync (.md)',
        category: 'Storage & Cloud Sync',
        icon: <FolderSync size={14} />,
        action: onConnectFolder,
      },
      {
        id: 'act-theme',
        title: `Switch to ${theme === 'light' ? 'Dark' : 'Light'} Theme`,
        category: 'Appearance',
        icon: theme === 'light' ? <Moon size={14} /> : <Sun size={14} />,
        action: onToggleTheme,
      },
      ...(onOpenSettings
        ? [
            {
              id: 'act-workspace-settings',
              title: 'Workspace & AI Settings (Initial Focus Mode, New-Note Behavior, AI Engine)',
              category: 'Settings',
              icon: <Settings size={14} />,
              action: onOpenSettings,
            },
          ]
        : []),
    ];

    for (const n of notes) {
      list.push({
        id: `note-${n.id}`,
        title: n.title || 'Untitled Note',
        category: `Note · ${n.date}`,
        icon: <FileText size={14} />,
        action: () => onSelectNote(n.id),
      });
    }

    for (const lbl of allLabels) {
      list.push({
        id: `lbl-${lbl}`,
        title: `#${lbl} — Open Topic Report`,
        category: 'Topic / Label',
        icon: <Hash size={14} />,
        action: () => onOpenReportForLabel(lbl),
      });
    }

    for (const p of directory.people) {
      list.push({
        id: `person-${p.id}`,
        title: `@${p.name}${p.role ? ` (${p.role})` : ''}`,
        category: 'Person',
        icon: <User size={14} />,
        action: () => onOpenPersonNotes(p.name),
      });
    }

    const q = query.trim().toLowerCase();
    if (!q) return list.slice(0, 18);
    return list
      .filter((item) => item.title.toLowerCase().includes(q) || item.category.toLowerCase().includes(q))
      .slice(0, 18);
  }, [
    query,
    notes,
    allLabels,
    directory.people,
    theme,
    isFocusMode,
    canUndoNote,
    canRedoNote,
    noteUndoLabel,
    noteRedoLabel,
    onUndoNote,
    onRedoNote,
    canUndoWorkspace,
    canRedoWorkspace,
    workspaceUndoLabel,
    workspaceRedoLabel,
    onUndoWorkspace,
    onRedoWorkspace,
    onNewNote,
    onToggleFocusMode,
    onOpenSettings,
    onDeleteCurrentNote,
    onTriggerAiStructure,
    onSwitchMainView,
    onConnectFolder,
    onToggleTheme,
    onSelectNote,
    onOpenReportForLabel,
    onOpenPersonNotes,
  ]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 580 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Search size={16} color="var(--text-muted)" />
          <input
            type="text"
            autoFocus
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 14.5,
            }}
            placeholder="Jump to note, #topic report, @person, or run command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIdx((i) => (commands.length ? (i + 1) % commands.length : 0));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIdx((i) => (commands.length ? (i - 1 + commands.length) % commands.length : 0));
              } else if (e.key === 'Enter' && commands[selectedIdx]) {
                e.preventDefault();
                commands[selectedIdx].action();
                onClose();
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
          />
          <span className="kbd">ESC</span>
        </div>

        <div style={{ maxHeight: 360, overflowY: 'auto', padding: 6 }}>
          {commands.map((cmd, idx) => (
            <button
              key={cmd.id}
              type="button"
              className={`autocomplete-item ${idx === selectedIdx ? 'selected' : ''}`}
              style={{ padding: '8px 10px' }}
              onClick={() => {
                cmd.action();
                onClose();
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                {cmd.icon}
                <span style={{ fontWeight: 500 }}>{cmd.title}</span>
              </span>
              <span className="autocomplete-sub">{cmd.category}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
