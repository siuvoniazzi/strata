import React, { useMemo, useState } from 'react';
import {
  Check,
  Copy,
  FilePlus2,
  Gavel,
  Printer,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type {
  AiConfig,
  DecisionStatus,
  Note,
  ParsedDecision,
  ParsedTask,
  TaskStatus,
  WorkspaceDirectory,
} from '../types';
import { generateExecutiveBriefWithAiOrFallback } from '../utils/aiProvider';
import { extractInlineMentions, getAllNoteLabels, parseNoteItems } from '../utils/markdown';

interface ReportsViewProps {
  notes: Note[];
  directory: WorkspaceDirectory;
  allLabels: string[];
  aiConfig: AiConfig;
  initialLabelFilter?: string;
  initialClientFilter?: string;
  initialPersonFilter?: string;
  onOpenNote: (noteId: string) => void;
  onUpdateTaskStatus: (task: ParsedTask, status: TaskStatus) => void;
  onDeleteTask: (task: ParsedTask) => void;
  onUpdateDecisionStatus: (decision: ParsedDecision, status: DecisionStatus) => void;
  onDeleteDecision: (decision: ParsedDecision) => void;
  onSaveBriefAsNote: (title: string, body: string, clientId: string | null, projectId: string | null) => void;
}

const TASK_CYCLE: TaskStatus[] = ['todo', 'doing', 'waiting', 'done'];
const DEC_CYCLE: DecisionStatus[] = ['agreed', 'proposed', 'superseded'];

export const ReportsView: React.FC<ReportsViewProps> = ({
  notes,
  directory,
  allLabels,
  aiConfig,
  initialLabelFilter = '',
  initialClientFilter = '',
  initialPersonFilter = '',
  onOpenNote,
  onUpdateTaskStatus,
  onDeleteTask,
  onUpdateDecisionStatus,
  onDeleteDecision,
  onSaveBriefAsNote,
}) => {
  const [clientId, setClientId] = useState(initialClientFilter);
  const [projectId, setProjectId] = useState('');
  const [labelFilter, setLabelFilter] = useState(initialLabelFilter);
  const [personFilter, setPersonFilter] = useState(initialPersonFilter);
  const [topicQuery, setTopicQuery] = useState('');
  const [dateRange, setDateRange] = useState<'all' | '7d' | '30d'>('all');

  const [briefMarkdown, setBriefMarkdown] = useState<string | null>(null);
  const [briefProvider, setBriefProvider] = useState<string>('');
  const [generatingBrief, setGeneratingBrief] = useState(false);
  const [copied, setCopied] = useState<'teams' | 'md' | null>(null);

  const filteredData = useMemo(() => {
    const now = Date.now();
    const minTime =
      dateRange === '7d'
        ? now - 7 * 86400000
        : dateRange === '30d'
        ? now - 30 * 86400000
        : 0;

    const matchingNotes: Note[] = [];
    const matchingTasks: ParsedTask[] = [];
    const matchingDecisions: ParsedDecision[] = [];

    const qLower = topicQuery.trim().toLowerCase();

    for (const note of notes) {
      if (minTime > 0) {
        const t = new Date(`${note.date}T12:00:00`).getTime();
        if (!Number.isNaN(t) && t < minTime) continue;
      }
      if (clientId === '__internal__') {
        if (note.scope !== 'internal') continue;
      } else if (clientId === '__inbox__') {
        if (note.scope !== 'inbox') continue;
      } else if (clientId && note.clientId !== clientId) {
        continue;
      }
      if (projectId && note.projectId !== projectId) continue;

      const noteLabels = getAllNoteLabels(note);
      const notePeople = [
        ...note.participants,
        ...extractInlineMentions(note.body, directory.people),
      ];

      if (labelFilter && !noteLabels.includes(labelFilter)) continue;
      if (
        personFilter &&
        !notePeople.some((p) => p.toLowerCase() === personFilter.toLowerCase())
      ) {
        continue;
      }
      if (qLower) {
        const hay = `${note.title} ${note.body} ${noteLabels.join(' ')} ${notePeople.join(' ')}`.toLowerCase();
        if (!hay.includes(qLower)) continue;
      }

      matchingNotes.push(note);
      const items = parseNoteItems(note, directory.people);
      matchingTasks.push(...items.tasks);
      matchingDecisions.push(...items.decisions);
    }

    return { matchingNotes, matchingTasks, matchingDecisions };
  }, [notes, directory.people, clientId, projectId, labelFilter, personFilter, topicQuery, dateRange]);

  const reportHeading = useMemo(() => {
    const parts: string[] = [];
    if (clientId === '__internal__') {
      parts.push('Internal Workspace');
    } else if (clientId === '__inbox__') {
      parts.push('Inbox');
    } else if (clientId) {
      parts.push(directory.clients.find((c) => c.id === clientId)?.name || 'Client');
    }
    if (projectId) {
      parts.push(directory.projects.find((p) => p.id === projectId)?.name || 'Project');
    }
    if (labelFilter) parts.push(`#${labelFilter}`);
    if (personFilter) parts.push(`@${personFilter}`);
    if (topicQuery.trim()) parts.push(`Topic: "${topicQuery.trim()}"`);
    return parts.length > 0 ? `Report — ${parts.join(' · ')}` : 'Executive Workspace Report';
  }, [clientId, projectId, labelFilter, personFilter, topicQuery, directory.clients, directory.projects]);

  const handleGenerateBrief = async () => {
    setGeneratingBrief(true);
    try {
      const res = await generateExecutiveBriefWithAiOrFallback({
        heading: reportHeading,
        notes: filteredData.matchingNotes,
        tasks: filteredData.matchingTasks,
        decisions: filteredData.matchingDecisions,
        config: aiConfig,
      });
      setBriefMarkdown(res.markdown);
      setBriefProvider(res.usedProvider);
    } finally {
      setGeneratingBrief(false);
    }
  };

  const handleCopyForEmailTeams = async () => {
    const textSource =
      briefMarkdown ||
      (
        await generateExecutiveBriefWithAiOrFallback({
          heading: reportHeading,
          notes: filteredData.matchingNotes,
          tasks: filteredData.matchingTasks,
          decisions: filteredData.matchingDecisions,
          config: { ...aiConfig, provider: 'local' },
        })
      ).markdown;

    // Clean [[Note]] wiki brackets into crisp readable citations for Outlook / Teams
    const formattedForTeams = textSource.replace(/\[\[([^\]]+)\]\]/g, '"$1"');
    await navigator.clipboard.writeText(formattedForTeams);
    setCopied('teams');
    setTimeout(() => setCopied(null), 1800);
  };

  const handleCopyMarkdown = async () => {
    const textSource =
      briefMarkdown ||
      (
        await generateExecutiveBriefWithAiOrFallback({
          heading: reportHeading,
          notes: filteredData.matchingNotes,
          tasks: filteredData.matchingTasks,
          decisions: filteredData.matchingDecisions,
          config: { ...aiConfig, provider: 'local' },
        })
      ).markdown;
    await navigator.clipboard.writeText(textSource);
    setCopied('md');
    setTimeout(() => setCopied(null), 1800);
  };

  const openTasks = filteredData.matchingTasks.filter((t) => t.status !== 'done');
  const doneTasks = filteredData.matchingTasks.filter((t) => t.status === 'done');

  return (
    <div className="page-scroll">
      <div className="page-container">
        <div className="page-header">
          <div>
            <h1 className="page-h1">{reportHeading}</h1>
            <p className="page-subtitle">
              Live cross-note rollups for topics, tasks, decisions, clients, and stakeholders — plus 1-click executive
              narrative synthesis.
            </p>
          </div>
          <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleGenerateBrief}
              disabled={generatingBrief}
            >
              <Sparkles size={14} />
              {generatingBrief ? 'Synthesizing…' : 'Generate Narrative Brief'}
            </button>
            <button type="button" className="btn" onClick={handleCopyForEmailTeams}>
              {copied === 'teams' ? <Check size={14} /> : <Copy size={14} />}
              {copied === 'teams' ? 'Copied for Email/Teams!' : 'Copy for Email / Teams'}
            </button>
            <button type="button" className="btn" onClick={handleCopyMarkdown}>
              {copied === 'md' ? <Check size={14} /> : <Copy size={14} />}
              {copied === 'md' ? 'Copied .md' : 'Copy .md'}
            </button>
            <button type="button" className="btn" onClick={() => window.print()}>
              <Printer size={14} /> Print / PDF
            </button>
          </div>
        </div>

        {/* Multi-Dimensional Filter Bar */}
        <div className="filter-bar">
          <select
            className="meta-select"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              setProjectId('');
            }}
          >
            <option value="">All Clients &amp; Spaces</option>
            {directory.clients.map((c) => (
              <option key={c.id} value={c.id}>
                Client: {c.name}
              </option>
            ))}
            <option value="__internal__">Internal Workspace</option>
            <option value="__inbox__">Inbox (Unfiled)</option>
          </select>

          <select
            className="meta-select"
            value={projectId}
            disabled={clientId === '__inbox__'}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">All Projects</option>
            {directory.projects
              .filter((p) => {
                if (clientId === '__internal__') return p.scope === 'internal';
                if (clientId === '__inbox__') return false;
                return !clientId || p.clientId === clientId;
              })
              .map((p) => (
                <option key={p.id} value={p.id}>
                  Project: {p.name}
                </option>
              ))}
          </select>

          <select
            className="meta-select"
            value={labelFilter}
            onChange={(e) => setLabelFilter(e.target.value)}
          >
            <option value="">All #Labels / Topics</option>
            {allLabels.map((l) => (
              <option key={l} value={l}>
                #{l}
              </option>
            ))}
          </select>

          <select
            className="meta-select"
            value={personFilter}
            onChange={(e) => setPersonFilter(e.target.value)}
          >
            <option value="">All @People</option>
            {directory.people.map((p) => (
              <option key={p.id} value={p.name}>
                @{p.name}
              </option>
            ))}
          </select>

          <select
            className="meta-select"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as 'all' | '7d' | '30d')}
          >
            <option value="all">All Dates</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
          </select>

          <input
            type="text"
            className="form-input"
            style={{ padding: '4px 10px', fontSize: 12.5, minWidth: 190 }}
            placeholder="Free-text topic query (e.g., SSO, HIPAA)…"
            value={topicQuery}
            onChange={(e) => setTopicQuery(e.target.value)}
          />

          {(clientId || projectId || labelFilter || personFilter || topicQuery || dateRange !== 'all') && (
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => {
                setClientId('');
                setProjectId('');
                setLabelFilter('');
                setPersonFilter('');
                setTopicQuery('');
                setDateRange('all');
              }}
            >
              Reset Filters
            </button>
          )}
        </div>

        {/* Summary KPI Strip */}
        <div className="stat-strip">
          <div className="stat-box">
            <div className="stat-value">{filteredData.matchingNotes.length}</div>
            <div className="stat-label">Notes Matched</div>
          </div>
          <div className="stat-box">
            <div className="stat-value">{filteredData.matchingDecisions.length}</div>
            <div className="stat-label">Decisions Documented</div>
          </div>
          <div className="stat-box">
            <div className="stat-value">{openTasks.length}</div>
            <div className="stat-label">Open Action Items</div>
          </div>
          <div className="stat-box">
            <div className="stat-value">{doneTasks.length}</div>
            <div className="stat-label">Completed Tasks</div>
          </div>
        </div>

        {/* Generated Narrative Brief Panel */}
        {briefMarkdown && (
          <div className="surface-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <strong style={{ fontSize: 14 }}>
                Synthesized Executive Brief ({briefProvider})
              </strong>
              <div className="no-print" style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-xs btn-soft"
                  onClick={() =>
                    onSaveBriefAsNote(
                      `${reportHeading} (${new Date().toISOString().slice(0, 10)})`,
                      briefMarkdown,
                      clientId || null,
                      projectId || null
                    )
                  }
                >
                  <FilePlus2 size={12} /> Save Report as Note
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  onClick={() => setBriefMarkdown(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
            <div className="narrative-brief">{briefMarkdown}</div>
          </div>
        )}

        {/* Decisions Log Rollup */}
        <div className="surface-panel">
          <strong style={{ fontSize: 14.5 }}>
            Decisions Log ({filteredData.matchingDecisions.length})
          </strong>
          {filteredData.matchingDecisions.length === 0 ? (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No decisions match the active filters.
            </span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filteredData.matchingDecisions.map((d) => {
                const nextStatus = DEC_CYCLE[(DEC_CYCLE.indexOf(d.status) + 1) % DEC_CYCLE.length];
                return (
                  <div key={d.id} className="decision-inline-card">
                    <div className="decision-main">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className={`status-badge decision-badge-${d.status}`}
                          onClick={() => onUpdateDecisionStatus(d, nextStatus)}
                          title="Click to update status in source note"
                        >
                          <Gavel size={11} /> {d.status}
                        </button>
                        <span style={{ fontWeight: 550 }}>{d.text}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button
                          type="button"
                          className="pill pill-link"
                          onClick={() => onOpenNote(d.noteId)}
                        >
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
              })}
            </div>
          )}
        </div>

        {/* Tasks Rollup (Synced 2-way with Source Notes) */}
        <div className="surface-panel">
          <strong style={{ fontSize: 14.5 }}>
            Action Items Rollup ({openTasks.length} Open · {doneTasks.length} Done)
          </strong>
          {filteredData.matchingTasks.length === 0 ? (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No tasks match the active filters.
            </span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {filteredData.matchingTasks.map((t) => {
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
                        title="Click to update task status directly in source .md note"
                      >
                        {t.status}
                      </button>
                      <span className="task-text">{t.text}</span>
                      {t.owner && <span className="pill pill-person">@{t.owner}</span>}
                    </div>
                    <div className="task-right">
                      {t.priority === 'high' && <span className="priority-high">!HIGH</span>}
                      {t.dueDate && <span className="due-chip">due {t.dueDate}</span>}
                      <button
                        type="button"
                        className="pill pill-link"
                        onClick={() => onOpenNote(t.noteId)}
                      >
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
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
