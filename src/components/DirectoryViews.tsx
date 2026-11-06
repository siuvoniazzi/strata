import React, { useMemo, useState } from 'react';
import { Building2, Gavel, Plus, UserCheck } from 'lucide-react';
import type {
  DecisionStatus,
  Note,
  ParsedDecision,
  ParsedTask,
  Person,
  TaskStatus,
  WorkspaceDirectory,
} from '../types';
import { extractInlineMentions, parseNoteItems } from '../utils/markdown';

const TASK_CYCLE: TaskStatus[] = ['todo', 'doing', 'waiting', 'done'];
const DEC_CYCLE: DecisionStatus[] = ['agreed', 'proposed', 'superseded'];

export const TasksGlobalView: React.FC<{
  notes: Note[];
  directory: WorkspaceDirectory;
  onOpenNote: (noteId: string) => void;
  onUpdateTaskStatus: (task: ParsedTask, status: TaskStatus) => void;
}> = ({ notes, directory, onOpenNote, onUpdateTaskStatus }) => {
  const [statusFilter, setStatusFilter] = useState<'open' | TaskStatus | 'all'>('open');
  const [ownerFilter, setOwnerFilter] = useState('');

  const allTasks = useMemo(() => {
    const out: ParsedTask[] = [];
    for (const n of notes) {
      out.push(...parseNoteItems(n, directory.people).tasks);
    }
    return out.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  }, [notes, directory.people]);

  const filtered = allTasks.filter((t) => {
    if (statusFilter === 'open' && t.status === 'done') return false;
    if (statusFilter !== 'open' && statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (ownerFilter && (t.owner || '').toLowerCase() !== ownerFilter.toLowerCase()) return false;
    return true;
  });

  return (
    <div className="page-scroll">
      <div className="page-container">
        <div className="page-header">
          <div>
            <h1 className="page-h1">Tasks Across All Notes</h1>
            <p className="page-subtitle">
              Every inline checkbox stays two-way synced with its source Markdown note.
            </p>
          </div>
        </div>

        <div className="filter-bar">
          {(['open', 'todo', 'doing', 'waiting', 'done', 'all'] as const).map((st) => (
            <button
              key={st}
              type="button"
              className={`btn btn-xs ${statusFilter === st ? 'btn-primary' : ''}`}
              onClick={() => setStatusFilter(st)}
            >
              {st.toUpperCase()}
            </button>
          ))}
          <select
            className="meta-select"
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
          >
            <option value="">All @Owners</option>
            {directory.people.map((p) => (
              <option key={p.id} value={p.name}>
                @{p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="surface-panel">
          {filtered.length === 0 ? (
            <span style={{ color: 'var(--text-muted)' }}>No tasks match this filter.</span>
          ) : (
            filtered.map((t) => {
              const nextStatus = TASK_CYCLE[(TASK_CYCLE.indexOf(t.status) + 1) % TASK_CYCLE.length];
              return (
                <div
                  key={t.id}
                  className={`task-inline-card ${t.status === 'done' ? 'is-done' : ''}`}
                >
                  <div className="task-left">
                    <button
                      type="button"
                      className={`status-badge status-${t.status}`}
                      onClick={() => onUpdateTaskStatus(t, nextStatus)}
                    >
                      {t.status}
                    </button>
                    <span className="task-text">{t.text}</span>
                    {t.owner && <span className="pill pill-person">@{t.owner}</span>}
                  </div>
                  <div className="task-right">
                    {t.priority === 'high' && <span className="priority-high">!HIGH</span>}
                    {t.dueDate && <span className="due-chip">due {t.dueDate}</span>}
                    <button type="button" className="pill pill-link" onClick={() => onOpenNote(t.noteId)}>
                      ↗ {t.noteTitle}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export const DecisionsGlobalView: React.FC<{
  notes: Note[];
  directory: WorkspaceDirectory;
  onOpenNote: (noteId: string) => void;
  onUpdateDecisionStatus: (decision: ParsedDecision, status: DecisionStatus) => void;
}> = ({ notes, directory, onOpenNote, onUpdateDecisionStatus }) => {
  const [statusFilter, setStatusFilter] = useState<'all' | DecisionStatus>('all');

  const allDecisions = useMemo(() => {
    const out: ParsedDecision[] = [];
    for (const n of notes) {
      out.push(...parseNoteItems(n, directory.people).decisions);
    }
    return out.sort((a, b) => b.noteDate.localeCompare(a.noteDate));
  }, [notes, directory.people]);

  const filtered = allDecisions.filter((d) => statusFilter === 'all' || d.status === statusFilter);

  return (
    <div className="page-scroll">
      <div className="page-container">
        <div className="page-header">
          <div>
            <h1 className="page-h1">Decision Register</h1>
            <p className="page-subtitle">
              Chronological audit trail of agreed, proposed, and superseded decisions across clients and projects.
            </p>
          </div>
        </div>

        <div className="filter-bar">
          {(['all', 'agreed', 'proposed', 'superseded'] as const).map((st) => (
            <button
              key={st}
              type="button"
              className={`btn btn-xs ${statusFilter === st ? 'btn-primary' : ''}`}
              onClick={() => setStatusFilter(st)}
            >
              {st.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="surface-panel">
          {filtered.length === 0 ? (
            <span style={{ color: 'var(--text-muted)' }}>No decisions match this filter.</span>
          ) : (
            filtered.map((d) => {
              const nextStatus = DEC_CYCLE[(DEC_CYCLE.indexOf(d.status) + 1) % DEC_CYCLE.length];
              return (
                <div key={d.id} className="decision-inline-card">
                  <div className="decision-main">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className={`status-badge decision-badge-${d.status}`}
                        onClick={() => onUpdateDecisionStatus(d, nextStatus)}
                      >
                        <Gavel size={11} /> {d.status}
                      </button>
                      <span style={{ fontWeight: 550 }}>{d.text}</span>
                      {d.stakeholders.map((s) => (
                        <span key={s} className="pill pill-person">
                          @{s}
                        </span>
                      ))}
                    </div>
                    <button type="button" className="pill pill-link" onClick={() => onOpenNote(d.noteId)}>
                      ↗ {d.noteTitle} ({d.noteDate})
                    </button>
                  </div>
                  {d.rationale && <div className="decision-rationale">Rationale: {d.rationale}</div>}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export const PeopleDirectoryView: React.FC<{
  notes: Note[];
  directory: WorkspaceDirectory;
  onUpdatePerson: (updated: Person) => void;
  onCreatePerson: (person: Omit<Person, 'id'>) => void;
  onAddClient: (name: string, domain?: string) => string;
  onFilterNotesByPerson: (name: string) => void;
}> = ({ notes, directory, onUpdatePerson, onCreatePerson, onAddClient, onFilterNotesByPerson }) => {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [clientId, setClientId] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [newClientDomain, setNewClientDomain] = useState('');

  const statsByPerson = useMemo(() => {
    const map = new Map<string, { attended: number; mentioned: number; openTasks: number }>();
    for (const p of directory.people) {
      map.set(p.name.toLowerCase(), { attended: 0, mentioned: 0, openTasks: 0 });
    }
    for (const n of notes) {
      for (const part of n.participants) {
        const entry = map.get(part.toLowerCase());
        if (entry) entry.attended++;
      }
      for (const ment of extractInlineMentions(n.body, directory.people)) {
        const entry = map.get(ment.toLowerCase());
        if (entry) entry.mentioned++;
      }
      for (const t of parseNoteItems(n, directory.people).tasks) {
        if (t.status !== 'done' && t.owner) {
          const entry = map.get(t.owner.toLowerCase());
          if (entry) entry.openTasks++;
        }
      }
    }
    return map;
  }, [notes, directory.people]);

  const handleAddPersonSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreatePerson({
      name: name.trim(),
      role: role.trim() || undefined,
      email: email.trim() || undefined,
      clientId: clientId || null,
      isInternal: !clientId,
    });
    setName('');
    setRole('');
    setEmail('');
  };

  const handleAddClientSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newClientName.trim()) return;
    onAddClient(newClientName.trim(), newClientDomain.trim() || undefined);
    setNewClientName('');
    setNewClientDomain('');
  };

  return (
    <div className="page-scroll">
      <div className="page-container">
        <div className="page-header">
          <div>
            <h1 className="page-h1">People &amp; Clients Directory</h1>
            <p className="page-subtitle">
              Link contacts to Clients and email domains so Strata automatically recognizes names and infers note
              context.
            </p>
          </div>
        </div>

        {/* Add Person & Add Client Forms */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
          <form className="surface-panel" onSubmit={handleAddPersonSubmit}>
            <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <UserCheck size={15} /> Add Person
            </strong>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input
                type="text"
                className="form-input"
                placeholder="Full Name *"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                type="text"
                className="form-input"
                placeholder="Role / Title"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              />
              <input
                type="email"
                className="form-input"
                placeholder="Email (optional)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <select
                className="form-input"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              >
                <option value="">Internal / Unaffiliated</option>
                {directory.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>
              <Plus size={13} /> Save Person
            </button>
          </form>

          <form className="surface-panel" onSubmit={handleAddClientSubmit}>
            <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Building2 size={15} /> Add Client Organization
            </strong>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input
                type="text"
                className="form-input"
                placeholder="Client Name *"
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
              />
              <input
                type="text"
                className="form-input"
                placeholder="Email domain (e.g., acme.com)"
                value={newClientDomain}
                onChange={(e) => setNewClientDomain(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>
              <Plus size={13} /> Save Client
            </button>
          </form>
        </div>

        {/* People Table */}
        <div className="surface-panel">
          <strong>Recognized People ({directory.people.length})</strong>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {directory.people.map((person) => {
              const st = statsByPerson.get(person.name.toLowerCase()) || {
                attended: 0,
                mentioned: 0,
                openTasks: 0,
              };
              return (
                <div key={person.id} className="task-inline-card">
                  <div className="task-left" style={{ gap: 10 }}>
                    <button
                      type="button"
                      className="pill pill-person"
                      onClick={() => onFilterNotesByPerson(person.name)}
                    >
                      @{person.name}
                    </button>
                    <input
                      type="text"
                      className="meta-select"
                      placeholder="Role…"
                      value={person.role || ''}
                      onChange={(e) => onUpdatePerson({ ...person, role: e.target.value })}
                    />
                    <select
                      className="meta-select"
                      value={person.clientId || ''}
                      onChange={(e) =>
                        onUpdatePerson({ ...person, clientId: e.target.value || null, isInternal: !e.target.value })
                      }
                    >
                      <option value="">Internal</option>
                      {directory.clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="task-right" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    <span>{st.attended} attended</span> · <span>{st.mentioned} @mentions</span> ·{' '}
                    <span>{st.openTasks} open tasks</span>
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => onFilterNotesByPerson(person.name)}
                    >
                      View Notes
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
