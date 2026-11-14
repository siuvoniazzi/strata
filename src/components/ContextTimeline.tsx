import React, { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  Clock,
  Hash,
  History,
  Loader2,
  MessageSquare,
  PanelRightClose,
  Send,
  Sparkles,
  User,
} from 'lucide-react';
import type {
  AiConfig,
  AiPrivacyReport,
  Note,
  ParsedTask,
  RelatedNoteMatch,
  TaskStatus,
  WorkspaceDirectory,
} from '../types';
import { askWorkspaceWithAiOrFallback, formatAiEngineLabel } from '../utils/aiProvider';
import { computeContextRadar } from '../utils/contextEngine';
import {
  extractInlineLabels,
  extractInlineMentions,
  formatPersonMention,
  getAllNoteLabels,
  parseNoteItems,
  resolveKnownPersonName,
} from '../utils/markdown';
import { AiLoadingState } from './AiLoadingState';
import { AiPrivacyInlineControls, AiPrivacyPromptDrawer } from './AiPrivacyBadge';
import { RichInlineText } from './RichInlineText';
import { RichMarkdown } from './RichMarkdown';

interface ContextTimelineProps {
  activeNote: Note;
  allNotes: Note[];
  directory: WorkspaceDirectory;
  aiConfig: AiConfig;
  requestedTab?: 'context' | 'ask' | 'outline' | null;
  onClearRequestedTab?: () => void;
  onInsertIntoActiveNote: (markdownSnippet: string) => void;
  onOpenNote: (noteId: string) => void;
  onOpenNoteByTitle?: (noteTitle: string) => void;
  onSelectPerson?: (personName: string) => void;
  onSelectLabel?: (label: string) => void;
  onToggleRemoteTaskStatus?: (task: ParsedTask, nextStatus: TaskStatus) => void;
  onCollapse: () => void;
}

function getNoteCreationMs(note: Note): number {
  if (note.createdAt) {
    const parsed = Date.parse(note.createdAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (note.date) {
    const parsed = Date.parse(`${note.date}T12:00:00`);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function formatCreationPoint(
  note: Note,
  referenceMs: number
): { dateLabel: string; timeLabel: string | null; relativeLabel: string } {
  const ms = getNoteCreationMs(note);
  const d = new Date(ms || Date.now());
  const refDate = new Date(referenceMs || Date.now());
  const sameYear = d.getFullYear() === refDate.getFullYear();

  const dateLabel = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });

  const hasExplicitCreatedAt = Boolean(note.createdAt && !Number.isNaN(Date.parse(note.createdAt)));
  const timeLabel = hasExplicitCreatedAt
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
    : null;

  const diffDays = Math.round((referenceMs - ms) / (1000 * 60 * 60 * 24));
  let relativeLabel = 'Same day';
  if (diffDays === 1) relativeLabel = '1d ago';
  else if (diffDays > 1 && diffDays < 14) relativeLabel = `${diffDays}d ago`;
  else if (diffDays >= 14 && diffDays < 60) relativeLabel = `${Math.round(diffDays / 7)}w ago`;
  else if (diffDays >= 60 && diffDays < 365) relativeLabel = `${Math.round(diffDays / 30)}mo ago`;
  else if (diffDays >= 365) relativeLabel = `${Math.round(diffDays / 365)}y ago`;
  else if (diffDays < 0) relativeLabel = `+${Math.abs(diffDays)}d`;

  return { dateLabel, timeLabel, relativeLabel };
}

function formatGapLabel(newerMs: number, olderMs: number): string | null {
  const diffDays = Math.round((newerMs - olderMs) / (1000 * 60 * 60 * 24));
  if (diffDays < 2) return null;
  if (diffDays < 14) return `${diffDays} days earlier`;
  if (diffDays < 60) return `${Math.round(diffDays / 7)} weeks earlier`;
  if (diffDays < 365) return `${Math.round(diffDays / 30)} months earlier`;
  return `${Math.round(diffDays / 365)} years earlier`;
}

function collectNotePersons(note: Note, knownPeople: WorkspaceDirectory['people']): string[] {
  const byLower = new Map<string, string>();
  const rawPeople = [
    ...note.participants,
    ...extractInlineMentions(`${note.title}\n${note.body}`, knownPeople),
  ];
  for (const raw of rawPeople) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const resolved = resolveKnownPersonName(trimmed, knownPeople);
    const key = resolved.toLowerCase();
    if (!byLower.has(key)) {
      byLower.set(key, resolved);
    }
  }
  return Array.from(byLower.values());
}

function collectAllLabels(note: Note): string[] {
  return Array.from(new Set([...getAllNoteLabels(note), ...extractInlineLabels(note.title)]));
}

interface TimelineEntryData {
  match: RelatedNoteMatch;
  creationMs: number;
  dateLabel: string;
  timeLabel: string | null;
  relativeLabel: string;
  labels: string[];
  persons: string[];
  gapFromPrevious: string | null;
}

export const ContextTimeline: React.FC<ContextTimelineProps> = ({
  activeNote,
  allNotes,
  directory,
  aiConfig,
  requestedTab,
  onClearRequestedTab,
  onInsertIntoActiveNote,
  onOpenNote,
  onOpenNoteByTitle,
  onSelectPerson,
  onSelectLabel,
  onCollapse,
}) => {
  const [localTab, setLocalTab] = useState<'timeline' | 'ask' | 'outline'>('timeline');
  const tab = requestedTab
    ? requestedTab === 'context'
      ? 'timeline'
      : requestedTab
    : localTab;

  const handleSelectTab = (next: 'timeline' | 'ask' | 'outline') => {
    onClearRequestedTab?.();
    setLocalTab(next);
  };

  const [askQuery, setAskQuery] = useState('');
  const [askLoading, setAskLoading] = useState(false);
  const [showAskPrivacyPrompt, setShowAskPrivacyPrompt] = useState(false);
  const [askResult, setAskResult] = useState<{
    answerMarkdown: string;
    citedNotes: Note[];
    usedProvider: string;
    privacyReport?: AiPrivacyReport;
  } | null>(null);

  const radar = useMemo(
    () => computeContextRadar(activeNote, allNotes, directory),
    [activeNote, allNotes, directory]
  );

  const currentItems = useMemo(
    () => parseNoteItems(activeNote, directory.people),
    [activeNote, directory.people]
  );

  const activeCreationMs = useMemo(() => getNoteCreationMs(activeNote), [activeNote]);

  const timelineEntries = useMemo<TimelineEntryData[]>(() => {
    const sorted = [...radar.relatedNotes].sort(
      (a, b) => getNoteCreationMs(b.note) - getNoteCreationMs(a.note)
    );

    let prevMs = activeCreationMs;
    return sorted.map((match) => {
      const creationMs = getNoteCreationMs(match.note);
      const { dateLabel, timeLabel, relativeLabel } = formatCreationPoint(
        match.note,
        activeCreationMs
      );
      const gapFromPrevious = formatGapLabel(prevMs, creationMs);
      prevMs = creationMs;

      return {
        match,
        creationMs,
        dateLabel,
        timeLabel,
        relativeLabel,
        labels: collectAllLabels(match.note),
        persons: collectNotePersons(match.note, directory.people),
        gapFromPrevious,
      };
    });
  }, [radar.relatedNotes, activeCreationMs, directory.people]);

  const handleOpenNoteLink = (targetTitle: string) => {
    if (onOpenNoteByTitle) {
      onOpenNoteByTitle(targetTitle);
      return;
    }
    const found = allNotes.find((n) => n.title.toLowerCase() === targetTitle.toLowerCase());
    if (found) onOpenNote(found.id);
  };

  const renderInline = (text: string) => (
    <RichInlineText
      text={text}
      people={directory.people}
      clients={directory.clients}
      notes={allNotes}
      onClickPerson={onSelectPerson}
      onClickLabel={onSelectLabel}
      onClickNoteLink={handleOpenNoteLink}
    />
  );

  const handlePullPrepBrief = () => {
    const lines: string[] = ['## Carry-Forward Context & Prep'];
    if (radar.priorDecisions.length > 0) {
      lines.push('### Recent Decisions');
      for (const d of radar.priorDecisions.slice(0, 3)) {
        lines.push(`- Ref [${d.status.toUpperCase()}]: ${d.text} (from [[${d.noteTitle}]])`);
      }
    }
    if (radar.carryForwardTasks.length > 0) {
      lines.push('### Open Follow-Ups');
      for (const t of radar.carryForwardTasks.slice(0, 5)) {
        const ownerPart = t.owner ? ` ${formatPersonMention(t.owner)}` : '';
        const duePart = t.dueDate ? ` due:${t.dueDate}` : '';
        lines.push(`- [ ] ${t.text}${ownerPart}${duePart} (from [[${t.noteTitle}]])`);
      }
    }
    onInsertIntoActiveNote(lines.join('\n'));
  };

  const executeAsk = async (rawQuery: string) => {
    const trimmed = rawQuery.trim();
    if (!trimmed) return;
    setAskLoading(true);
    try {
      const res = await askWorkspaceWithAiOrFallback(trimmed, allNotes, directory, aiConfig);
      setAskResult(res);
    } finally {
      setAskLoading(false);
    }
  };

  const handleRunAsk = async (e?: React.FormEvent) => {
    e?.preventDefault();
    await executeAsk(askQuery);
  };

  return (
    <aside className="context-radar context-timeline" aria-label="Related Notes Timeline">
      <div className="radar-header">
        <span className="radar-title">
          <History size={15} />
          Timeline
          {timelineEntries.length > 0 && (
            <span className="timeline-count-badge">{timelineEntries.length}</span>
          )}
        </span>
        <button
          type="button"
          className="btn btn-icon btn-ghost"
          title="Hide Timeline"
          onClick={onCollapse}
        >
          <PanelRightClose size={15} />
        </button>
      </div>

      <div className="radar-tabs">
        <button
          type="button"
          className={`radar-tab ${tab === 'timeline' ? 'active' : ''}`}
          onClick={() => handleSelectTab('timeline')}
        >
          Timeline ({timelineEntries.length})
        </button>
        <button
          type="button"
          className={`radar-tab ${tab === 'ask' ? 'active' : ''}`}
          onClick={() => handleSelectTab('ask')}
        >
          Ask / Pull
        </button>
        <button
          type="button"
          className={`radar-tab ${tab === 'outline' ? 'active' : ''}`}
          onClick={() => handleSelectTab('outline')}
        >
          In Note ({currentItems.tasks.length + currentItems.decisions.length})
        </button>
      </div>

      <div className="radar-scroll timeline-scroll">
        {tab === 'timeline' && (
          <>
            {(radar.carryForwardTasks.length > 0 || radar.priorDecisions.length > 0) && (
              <div className="timeline-prep-strip">
                <span className="timeline-prep-text">
                  {radar.carryForwardTasks.length} open task(s) · {radar.priorDecisions.length} decision(s)
                </span>
                <button type="button" className="btn btn-xs btn-soft" onClick={handlePullPrepBrief}>
                  <ArrowDownLeft size={12} /> Pull Prep
                </button>
              </div>
            )}

            <div className="timeline-track">
              <div className="timeline-spine" aria-hidden="true" />

              {/* Top Anchor: Current / Active Note */}
              <div className="timeline-anchor-now">
                <span className="timeline-anchor-dot" aria-hidden="true" />
                <div className="timeline-anchor-label">
                  <span className="timeline-anchor-tag">Active Note</span>
                  <span className="timeline-anchor-date">{activeNote.date}</span>
                </div>
              </div>

              {timelineEntries.length === 0 ? (
                <div className="timeline-empty-state">
                  <Clock size={18} className="timeline-empty-icon" />
                  <div className="timeline-empty-title">No related notes on timeline yet</div>
                  <p className="timeline-empty-desc">
                    Add a <strong>#label</strong>, <strong>@person</strong>, or{' '}
                    <strong>[[note link]]</strong> — qualifying past notes will flow up to their
                    creation point here.
                  </p>
                </div>
              ) : (
                <div className="timeline-entries">
                  {timelineEntries.map((entry, idx) => {
                    const { note, reasons, snippet } = entry.match;
                    const client = note.clientId
                      ? directory.clients.find((c) => c.id === note.clientId)
                      : undefined;

                    return (
                      <React.Fragment key={`${activeNote.id}-${note.id}`}>
                        {entry.gapFromPrevious && (
                          <div className="timeline-gap-row">
                            <span className="timeline-gap-tick" aria-hidden="true" />
                            <span className="timeline-gap-chip">{entry.gapFromPrevious}</span>
                          </div>
                        )}

                        <div className="timeline-entry">
                          {/* Reference point on the vertical timeline spine */}
                          <div
                            className="timeline-node-col"
                            style={{ animationDelay: `${Math.min(idx, 10) * 80 + 750}ms` }}
                            aria-hidden="true"
                          >
                            <span className="timeline-node">
                              <span
                                className="timeline-node-ring"
                                style={{ animationDelay: `${Math.min(idx, 10) * 80 + 850}ms` }}
                              />
                            </span>
                            <span className="timeline-connector" />
                          </div>

                          {/* Note Object flowing to its creation point */}
                          <div
                            className="timeline-entry-body"
                            style={{ animationDelay: `${Math.min(idx, 10) * 80}ms` }}
                          >
                            <div className="timeline-point-meta">
                              <span className="timeline-point-date">
                                {entry.dateLabel}
                                {entry.timeLabel ? ` · ${entry.timeLabel}` : ''}
                              </span>
                              <span className="timeline-point-rel">{entry.relativeLabel}</span>
                            </div>

                            <article
                              className="timeline-note-card"
                              style={{ animationDelay: `${Math.min(idx, 10) * 80}ms` }}
                            >
                              <div className="timeline-card-header">
                                <button
                                  type="button"
                                  className="timeline-note-title"
                                  onClick={() => onOpenNote(note.id)}
                                  title={`Open "${note.title || 'Untitled'}"`}
                                >
                                  {client && (
                                    <span
                                      className="timeline-client-dot"
                                      style={{ backgroundColor: client.color }}
                                      title={client.name}
                                    />
                                  )}
                                  <span>{note.title || 'Untitled'}</span>
                                </button>
                              </div>

                              {/* Persons */}
                              {entry.persons.length > 0 && (
                                <div className="timeline-meta-row" aria-label="People">
                                  {entry.persons.map((person) => (
                                    <button
                                      key={person}
                                      type="button"
                                      className="pill pill-person timeline-pill"
                                      onClick={() => onSelectPerson?.(person)}
                                      title={`Filter or view ${person}`}
                                    >
                                      <User size={10} />
                                      <span>{person}</span>
                                    </button>
                                  ))}
                                </div>
                              )}

                              {/* Labels */}
                              {entry.labels.length > 0 && (
                                <div className="timeline-meta-row" aria-label="Labels">
                                  {entry.labels.map((label) => (
                                    <button
                                      key={label}
                                      type="button"
                                      className="pill pill-label timeline-pill"
                                      onClick={() => onSelectLabel?.(label)}
                                      title={`View #${label}`}
                                    >
                                      <Hash size={10} />
                                      <span>{label}</span>
                                    </button>
                                  ))}
                                </div>
                              )}

                              <div className="timeline-card-footer">
                                <span className="timeline-reasons" title={reasons.join(' · ')}>
                                  {reasons.slice(0, 2).join(' · ')}
                                </span>
                                <div className="timeline-card-actions">
                                  <button
                                    type="button"
                                    className="btn btn-xs"
                                    onClick={() =>
                                      onInsertIntoActiveNote(`See [[${note.title}]] (${note.date})`)
                                    }
                                    title="Insert [[link]] into active note"
                                  >
                                    [[Link]]
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-xs"
                                    onClick={() =>
                                      onInsertIntoActiveNote(
                                        `> From [[${note.title}]] (${note.date}): "${snippet}"`
                                      )
                                    }
                                    title="Quote snippet into active note"
                                  >
                                    Quote
                                  </button>
                                </div>
                              </div>
                            </article>
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'ask' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <form
              onSubmit={handleRunAsk}
              aria-busy={askLoading}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                <MessageSquare size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />
                Ask across all notes &amp; pull into active note
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  id="radar-ask-input"
                  type="text"
                  className="form-input"
                  style={{ flex: 1, fontSize: 12.5 }}
                  placeholder="e.g., What decisions or blockers came up recently?"
                  value={askQuery}
                  onChange={(e) => setAskQuery(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={askLoading || !askQuery.trim()}
                  title={askLoading ? 'AI request in progress…' : 'Ask workspace'}
                  aria-label={askLoading ? 'AI request in progress' : 'Ask workspace'}
                >
                  {askLoading ? <Loader2 size={13} className="ai-spin" /> : <Send size={13} />}
                </button>
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {['Recent decisions', 'Open high priority tasks', 'Unresolved blockers'].map((preset) => {
                  const isRunningPreset = askLoading && askQuery === preset;
                  return (
                    <button
                      key={preset}
                      type="button"
                      className={`btn btn-xs ${isRunningPreset ? 'btn-soft' : 'btn-ghost'}`}
                      disabled={askLoading}
                      onClick={() => {
                        setAskQuery(preset);
                        executeAsk(preset);
                      }}
                    >
                      {isRunningPreset && <Loader2 size={11} className="ai-spin" />}
                      {preset}
                    </button>
                  );
                })}
              </div>
            </form>

            {askLoading && (
              <AiLoadingState
                compact
                title="Synthesizing answer across workspace notes…"
                subtitle="Scanning matching notes, tasks, and decisions"
                providerLabel={formatAiEngineLabel(aiConfig)}
              />
            )}

            {!askLoading && askResult && (
              <div className="radar-card" style={{ gap: 10 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 6,
                    fontSize: 11,
                    color: 'var(--text-muted)',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span>
                      <Sparkles size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
                      {askResult.usedProvider}
                    </span>
                    <AiPrivacyInlineControls
                      report={askResult.privacyReport}
                      isOpen={showAskPrivacyPrompt}
                      onToggleOpen={() => setShowAskPrivacyPrompt((v) => !v)}
                      compact
                    />
                  </span>
                  <button
                    type="button"
                    className="btn btn-xs btn-soft"
                    onClick={() => onInsertIntoActiveNote(askResult.answerMarkdown)}
                  >
                    <ArrowDownLeft size={11} /> Insert into Note
                  </button>
                </div>

                <AiPrivacyPromptDrawer
                  report={askResult.privacyReport}
                  isOpen={showAskPrivacyPrompt}
                />

                <RichMarkdown
                  markdown={askResult.answerMarkdown}
                  people={directory.people}
                  clients={directory.clients}
                  notes={allNotes}
                  compact
                  onClickPerson={onSelectPerson}
                  onClickLabel={onSelectLabel}
                  onClickNoteLink={handleOpenNoteLink}
                />

                {askResult.citedNotes.length > 0 && (
                  <div className="radar-cited-sources">
                    <span className="radar-cited-label">Sources</span>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {askResult.citedNotes.map((cn) => (
                        <button
                          key={cn.id}
                          type="button"
                          className="pill pill-link"
                          onClick={() => onOpenNote(cn.id)}
                        >
                          ↗ {cn.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'outline' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div className="radar-section-title">Decisions in This Note ({currentItems.decisions.length})</div>
              {currentItems.decisions.length === 0 ? (
                <div className="radar-card" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  No decisions recorded yet. Type <span className="kbd">/decision</span> or click{' '}
                  <strong>+ Decision</strong>.
                </div>
              ) : (
                currentItems.decisions.map((d) => (
                  <div key={d.id} className="radar-card" style={{ marginBottom: 6 }}>
                    <span className={`status-badge decision-badge-${d.status}`} style={{ alignSelf: 'flex-start' }}>
                      {d.status}
                    </span>
                    <span style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.45 }}>
                      {renderInline(d.text)}
                    </span>
                    {d.rationale && (
                      <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                        Rationale: {renderInline(d.rationale)}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>

            <div>
              <div className="radar-section-title">Tasks in This Note ({currentItems.tasks.length})</div>
              {currentItems.tasks.length === 0 ? (
                <div className="radar-card" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  No tasks recorded yet. Type <span className="kbd">/task</span> or <span className="kbd">- [ ]</span>.
                </div>
              ) : (
                currentItems.tasks.map((t) => {
                  const inlineMentions = extractInlineMentions(t.text, directory.people);
                  const ownerAlreadyInline = Boolean(
                    t.owner &&
                      inlineMentions.some((m) => m.toLowerCase() === t.owner!.toLowerCase())
                  );
                  const showMetaRow = Boolean((t.owner && !ownerAlreadyInline) || t.dueDate);
                  return (
                    <div key={t.id} className="radar-card" style={{ marginBottom: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'flex-start' }}>
                        <span style={{ fontSize: 12.5, lineHeight: 1.45 }}>{renderInline(t.text)}</span>
                        <span className={`status-badge status-${t.status}`}>{t.status}</span>
                      </div>
                      {showMetaRow && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {[
                            t.owner && !ownerAlreadyInline ? `@${t.owner}` : null,
                            t.dueDate ? `due ${t.dueDate}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
