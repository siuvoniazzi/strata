import React, { useMemo, useState } from 'react';
import {
  Building2,
  FolderKanban,
  Gavel,
  Hash,
  Plus,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import type {
  Client,
  DecisionStatus,
  Note,
  ParsedDecision,
  ParsedTask,
  Person,
  Project,
  TaskStatus,
  WorkspaceDirectory,
} from '../types';
import {
  extractInlineMentions,
  getAllNoteLabels,
  normalizeLabel,
  parseNoteItems,
} from '../utils/markdown';

const TASK_CYCLE: TaskStatus[] = ['todo', 'doing', 'waiting', 'done'];
const DEC_CYCLE: DecisionStatus[] = ['agreed', 'proposed', 'superseded'];

export const TasksGlobalView: React.FC<{
  notes: Note[];
  directory: WorkspaceDirectory;
  onOpenNote: (noteId: string) => void;
  onUpdateTaskStatus: (task: ParsedTask, status: TaskStatus) => void;
  onDeleteTask: (task: ParsedTask) => void;
}> = ({ notes, directory, onOpenNote, onUpdateTaskStatus, onDeleteTask }) => {
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
                    <button
                      type="button"
                      className="mini-icon-btn danger"
                      title="Delete task from source note"
                      onClick={() => onDeleteTask(t)}
                    >
                      <Trash2 size={13} />
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
  onDeleteDecision: (decision: ParsedDecision) => void;
}> = ({ notes, directory, onOpenNote, onUpdateDecisionStatus, onDeleteDecision }) => {
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1 }}>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <button type="button" className="pill pill-link" onClick={() => onOpenNote(d.noteId)}>
                        ↗ {d.noteTitle} ({d.noteDate})
                      </button>
                      <button
                        type="button"
                        className="mini-icon-btn danger"
                        title="Delete decision from source note"
                        onClick={() => onDeleteDecision(d)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
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
  allLabels: string[];
  onUpdatePerson: (updated: Person, previousName?: string) => void;
  onCreatePerson: (person: Omit<Person, 'id'>) => void;
  onDeletePerson: (personId: string) => void;
  onAddClient: (name: string, domain?: string) => string;
  onUpdateClient: (updated: Client) => void;
  onDeleteClient: (clientId: string) => void;
  onAddProject: (name: string, scope: 'client' | 'internal', clientId: string | null) => string;
  onUpdateProject: (updated: Project) => void;
  onDeleteProject: (projectId: string) => void;
  onAddLabel: (label: string) => void;
  onDeleteLabel: (label: string) => void;
  onFilterNotesByPerson: (name: string) => void;
  onFilterNotesByClient: (clientId: string) => void;
  onFilterNotesByProject: (project: Project) => void;
  onFilterNotesByLabel: (label: string) => void;
}> = ({
  notes,
  directory,
  allLabels,
  onUpdatePerson,
  onCreatePerson,
  onDeletePerson,
  onAddClient,
  onUpdateClient,
  onDeleteClient,
  onAddProject,
  onUpdateProject,
  onDeleteProject,
  onAddLabel,
  onDeleteLabel,
  onFilterNotesByPerson,
  onFilterNotesByClient,
  onFilterNotesByProject,
  onFilterNotesByLabel,
}) => {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [clientId, setClientId] = useState('');

  const [newClientName, setNewClientName] = useState('');
  const [newClientDomain, setNewClientDomain] = useState('');

  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectSpace, setNewProjectSpace] = useState<string>('internal');

  const [newLabelText, setNewLabelText] = useState('');

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

  const noteCountByLabel = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of notes) {
      for (const lbl of getAllNoteLabels(n)) {
        map.set(lbl, (map.get(lbl) || 0) + 1);
      }
    }
    return map;
  }, [notes]);

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

  const handleAddProjectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    if (newProjectSpace === 'internal') {
      onAddProject(newProjectName.trim(), 'internal', null);
    } else if (newProjectSpace.startsWith('client:')) {
      const cId = newProjectSpace.slice('client:'.length);
      onAddProject(newProjectName.trim(), 'client', cId);
    }
    setNewProjectName('');
  };

  const handleAddLabelSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const norm = normalizeLabel(newLabelText);
    if (!norm) return;
    onAddLabel(norm);
    setNewLabelText('');
  };

  return (
    <div className="page-scroll">
      <div className="page-container">
        <div className="page-header">
          <div>
            <h1 className="page-h1">Workspace Directory</h1>
            <p className="page-subtitle">
              Create, edit, or delete Clients, Projects, People, and #Labels across your workspace.
            </p>
          </div>
        </div>

        {/* Quick-Add Forms: Clients, Projects, People */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 14 }}>
          <form className="surface-panel" onSubmit={handleAddClientSubmit}>
            <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Building2 size={15} /> Add Client
            </strong>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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

          <form className="surface-panel" onSubmit={handleAddProjectSubmit}>
            <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <FolderKanban size={15} /> Add Project
            </strong>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                type="text"
                className="form-input"
                placeholder="Project Name *"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
              />
              <select
                className="form-input"
                value={newProjectSpace}
                onChange={(e) => setNewProjectSpace(e.target.value)}
              >
                <option value="internal">Internal Workspace</option>
                {directory.clients.map((c) => (
                  <option key={c.id} value={`client:${c.id}`}>
                    Client: {c.name}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>
              <Plus size={13} /> Save Project
            </button>
          </form>

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
        </div>

        {/* Clients Section */}
        <div className="surface-panel">
          <strong>Clients ({directory.clients.length})</strong>
          {directory.clients.length === 0 ? (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No clients yet — add a client above or directly inside any note.
            </span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {directory.clients.map((client) => {
                const projCount = directory.projects.filter((p) => p.clientId === client.id).length;
                const noteCount = notes.filter((n) => n.clientId === client.id).length;
                return (
                  <div key={client.id} className="task-inline-card">
                    <div className="task-left" style={{ gap: 10 }}>
                      <span className="client-dot" style={{ background: client.color }} />
                      <input
                        type="text"
                        className="meta-select"
                        style={{ fontWeight: 600, minWidth: 160 }}
                        value={client.name}
                        onChange={(e) => onUpdateClient({ ...client, name: e.target.value })}
                        aria-label="Client name"
                      />
                      <input
                        type="text"
                        className="meta-select"
                        placeholder="Email domain…"
                        value={client.domain || ''}
                        onChange={(e) =>
                          onUpdateClient({ ...client, domain: e.target.value.trim() || undefined })
                        }
                        aria-label="Client email domain"
                      />
                    </div>
                    <div className="task-right" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      <span>{projCount} project(s)</span> · <span>{noteCount} note(s)</span>
                      <button
                        type="button"
                        className="btn btn-xs"
                        onClick={() => onFilterNotesByClient(client.id)}
                      >
                        View Notes
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-danger-ghost"
                        title="Delete client (notes move safely to Inbox)"
                        onClick={() => onDeleteClient(client.id)}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Projects Section */}
        <div className="surface-panel">
          <strong>Projects ({directory.projects.length})</strong>
          {directory.projects.length === 0 ? (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No projects yet — add a Client or Internal project above or from the sidebar.
            </span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {directory.projects.map((proj) => {
                const noteCount = notes.filter((n) => n.projectId === proj.id).length;
                return (
                  <div key={proj.id} className="task-inline-card">
                    <div className="task-left" style={{ gap: 10 }}>
                      <input
                        type="text"
                        className="meta-select"
                        style={{ fontWeight: 600, minWidth: 170 }}
                        value={proj.name}
                        onChange={(e) => onUpdateProject({ ...proj, name: e.target.value })}
                        aria-label="Project name"
                      />
                      <select
                        className="meta-select"
                        value={proj.scope === 'client' && proj.clientId ? `client:${proj.clientId}` : 'internal'}
                        onChange={(e) => {
                          if (e.target.value === 'internal') {
                            onUpdateProject({ ...proj, scope: 'internal', clientId: null });
                          } else if (e.target.value.startsWith('client:')) {
                            onUpdateProject({
                              ...proj,
                              scope: 'client',
                              clientId: e.target.value.slice('client:'.length),
                            });
                          }
                        }}
                      >
                        <option value="internal">Internal Workspace</option>
                        {directory.clients.map((c) => (
                          <option key={c.id} value={`client:${c.id}`}>
                            Client: {c.name}
                          </option>
                        ))}
                      </select>
                      <select
                        className="meta-select"
                        value={proj.status}
                        onChange={(e) =>
                          onUpdateProject({
                            ...proj,
                            status: e.target.value as Project['status'],
                          })
                        }
                      >
                        <option value="active">Active</option>
                        <option value="on-hold">On Hold</option>
                        <option value="completed">Completed</option>
                      </select>
                    </div>
                    <div className="task-right" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      <span>{noteCount} note(s)</span>
                      <button
                        type="button"
                        className="btn btn-xs"
                        onClick={() => onFilterNotesByProject(proj)}
                      >
                        View Notes
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-danger-ghost"
                        title="Delete project"
                        onClick={() => onDeleteProject(proj.id)}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* People Section */}
        <div className="surface-panel">
          <strong>People ({directory.people.length})</strong>
          {directory.people.length === 0 ? (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No people in directory yet — type <code>@Name</code> in any note or add a person above.
            </span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {directory.people.map((person) => {
                const st = statsByPerson.get(person.name.toLowerCase()) || {
                  attended: 0,
                  mentioned: 0,
                  openTasks: 0,
                };
                return (
                  <div key={person.id} className="task-inline-card">
                    <div className="task-left" style={{ gap: 8 }}>
                      <input
                        type="text"
                        className="meta-select"
                        style={{ fontWeight: 600, minWidth: 140 }}
                        value={person.name}
                        onChange={(e) => onUpdatePerson({ ...person, name: e.target.value }, person.name)}
                        aria-label="Person name"
                      />
                      <input
                        type="text"
                        className="meta-select"
                        placeholder="Role…"
                        value={person.role || ''}
                        onChange={(e) => onUpdatePerson({ ...person, role: e.target.value })}
                      />
                      <input
                        type="email"
                        className="meta-select"
                        placeholder="Email…"
                        value={person.email || ''}
                        onChange={(e) => onUpdatePerson({ ...person, email: e.target.value || undefined })}
                      />
                      <select
                        className="meta-select"
                        value={person.clientId || ''}
                        onChange={(e) =>
                          onUpdatePerson({
                            ...person,
                            clientId: e.target.value || null,
                            isInternal: !e.target.value,
                          })
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
                      <button
                        type="button"
                        className="btn btn-xs btn-danger-ghost"
                        title="Delete person"
                        onClick={() => onDeletePerson(person.id)}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Topics & #Labels Section */}
        <div className="surface-panel">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Hash size={15} /> Topics &amp; #Labels ({allLabels.length})
            </strong>
            <form onSubmit={handleAddLabelSubmit} style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                className="meta-select"
                placeholder="New #label…"
                value={newLabelText}
                onChange={(e) => setNewLabelText(e.target.value)}
              />
              <button type="submit" className="btn btn-xs btn-primary">
                <Plus size={12} /> Add #Label
              </button>
            </form>
          </div>
          {allLabels.length === 0 ? (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No #labels yet — type <code>#topic</code> inline in any note or add one above.
            </span>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {allLabels.map((lbl) => {
                const count = noteCountByLabel.get(lbl) || 0;
                return (
                  <span key={lbl} className="pill pill-label" style={{ padding: '3px 9px', gap: 6 }}>
                    <span onClick={() => onFilterNotesByLabel(lbl)}>
                      #{lbl} <span style={{ opacity: 0.65 }}>({count})</span>
                    </span>
                    <button
                      type="button"
                      className="pill-remove"
                      title={`Delete #${lbl} from workspace`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteLabel(lbl);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
