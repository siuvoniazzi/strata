import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  CheckSquare,
  Code2,
  Eye,
  FilePlus2,
  FolderKanban,
  Gavel,
  Hash,
  Link2,
  MailPlus,
  Sparkles,
  Trash2,
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
  slugify,
  updateDecisionInBody,
  updateTaskInBody,
} from '../utils/markdown';
import { NOTE_TEMPLATES } from '../utils/seedData';
import { RichInlineText } from './RichInlineText';

interface HybridEditorProps {
  note: Note;
  allNotes: Note[];
  directory: WorkspaceDirectory;
  allWorkspaceLabels: string[];
  onUpdateNote: (updated: Note) => void;
  onDeleteNote: (noteId: string) => void;
  onAddClient: (name: string) => string;
  onAddProject: (name: string, scope: 'client' | 'internal', clientId: string | null) => string;
  onEnsurePerson: (name: string, clientId?: string | null, email?: string) => Person;
  onNavigateLabel: (label: string) => void;
  onNavigatePerson: (personName: string) => void;
  onNavigateOrCreateNoteByTitle: (title: string) => void;
  onOpenAiStructure: () => void;
  onOpenQuickAsk: () => void;
}

type AutocompleteTrigger = {
  kind: 'person' | 'label' | 'link' | 'slash';
  query: string;
  tokenStart: number;
  cursorPos: number;
  rect: { top: number; left: number };
};

const TASK_CYCLE: TaskStatus[] = ['todo', 'doing', 'waiting', 'done'];
const DECISION_CYCLE: DecisionStatus[] = ['agreed', 'proposed', 'superseded'];

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
}) => {
  const [rawMode, setRawMode] = useState(false);
  const [activeLineIdx, setActiveLineIdx] = useState<number | null>(null);
  const [participantInput, setParticipantInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteRawText, setInviteRawText] = useState('');
  const [newClientPrompt, setNewClientPrompt] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newProjectPrompt, setNewProjectPrompt] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  const [autocomplete, setAutocomplete] = useState<AutocompleteTrigger | null>(null);
  const [acIndex, setAcIndex] = useState(0);

  const lineInputRef = useRef<HTMLTextAreaElement | null>(null);
  const rawTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const lines = useMemo(() => {
    const arr = note.body.split('\n');
    return arr.length === 0 ? [''] : arr;
  }, [note.body]);

  const parsedItems = useMemo(
    () => parseNoteItems(note, directory.people),
    [note, directory.people]
  );

  const tasksByLine = useMemo(() => {
    const m = new Map<number, (typeof parsedItems.tasks)[number]>();
    for (const t of parsedItems.tasks) m.set(t.lineIndex, t);
    return m;
  }, [parsedItems.tasks]);

  const decisionsByLine = useMemo(() => {
    const m = new Map<number, (typeof parsedItems.decisions)[number]>();
    const rationaleLines = new Set<number>();
    for (const d of parsedItems.decisions) {
      m.set(d.lineIndex, d);
      if (d.rationaleLineIndex !== null) rationaleLines.add(d.rationaleLineIndex);
    }
    return { map: m, rationaleLines };
  }, [parsedItems.decisions]);

  const combinedLabels = useMemo(() => getAllNoteLabels(note), [note]);

  const unlinkedPeople = useMemo(
    () => detectUnlinkedPeopleInText(note.body, directory.people),
    [note.body, directory.people]
  );

  useEffect(() => {
    if (activeLineIdx !== null && lineInputRef.current) {
      const el = lineInputRef.current;
      el.focus();
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [activeLineIdx]);

  const availableProjects = useMemo(() => {
    if (note.scope === 'client') {
      return directory.projects.filter((p) => p.scope === 'client' && p.clientId === note.clientId);
    }
    if (note.scope === 'internal') {
      return directory.projects.filter((p) => p.scope === 'internal');
    }
    return [];
  }, [directory.projects, note.scope, note.clientId]);

  const patchNote = (partial: Partial<Note>) => {
    onUpdateNote({
      ...note,
      ...partial,
      updatedAt: new Date().toISOString(),
    });
  };

  const handleScopeOrClientChange = (val: string) => {
    if (val === '__new_client__') {
      setNewClientPrompt(true);
      return;
    }
    if (val === 'inbox') {
      patchNote({ scope: 'inbox', clientId: null, projectId: null });
    } else if (val === 'internal') {
      patchNote({ scope: 'internal', clientId: null, projectId: null });
    } else if (val.startsWith('client:')) {
      const cId = val.slice('client:'.length);
      const validProj = directory.projects.some((p) => p.id === note.projectId && p.clientId === cId);
      patchNote({
        scope: 'client',
        clientId: cId,
        projectId: validProj ? note.projectId : null,
      });
    }
  };

  const handleAddParticipant = (rawName: string) => {
    const trimmed = rawName.trim().replace(/^@+/, '');
    if (!trimmed) return;
    const person = onEnsurePerson(trimmed, note.clientId);
    const nextParticipants = note.participants.includes(person.name)
      ? note.participants
      : [...note.participants, person.name];

    // Smart Client Inference: if note is still in Inbox and this person belongs to a Client, infer that Client!
    const inferredPatch: Partial<Note> = { participants: nextParticipants };
    if (note.scope === 'inbox' && !note.clientId && person.clientId) {
      inferredPatch.scope = 'client';
      inferredPatch.clientId = person.clientId;
    }
    patchNote(inferredPatch);
    setParticipantInput('');
  };

  const handleAddHeaderLabel = (rawLbl: string) => {
    const norm = normalizeLabel(rawLbl);
    if (!norm) return;
    if (!note.labels.includes(norm)) {
      patchNote({ labels: [...note.labels, norm] });
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

    patchNote({
      title: parsed.title || note.title,
      date: parsed.date || note.date,
      participants: mergedParticipants,
      clientId: nextClientId,
      scope: nextScope,
    });
    setInviteRawText('');
    setShowInviteModal(false);
  };

  const handleApplyTemplate = (templateId: string) => {
    const tpl = NOTE_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    const nextBody = note.body.trim() ? `${note.body.trim()}\n\n${tpl.body}` : tpl.body;
    const nextTitle = !note.title.trim() && tpl.titlePrefix ? tpl.titlePrefix : note.title;
    patchNote({ title: nextTitle, body: nextBody });
  };

  const appendBlockSnippet = (snippet: string) => {
    const base = note.body.trimEnd();
    const nextBody = base ? `${base}\n${snippet}` : snippet;
    patchNote({ body: nextBody });
    const nextLines = nextBody.split('\n');
    setActiveLineIdx(nextLines.length - 1);
  };

  const linkNaturalPersonEverywhere = (person: Person) => {
    const esc = person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const updatedBody = note.body.replace(
      new RegExp(`(?<!@\\[?)\\b${esc}\\b`, 'g'),
      formatPersonMention(person.name)
    );
    patchNote({ body: updatedBody });
  };

  // Detect @, #, [[, or / autocomplete triggers on active input/textarea
  const detectAutocomplete = (value: string, cursorPos: number, el: HTMLTextAreaElement) => {
    const uptoCursor = value.slice(0, cursorPos);
    const rect = el.getBoundingClientRect();
    const popRect = { top: Math.min(window.innerHeight - 250, rect.bottom + 4), left: Math.min(window.innerWidth - 300, rect.left + 16) };

    const linkMatch = uptoCursor.match(/\[\[([^\]]{0,35})$/);
    if (linkMatch) {
      setAutocomplete({
        kind: 'link',
        query: linkMatch[1],
        tokenStart: cursorPos - linkMatch[0].length,
        cursorPos,
        rect: popRect,
      });
      setAcIndex(0);
      return;
    }

    const personMatch = uptoCursor.match(/(?:^|[\s(])@([\p{L}\p{N}\s._-]{0,28})$/u);
    if (personMatch && !personMatch[1].includes('  ')) {
      const atIdx = uptoCursor.lastIndexOf('@');
      setAutocomplete({
        kind: 'person',
        query: personMatch[1],
        tokenStart: atIdx,
        cursorPos,
        rect: popRect,
      });
      setAcIndex(0);
      return;
    }

    const labelMatch = uptoCursor.match(/(?:^|[\s(])#([\p{L}\p{N}_-]{0,28})$/u);
    if (labelMatch) {
      const hashIdx = uptoCursor.lastIndexOf('#');
      setAutocomplete({
        kind: 'label',
        query: labelMatch[1],
        tokenStart: hashIdx,
        cursorPos,
        rect: popRect,
      });
      setAcIndex(0);
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
        rect: popRect,
      });
      setAcIndex(0);
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
            createPersonName: null as string | null,
          };
        });
      if (q.length >= 2 && !directory.people.some((p) => p.name.toLowerCase() === q)) {
        const displayNew = autocomplete.query.trim();
        matches.push({
          id: '__create_person__',
          label: `+ Create person "${displayNew}"`,
          sub: 'Add to directory & mention',
          replacement: `${formatPersonMention(displayNew)} `,
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
          createPersonName: null as string | null,
        }));
      const normQ = normalizeLabel(q);
      if (normQ && !allWorkspaceLabels.includes(normQ)) {
        matches.push({
          id: '__create_label__',
          label: `+ Create #${normQ}`,
          sub: 'New frictionless label',
          replacement: `#${normQ} `,
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
          createPersonName: null as string | null,
        }));
    }

    if (autocomplete.kind === 'slash') {
      const commands = [
        { id: 'task', label: '/task — Action item checkbox', sub: '- [ ] Task', replacement: '- [ ] ' },
        { id: 'decision', label: '/decision — Agreed decision', sub: '- [D:agreed]', replacement: '- [D:agreed] ' },
        { id: 'proposed', label: '/proposed — Proposed decision', sub: '- [D:proposed]', replacement: '- [D:proposed] ' },
        { id: 'due', label: '/due — Add due date ( +3d )', sub: 'due:YYYY-MM-DD', replacement: `due:${new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)} ` },
        { id: 'h2', label: '/h2 — Section heading', sub: '## Heading', replacement: '## ' },
        { id: 'ask', label: '/ask — Query past notes context', sub: 'Open Context Ask', replacement: '__OPEN_ASK__' },
      ];
      return commands
        .filter((c) => !q || c.id.includes(q) || c.label.toLowerCase().includes(q))
        .map((c) => ({ ...c, createPersonName: null as string | null }));
    }

    return [];
  }, [autocomplete, directory.people, directory.clients, allWorkspaceLabels, allNotes, note.id]);

  const applyAutocompleteItem = (item: (typeof autocompleteItems)[number]) => {
    if (!autocomplete) return;
    if (item.replacement === '__OPEN_ASK__') {
      setAutocomplete(null);
      onOpenQuickAsk();
      return;
    }
    if (item.createPersonName) {
      onEnsurePerson(item.createPersonName, note.clientId);
    }

    if (rawMode && rawTextareaRef.current) {
      const full = note.body;
      const updated =
        full.slice(0, autocomplete.tokenStart) + item.replacement + full.slice(autocomplete.cursorPos);
      patchNote({ body: updated });
      setAutocomplete(null);
      return;
    }

    if (activeLineIdx !== null) {
      const currentLine = lines[activeLineIdx] || '';
      // If slash command inserts a block prefix at start of line, replace leading bullet cleanly
      let nextLine: string;
      if (autocomplete.kind === 'slash' && item.replacement.startsWith('- [')) {
        nextLine = item.replacement + currentLine.slice(autocomplete.cursorPos).trimStart();
      } else {
        nextLine =
          currentLine.slice(0, autocomplete.tokenStart) +
          item.replacement +
          currentLine.slice(autocomplete.cursorPos);
      }
      const nextLines = [...lines];
      nextLines[activeLineIdx] = nextLine;
      patchNote({ body: nextLines.join('\n') });
      setAutocomplete(null);
    }
  };

  const updateSingleLine = (idx: number, value: string) => {
    const nextLines = [...lines];
    // If multi-line text was pasted into a single block, split cleanly into lines!
    if (value.includes('\n')) {
      const splitPasted = value.split(/\r?\n/);
      nextLines.splice(idx, 1, ...splitPasted);
      patchNote({ body: nextLines.join('\n') });
      setActiveLineIdx(idx + splitPasted.length - 1);
      return;
    }
    nextLines[idx] = value;
    patchNote({ body: nextLines.join('\n') });
  };

  const handleLineKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, idx: number) => {
    if (autocomplete && autocompleteItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % autocompleteItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + autocompleteItems.length) % autocompleteItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyAutocompleteItem(autocompleteItems[acIndex] || autocompleteItems[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAutocomplete(null);
        return;
      }
    }

    const line = lines[idx] || '';

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Auto-continue markdown bullets/tasks, or terminate list if current bullet is empty
      const emptyListMatch = line.match(/^\s*(?:[-*]\s*\[(?:[ /?xX]|D(?::[a-z]+)?)\]\s*|[-*]\s+)$/i);
      if (emptyListMatch) {
        const nextLines = [...lines];
        nextLines[idx] = '';
        patchNote({ body: nextLines.join('\n') });
        return;
      }

      let nextPrefix = '';
      if (/^\s*[-*]\s*\[[ /?xX]\]\s+/.test(line)) {
        nextPrefix = '- [ ] ';
      } else if (/^\s*[-*]\s+/.test(line)) {
        nextPrefix = '- ';
      }

      const pos = e.currentTarget.selectionStart ?? line.length;
      const before = line.slice(0, pos);
      const after = line.slice(pos);
      const nextLines = [...lines];
      nextLines.splice(idx, 1, before, `${nextPrefix}${after}`);
      patchNote({ body: nextLines.join('\n') });
      setActiveLineIdx(idx + 1);
      return;
    }

    if (e.key === 'Backspace' && line === '' && lines.length > 1) {
      e.preventDefault();
      const nextLines = [...lines];
      nextLines.splice(idx, 1);
      patchNote({ body: nextLines.join('\n') });
      setActiveLineIdx(Math.max(0, idx - 1));
      return;
    }

    if (e.key === 'ArrowUp' && (e.currentTarget.selectionStart ?? 0) === 0 && idx > 0) {
      e.preventDefault();
      setActiveLineIdx(idx - 1);
      return;
    }

    if (
      e.key === 'ArrowDown' &&
      (e.currentTarget.selectionStart ?? 0) >= line.length &&
      idx < lines.length - 1
    ) {
      e.preventDefault();
      setActiveLineIdx(idx + 1);
      return;
    }

    if (e.key === 'Escape') {
      setActiveLineIdx(null);
    }
  };

  const scopeSelectValue =
    note.scope === 'client' && note.clientId
      ? `client:${note.clientId}`
      : note.scope === 'internal'
      ? 'internal'
      : 'inbox';

  return (
    <div className="editor-scroll" onClick={() => setAutocomplete(null)}>
      <div className="editor-container">
        {/* Quick Starter & Outlook/Teams Invite Strip */}
        <div className="quick-starter-strip">
          <div className="quick-starter-group">
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)' }}>Quick Start:</span>
            {NOTE_TEMPLATES.filter((t) => t.id !== 'blank').map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className="btn btn-xs"
                onClick={() => handleApplyTemplate(tpl.id)}
              >
                <FilePlus2 size={12} />
                {tpl.label}
              </button>
            ))}
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => setShowInviteModal(true)}
              title="Paste calendar header or attendee list from Outlook or Microsoft Teams"
            >
              <MailPlus size={12} />
              Paste Teams / Outlook Invite
            </button>
          </div>
          <div className="quick-starter-group">
            <button
              id="btn-ai-structure"
              type="button"
              className="btn btn-xs btn-soft"
              onClick={onOpenAiStructure}
              title="Infer metadata, extract Tasks & Decisions, and preview structured cleanup"
            >
              <Sparkles size={12} />
              Structure &amp; Extract
            </button>
          </div>
        </div>

        {/* Note Title */}
        <h1>
          <input
            id="note-title-input"
            type="text"
            className="note-title-input"
            placeholder="Untitled note — start typing immediately…"
            value={note.title}
            onChange={(e) => patchNote({ title: e.target.value })}
          />
        </h1>

        {/* Structured Metadata Properties Grid */}
        <div className="meta-grid">
          <div className="meta-row">
            <span className="meta-label">
              <Calendar size={13} /> Date &amp; Space
            </span>
            <div className="meta-value">
              <input
                type="date"
                className="meta-date-input"
                value={note.date}
                onChange={(e) => patchNote({ date: e.target.value })}
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
                      patchNote({ projectId: e.target.value || null });
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
                        const cId = onAddClient(newClientName.trim());
                        patchNote({ scope: 'client', clientId: cId, projectId: null });
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
                        const pId = onAddProject(newProjectName.trim(), pScope, note.clientId);
                        patchNote({ projectId: pId });
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

          {/* Participants Row */}
          <div className="meta-row">
            <span className="meta-label" title="Meeting attendees (distinct from inline @mentions in the note body)">
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
                      patchNote({ participants: note.participants.filter((x) => x !== pName) });
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

          {/* Unified Labels Row (Header + Inline Rollup) */}
          <div className="meta-row">
            <span className="meta-label" title="Note-level labels plus any #labels typed inline in your note">
              <Hash size={13} /> Labels
            </span>
            <div className="meta-value">
              {combinedLabels.map((lbl) => {
                const isHeaderExplicit = note.labels.includes(lbl);
                return (
                  <span key={lbl} className="pill pill-label" onClick={() => onNavigateLabel(lbl)}>
                    #{lbl}
                    {isHeaderExplicit && (
                      <button
                        type="button"
                        className="pill-remove"
                        title="Remove header label"
                        onClick={(e) => {
                          e.stopPropagation();
                          patchNote({ labels: note.labels.filter((x) => x !== lbl) });
                        }}
                      >
                        <X size={11} />
                      </button>
                    )}
                  </span>
                );
              })}
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

        {/* Natural Name Detection Banner (when a known person is typed without @) */}
        {unlinkedPeople.length > 0 && (
          <div className="unlinked-banner no-print">
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
              <UserCheck size={14} />
              Recognized people in text:
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

        {/* Inline Insert & Mode Toolbar */}
        <div className="editor-toolbar">
          <div className="editor-toolbar-left">
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => appendBlockSnippet('- [ ] ')}
              title="Insert inline Task (- [ ])"
            >
              <CheckSquare size={13} /> + Task
            </button>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => appendBlockSnippet('- [D:agreed] ')}
              title="Insert inline Decision (- [D:agreed])"
            >
              <Gavel size={13} /> + Decision
            </button>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={onOpenQuickAsk}
              title="Ask across past notes and pull citations into this note"
            >
              <Link2 size={13} /> /Ask &amp; Pull Context
            </button>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 4 }}>
              Type <span className="kbd">@</span> person · <span className="kbd">#</span> label ·{' '}
              <span className="kbd">[[</span> note · <span className="kbd">/</span> commands
            </span>
          </div>

          <div className="editor-toolbar-right">
            <button
              type="button"
              className={`btn btn-xs ${rawMode ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => {
                setRawMode((v) => !v);
                setActiveLineIdx(null);
                setAutocomplete(null);
              }}
              title="Toggle between Interactive Hybrid Blocks and Raw Markdown"
            >
              {rawMode ? <Eye size={13} /> : <Code2 size={13} />}
              {rawMode ? 'Hybrid View' : 'Raw .md'}
            </button>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => onDeleteNote(note.id)}
              title="Delete note"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        {/* Editor Body: Raw Markdown Mode vs Hybrid Interactive Live-Preview */}
        {rawMode ? (
          <textarea
            ref={rawTextareaRef}
            className="raw-markdown-textarea"
            value={note.body}
            placeholder="Write plain Markdown… Use @[Name], #label, [[Note Title]], - [ ] Task, or - [D:agreed] Decision"
            onChange={(e) => {
              patchNote({ body: e.target.value });
              detectAutocomplete(e.target.value, e.target.selectionStart ?? 0, e.target);
            }}
          />
        ) : (
          <div
            className="hybrid-blocks"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setActiveLineIdx(lines.length - 1);
              }
            }}
          >
            {lines.map((line, idx) => {
              // Hide rationale sub-line when rendered inside parent Decision card (unless actively editing it)
              if (decisionsByLine.rationaleLines.has(idx) && activeLineIdx !== idx) {
                return null;
              }

              if (activeLineIdx === idx) {
                return (
                  <div key={idx} className="block-row" onClick={(e) => e.stopPropagation()}>
                    <textarea
                      ref={lineInputRef}
                      rows={1}
                      className="block-line-input"
                      value={line}
                      placeholder="Type notes, @person, #label, [[note]], or / for commands…"
                      onChange={(e) => {
                        e.target.style.height = 'auto';
                        e.target.style.height = `${e.target.scrollHeight}px`;
                        updateSingleLine(idx, e.target.value);
                        detectAutocomplete(e.target.value, e.target.selectionStart ?? 0, e.target);
                      }}
                      onKeyDown={(e) => handleLineKeyDown(e, idx)}
                      onBlur={() => {
                        setTimeout(() => {
                          setActiveLineIdx((curr) => (curr === idx ? null : curr));
                        }, 160);
                      }}
                    />
                  </div>
                );
              }

              // 1. Interactive Task Block
              const task = tasksByLine.get(idx);
              if (task) {
                const nextStatus = TASK_CYCLE[(TASK_CYCLE.indexOf(task.status) + 1) % TASK_CYCLE.length];
                return (
                  <div
                    key={idx}
                    className={`task-inline-card ${task.status === 'done' ? 'is-done' : ''}`}
                    onClick={() => setActiveLineIdx(idx)}
                  >
                    <div className="task-left">
                      <button
                        type="button"
                        className={`status-badge status-${task.status}`}
                        title={`Click to cycle status → ${nextStatus.toUpperCase()}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          patchNote({ body: updateTaskInBody(note.body, idx, { status: nextStatus }) });
                        }}
                      >
                        {task.status}
                      </button>
                      <span className="task-text">
                        <RichInlineText
                          text={task.text}
                          people={directory.people}
                          clients={directory.clients}
                          notes={allNotes}
                          onClickPerson={onNavigatePerson}
                          onClickLabel={onNavigateLabel}
                          onClickNoteLink={onNavigateOrCreateNoteByTitle}
                        />
                      </span>
                      {extractInlineLabelPills(line, onNavigateLabel)}
                    </div>
                    <div className="task-right">
                      {task.priority === 'high' && <span className="priority-high">!HIGH</span>}
                      {task.dueDate && <span className="due-chip">due {task.dueDate}</span>}
                    </div>
                  </div>
                );
              }

              // 2. Interactive Decision Block
              const decision = decisionsByLine.map.get(idx);
              if (decision) {
                const nextDecStatus =
                  DECISION_CYCLE[(DECISION_CYCLE.indexOf(decision.status) + 1) % DECISION_CYCLE.length];
                return (
                  <div key={idx} className="decision-inline-card" onClick={() => setActiveLineIdx(idx)}>
                    <div className="decision-main">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1 }}>
                        <button
                          type="button"
                          className={`status-badge decision-badge-${decision.status}`}
                          title={`Decision status (${decision.status}) — click to switch to ${nextDecStatus}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            patchNote({
                              body: updateDecisionInBody(note.body, idx, { status: nextDecStatus }),
                            });
                          }}
                        >
                          <Gavel size={11} /> {decision.status}
                        </button>
                        <span style={{ fontWeight: 550 }}>
                          <RichInlineText
                            text={decision.text}
                            people={directory.people}
                            clients={directory.clients}
                            notes={allNotes}
                            onClickPerson={onNavigatePerson}
                            onClickLabel={onNavigateLabel}
                            onClickNoteLink={onNavigateOrCreateNoteByTitle}
                          />
                        </span>
                        {extractInlineLabelPills(line, onNavigateLabel)}
                      </div>
                    </div>
                    {decision.rationale && (
                      <div
                        className="decision-rationale"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (decision.rationaleLineIndex !== null) {
                            setActiveLineIdx(decision.rationaleLineIndex);
                          }
                        }}
                      >
                        Rationale:{' '}
                        <RichInlineText
                          text={decision.rationale}
                          people={directory.people}
                          clients={directory.clients}
                          notes={allNotes}
                          onClickPerson={onNavigatePerson}
                          onClickLabel={onNavigateLabel}
                          onClickNoteLink={onNavigateOrCreateNoteByTitle}
                        />
                      </div>
                    )}
                  </div>
                );
              }

              // 3. Headings, Bullets, Quotes, and Paragraphs
              const trimmed = line.trim();
              if (!trimmed) {
                return (
                  <div key={idx} className="block-row" onClick={() => setActiveLineIdx(idx)}>
                    <div className="block-rendered">
                      {lines.length === 1 && (
                        <span className="block-empty-hint">
                          Click anywhere and start typing — use @person, #label, [[note]], or /task &amp; /decision…
                        </span>
                      )}
                    </div>
                  </div>
                );
              }

              if (trimmed.startsWith('### ')) {
                return (
                  <div key={idx} className="block-row" onClick={() => setActiveLineIdx(idx)}>
                    <div className="block-rendered block-h3">
                      <RichInlineText
                        text={trimmed.slice(4)}
                        people={directory.people}
                        clients={directory.clients}
                        notes={allNotes}
                        onClickPerson={onNavigatePerson}
                        onClickLabel={onNavigateLabel}
                        onClickNoteLink={onNavigateOrCreateNoteByTitle}
                      />
                    </div>
                  </div>
                );
              }

              if (trimmed.startsWith('## ')) {
                return (
                  <div key={idx} className="block-row" onClick={() => setActiveLineIdx(idx)}>
                    <div className="block-rendered block-h2">
                      <RichInlineText
                        text={trimmed.slice(3)}
                        people={directory.people}
                        clients={directory.clients}
                        notes={allNotes}
                        onClickPerson={onNavigatePerson}
                        onClickLabel={onNavigateLabel}
                        onClickNoteLink={onNavigateOrCreateNoteByTitle}
                      />
                    </div>
                  </div>
                );
              }

              if (trimmed.startsWith('# ')) {
                return (
                  <div key={idx} className="block-row" onClick={() => setActiveLineIdx(idx)}>
                    <div className="block-rendered block-h1">
                      <RichInlineText
                        text={trimmed.slice(2)}
                        people={directory.people}
                        clients={directory.clients}
                        notes={allNotes}
                        onClickPerson={onNavigatePerson}
                        onClickLabel={onNavigateLabel}
                        onClickNoteLink={onNavigateOrCreateNoteByTitle}
                      />
                    </div>
                  </div>
                );
              }

              if (/^[-*•]\s+/.test(trimmed)) {
                return (
                  <div key={idx} className="block-row" onClick={() => setActiveLineIdx(idx)}>
                    <div className="block-rendered block-bullet">
                      <span className="bullet-dot">•</span>
                      <span>
                        <RichInlineText
                          text={trimmed.replace(/^[-*•]\s+/, '')}
                          people={directory.people}
                          clients={directory.clients}
                          notes={allNotes}
                          onClickPerson={onNavigatePerson}
                          onClickLabel={onNavigateLabel}
                          onClickNoteLink={onNavigateOrCreateNoteByTitle}
                        />
                      </span>
                    </div>
                  </div>
                );
              }

              if (trimmed.startsWith('>')) {
                return (
                  <div key={idx} className="block-row" onClick={() => setActiveLineIdx(idx)}>
                    <div className="block-rendered block-quote">
                      <RichInlineText
                        text={trimmed.replace(/^>\s*/, '')}
                        people={directory.people}
                        clients={directory.clients}
                        notes={allNotes}
                        onClickPerson={onNavigatePerson}
                        onClickLabel={onNavigateLabel}
                        onClickNoteLink={onNavigateOrCreateNoteByTitle}
                      />
                    </div>
                  </div>
                );
              }

              return (
                <div key={idx} className="block-row" onClick={() => setActiveLineIdx(idx)}>
                  <div className="block-rendered">
                    <RichInlineText
                      text={line}
                      people={directory.people}
                      clients={directory.clients}
                      notes={allNotes}
                      onClickPerson={onNavigatePerson}
                      onClickLabel={onNavigateLabel}
                      onClickNoteLink={onNavigateOrCreateNoteByTitle}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Synced File Path Indicator */}
        <div
          style={{
            marginTop: 28,
            paddingTop: 10,
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 11.5,
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
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

      {/* Floating Autocomplete Popover */}
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
                placeholder={`Subject: Northstar Cloud Security Sync\nDate: 2026-11-06\nRequired: Sarah Chen <sarah.chen@northstarfin.com>; Marcus Weber <m.weber@northstarfin.com>`}
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
    </div>
  );
};

function extractInlineLabelPills(rawLine: string, onNavigateLabel: (lbl: string) => void): React.ReactNode[] {
  const pills: React.ReactNode[] = [];
  const rx = /(?:^|\s)#([\p{L}][\p{L}\p{N}_-]{1,38})/gu;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(rawLine)) !== null) {
    const lbl = m[1].toLowerCase();
    pills.push(
      <button
        key={`${m.index}-${lbl}`}
        type="button"
        className="pill pill-label"
        onClick={(e) => {
          e.stopPropagation();
          onNavigateLabel(lbl);
        }}
      >
        #{lbl}
      </button>
    );
  }
  return pills;
}
