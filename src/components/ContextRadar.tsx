import React, { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  CheckCircle2,
  Compass,
  Gavel,
  Loader2,
  MessageSquare,
  PanelRightClose,
  Send,
  Sparkles,
} from 'lucide-react';
import type {
  AiConfig,
  Note,
  ParsedTask,
  TaskStatus,
  WorkspaceDirectory,
} from '../types';
import { askWorkspaceWithAiOrFallback, formatAiEngineLabel } from '../utils/aiProvider';
import { computeContextRadar } from '../utils/contextEngine';
import {
  extractInlineMentions,
  formatPersonMention,
  parseNoteItems,
} from '../utils/markdown';
import { AiLoadingState } from './AiLoadingState';
import { RichInlineText } from './RichInlineText';
import { RichMarkdown } from './RichMarkdown';

interface ContextRadarProps {
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
  onToggleRemoteTaskStatus: (task: ParsedTask, nextStatus: TaskStatus) => void;
  onCollapse: () => void;
}

export const ContextRadar: React.FC<ContextRadarProps> = ({
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
  onToggleRemoteTaskStatus,
  onCollapse,
}) => {
  const [tab, setTab] = useState<'context' | 'ask' | 'outline'>('context');
  const [askQuery, setAskQuery] = useState('');
  const [askLoading, setAskLoading] = useState(false);
  const [askResult, setAskResult] = useState<{
    answerMarkdown: string;
    citedNotes: Note[];
    usedProvider: string;
  } | null>(null);

  React.useEffect(() => {
    if (requestedTab) {
      setTab(requestedTab);
      onClearRequestedTab?.();
    }
  }, [requestedTab, onClearRequestedTab]);

  const radar = useMemo(
    () => computeContextRadar(activeNote, allNotes, directory),
    [activeNote, allNotes, directory]
  );

  const currentItems = useMemo(
    () => parseNoteItems(activeNote, directory.people),
    [activeNote, directory.people]
  );

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
    <aside className="context-radar" aria-label="Context Radar">
      <div className="radar-header">
        <span className="radar-title">
          <Compass size={15} />
          Context Radar
        </span>
        <button
          type="button"
          className="btn btn-icon btn-ghost"
          title="Hide Context Radar"
          onClick={onCollapse}
        >
          <PanelRightClose size={15} />
        </button>
      </div>

      <div className="radar-tabs">
        <button
          type="button"
          className={`radar-tab ${tab === 'context' ? 'active' : ''}`}
          onClick={() => setTab('context')}
        >
          Related ({radar.relatedNotes.length})
        </button>
        <button
          type="button"
          className={`radar-tab ${tab === 'ask' ? 'active' : ''}`}
          onClick={() => setTab('ask')}
        >
          Ask / Pull
        </button>
        <button
          type="button"
          className={`radar-tab ${tab === 'outline' ? 'active' : ''}`}
          onClick={() => setTab('outline')}
        >
          In Note ({currentItems.tasks.length + currentItems.decisions.length})
        </button>
      </div>

      <div className="radar-scroll">
        {tab === 'context' && (
          <>
            {(radar.carryForwardTasks.length > 0 || radar.priorDecisions.length > 0) && (
              <div className="radar-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ fontSize: 12.5 }}>Meeting Prep Carry-Forward</strong>
                  <button type="button" className="btn btn-xs btn-soft" onClick={handlePullPrepBrief}>
                    <ArrowDownLeft size={12} /> Pull Prep Brief
                  </button>
                </div>
                <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  {radar.carryForwardTasks.length} open task(s) and {radar.priorDecisions.length} prior decision(s)
                  linked to this Client, Project, or Participants.
                </span>
              </div>
            )}

            {/* Carry-Forward Open Tasks */}
            <div>
              <div className="radar-section-title">
                <span>Open Tasks in Context ({radar.carryForwardTasks.length})</span>
              </div>
              {radar.carryForwardTasks.length === 0 ? (
                <div className="radar-card" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  No unresolved tasks from related past notes.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {radar.carryForwardTasks.slice(0, 6).map((t) => {
                    const inlineMentions = extractInlineMentions(t.text, directory.people);
                    const ownerAlreadyInline = Boolean(
                      t.owner &&
                        inlineMentions.some((m) => m.toLowerCase() === t.owner!.toLowerCase())
                    );
                    return (
                      <div key={t.id} className="radar-card">
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'flex-start' }}>
                          <span style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.45 }}>
                            {renderInline(t.text)}
                          </span>
                          <span className={`status-badge status-${t.status}`}>{t.status}</span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            fontSize: 11,
                            color: 'var(--text-muted)',
                            flexWrap: 'wrap',
                            gap: 4,
                          }}
                        >
                          <span>
                            {t.owner && !ownerAlreadyInline ? `@${t.owner} · ` : ''}
                            {t.dueDate ? `due ${t.dueDate} · ` : ''}
                            <button
                              type="button"
                              className="btn-ghost"
                              style={{ padding: 0, border: 'none', cursor: 'pointer', textDecoration: 'underline', fontSize: 11 }}
                              onClick={() => onOpenNote(t.noteId)}
                            >
                              {t.noteTitle}
                            </button>
                          </span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              type="button"
                              className="btn btn-xs"
                              title="Mark Done directly in source note"
                              onClick={() => onToggleRemoteTaskStatus(t, 'done')}
                            >
                              <CheckCircle2 size={11} /> Done
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs"
                              title="Carry task into current note"
                              onClick={() =>
                                onInsertIntoActiveNote(
                                  `- [ ] ${t.text}${
                                    t.owner && !ownerAlreadyInline
                                      ? ` ${formatPersonMention(t.owner)}`
                                      : ''
                                  }${t.dueDate ? ` due:${t.dueDate}` : ''} (from [[${t.noteTitle}]])`
                                )
                              }
                            >
                              <ArrowDownLeft size={11} /> Pull
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Prior Decisions */}
            {radar.priorDecisions.length > 0 && (
              <div>
                <div className="radar-section-title">
                  <span>Prior Decisions ({radar.priorDecisions.length})</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {radar.priorDecisions.slice(0, 5).map((d) => (
                    <div key={d.id} className="radar-card">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span className={`status-badge decision-badge-${d.status}`}>
                          <Gavel size={10} /> {d.status}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{d.noteDate}</span>
                      </div>
                      <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.45 }}>
                        {renderInline(d.text)}
                      </div>
                      {d.rationale && (
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                          Rationale: {renderInline(d.rationale)}
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          style={{ paddingLeft: 2 }}
                          onClick={() => onOpenNote(d.noteId)}
                        >
                          ↗ {d.noteTitle}
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs"
                          onClick={() =>
                            onInsertIntoActiveNote(
                              `> Prior Decision (${d.noteDate}, [[${d.noteTitle}]]): ${d.text}`
                            )
                          }
                        >
                          <ArrowDownLeft size={11} /> Cite
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Related Past Notes */}
            <div>
              <div className="radar-section-title">
                <span>Related Notes ({radar.relatedNotes.length})</span>
              </div>
              {radar.relatedNotes.length === 0 ? (
                <div className="radar-card" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  Add a Client, Project, @Participant, #label, or topic keywords to surface relevant past notes.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {radar.relatedNotes.map(({ note, reasons, snippet }) => (
                    <div key={note.id} className="radar-card">
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <button
                          type="button"
                          onClick={() => onOpenNote(note.id)}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            fontWeight: 600,
                            fontSize: 12.5,
                            textAlign: 'left',
                            cursor: 'pointer',
                            color: 'var(--accent-text)',
                          }}
                        >
                          {note.title || 'Untitled'}
                        </button>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                          {note.date}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                        {renderInline(snippet)}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 6,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {reasons.slice(0, 2).join(' · ')}
                        </span>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button
                            type="button"
                            className="btn btn-xs"
                            onClick={() => onInsertIntoActiveNote(`See [[${note.title}]] (${note.date})`)}
                          >
                            [[Link]]
                          </button>
                          <button
                            type="button"
                            className="btn btn-xs"
                            onClick={() =>
                              onInsertIntoActiveNote(`> From [[${note.title}]] (${note.date}): "${snippet}"`)
                            }
                          >
                            Quote
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
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
                    gap: 6,
                    fontSize: 11,
                    color: 'var(--text-muted)',
                  }}
                >
                  <span>
                    <Sparkles size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
                    {askResult.usedProvider}
                  </span>
                  <button
                    type="button"
                    className="btn btn-xs btn-soft"
                    onClick={() => onInsertIntoActiveNote(askResult.answerMarkdown)}
                  >
                    <ArrowDownLeft size={11} /> Insert into Note
                  </button>
                </div>

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
