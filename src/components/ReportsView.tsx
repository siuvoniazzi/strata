import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarCheck,
  Check,
  Clock,
  Copy,
  ExternalLink,
  FilePlus2,
  FileText,
  Filter,
  Gavel,
  Loader2,
  Printer,
  RefreshCw,
  Sparkles,
  Sun,
  Trash2,
} from 'lucide-react';
import type {
  AiConfig,
  AiPrivacyReport,
  DecisionStatus,
  Note,
  ParsedDecision,
  ParsedTask,
  TaskStatus,
  WorkspaceDirectory,
} from '../types';
import { formatAiEngineLabel, generateExecutiveBriefWithAiOrFallback } from '../utils/aiProvider';
import { buildDeterministicExecutiveBrief } from '../utils/contextEngine';
import {
  buildDeterministicDailyBriefing,
  computeDailyBriefingData,
  DAILY_BRIEFING_NOTE_ID,
  formatHumanDate,
  getTodayDateString,
  type PersistedDailyBriefingState,
} from '../utils/dailyBriefing';
import {
  extractInlineMentions,
  getAllNoteLabels,
  isDailyBriefingNote,
  parseNoteItems,
  stripMarkdownFormatting,
} from '../utils/markdown';
import { AiLoadingState } from './AiLoadingState';
import { AiPrivacyInlineControls, AiPrivacyPromptDrawer } from './AiPrivacyBadge';
import { RichInlineText } from './RichInlineText';
import { RichMarkdown } from './RichMarkdown';

export type ReportsHubMode = 'daily' | 'explorer';

interface ReportsViewProps {
  notes: Note[];
  directory: WorkspaceDirectory;
  allLabels: string[];
  aiConfig: AiConfig;
  initialMode?: ReportsHubMode;
  initialLabelFilter?: string;
  initialClientFilter?: string;
  initialPersonFilter?: string;
  embeddedInOverlay?: boolean;
  activeEditorNoteId?: string;
  dailyBriefingState?: PersistedDailyBriefingState | null;
  isRefreshingDailyBriefing?: boolean;
  onRefreshDailyBriefing?: (recentWindowDays?: number) => Promise<void>;
  onOpenDailyReportNote?: () => void;
  onModeChange?: (mode: ReportsHubMode) => void;
  onOpenNote: (noteId: string) => void;
  onOpenNoteByTitle?: (noteTitle: string) => void;
  onUpdateTaskStatus: (task: ParsedTask, status: TaskStatus) => void;
  onDeleteTask: (task: ParsedTask) => void;
  onUpdateDecisionStatus: (decision: ParsedDecision, status: DecisionStatus) => void;
  onDeleteDecision: (decision: ParsedDecision) => void;
  onSaveBriefAsNote: (title: string, body: string, clientId: string | null, projectId: string | null) => void;
}

const TASK_CYCLE: TaskStatus[] = ['todo', 'doing', 'waiting', 'done'];
const DEC_CYCLE: DecisionStatus[] = ['agreed', 'proposed', 'superseded'];

function subtractDaysIso(baseDateStr: string, days: number): string {
  const d = new Date(`${baseDateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '0000-01-01';
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export const ReportsView: React.FC<ReportsViewProps> = ({
  notes,
  directory,
  allLabels,
  aiConfig,
  initialMode,
  initialLabelFilter = '',
  initialClientFilter = '',
  initialPersonFilter = '',
  embeddedInOverlay = false,
  activeEditorNoteId,
  dailyBriefingState = null,
  isRefreshingDailyBriefing = false,
  onRefreshDailyBriefing,
  onOpenDailyReportNote,
  onModeChange,
  onOpenNote,
  onOpenNoteByTitle,
  onUpdateTaskStatus,
  onDeleteTask,
  onUpdateDecisionStatus,
  onDeleteDecision,
  onSaveBriefAsNote,
}) => {
  const hasSpecificInitialFilter = Boolean(
    initialLabelFilter || initialClientFilter || initialPersonFilter
  );

  const [hubMode, setHubMode] = useState<ReportsHubMode>(() => {
    if (initialMode) return initialMode;
    if (embeddedInOverlay || hasSpecificInitialFilter) return 'explorer';
    return 'daily';
  });

  const switchHubMode = (nextMode: ReportsHubMode) => {
    setHubMode(nextMode);
    onModeChange?.(nextMode);
  };

  // Daily Briefing local controls
  const [dailyWindowDays, setDailyWindowDays] = useState<number>(7);
  const [dailyTaskTab, setDailyTaskTab] = useState<'focus' | 'urgent' | 'all' | 'done'>('focus');
  const [dailyCopied, setDailyCopied] = useState(false);

  const allPeopleNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of directory.people) {
      map.set(p.name.toLowerCase(), p.name);
    }
    for (const n of notes) {
      if (isDailyBriefingNote(n)) continue;
      for (const part of n.participants) {
        const key = part.trim().toLowerCase();
        if (key && !map.has(key)) map.set(key, part.trim());
      }
      for (const ment of extractInlineMentions(n.body, directory.people)) {
        const key = ment.trim().toLowerCase();
        if (key && !map.has(key)) map.set(key, ment.trim());
      }
    }
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  }, [directory.people, notes]);

  const [clientId, setClientId] = useState(initialClientFilter);
  const [projectId, setProjectId] = useState('');
  const [labelFilter, setLabelFilter] = useState(initialLabelFilter);
  const [personFilter, setPersonFilter] = useState(() => {
    if (!initialPersonFilter) return '';
    const canonical = allPeopleNames.find(
      (name) => name.toLowerCase() === initialPersonFilter.trim().toLowerCase()
    );
    return canonical || initialPersonFilter.trim();
  });
  const [topicQuery, setTopicQuery] = useState('');
  const [dateRange, setDateRange] = useState<'all' | '7d' | '30d'>('all');

  const [briefMarkdown, setBriefMarkdown] = useState<string | null>(null);
  const [briefProvider, setBriefProvider] = useState<string>('');
  const [briefPrivacyReport, setBriefPrivacyReport] = useState<AiPrivacyReport | undefined>(undefined);
  const [showBriefPrivacyPrompt, setShowBriefPrivacyPrompt] = useState(false);
  const [showDailyPrivacyPrompt, setShowDailyPrivacyPrompt] = useState(false);
  const [generatingBrief, setGeneratingBrief] = useState(false);
  const [copied, setCopied] = useState<'teams' | 'md' | null>(null);

  const todayDate = getTodayDateString();

  // Compute Daily Briefing Data
  const dailyData = useMemo(
    () => computeDailyBriefingData(notes, directory, todayDate, dailyWindowDays),
    [notes, directory, todayDate, dailyWindowDays]
  );

  const deterministicDailyBriefing = useMemo(
    () => buildDeterministicDailyBriefing(dailyData, directory),
    [dailyData, directory]
  );

  const activeDailyOverviewMarkdown =
    dailyBriefingState &&
    dailyBriefingState.date === todayDate &&
    dailyBriefingState.overviewMarkdown
      ? dailyBriefingState.overviewMarkdown
      : deterministicDailyBriefing.overviewMarkdown;

  const activeDailyProvider =
    dailyBriefingState && dailyBriefingState.date === todayDate && dailyBriefingState.usedProvider
      ? dailyBriefingState.usedProvider
      : deterministicDailyBriefing.usedProvider;

  const activeDailyPrivacyReport =
    dailyBriefingState && dailyBriefingState.date === todayDate
      ? dailyBriefingState.privacyReport
      : undefined;

  const dailyReportNote = useMemo(
    () => notes.find((n) => n.id === DAILY_BRIEFING_NOTE_ID || isDailyBriefingNote(n)),
    [notes]
  );

  const filteredData = useMemo(() => {
    const minDateStr =
      dateRange === '7d'
        ? subtractDaysIso(todayDate, 7)
        : dateRange === '30d'
        ? subtractDaysIso(todayDate, 30)
        : '';

    const matchingNotes: Note[] = [];
    const matchingTasks: ParsedTask[] = [];
    const matchingDecisions: ParsedDecision[] = [];

    const qLower = topicQuery.trim().toLowerCase();

    for (const note of notes) {
      // Exclude the auto-generated daily briefing rollup note from custom filter rollups unless explicitly filtering #daily-briefing
      if (isDailyBriefingNote(note) && labelFilter !== 'daily-briefing') {
        continue;
      }
      if (minDateStr && note.date < minDateStr) {
        continue;
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
  }, [notes, directory.people, clientId, projectId, labelFilter, personFilter, topicQuery, dateRange, todayDate]);

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
        directory,
        config: aiConfig,
      });
      setBriefMarkdown(res.markdown);
      setBriefProvider(res.usedProvider);
      setBriefPrivacyReport(res.privacyReport);
    } finally {
      setGeneratingBrief(false);
    }
  };

  const handleCopyForEmailTeams = async () => {
    const textSource =
      briefMarkdown ||
      buildDeterministicExecutiveBrief({
        heading: reportHeading,
        notes: filteredData.matchingNotes,
        tasks: filteredData.matchingTasks,
        decisions: filteredData.matchingDecisions,
      });

    const formattedForTeams = textSource.replace(/\[\[([^\]]+)\]\]/g, '"$1"');
    await navigator.clipboard.writeText(formattedForTeams);
    setCopied('teams');
    setTimeout(() => setCopied(null), 1800);
  };

  const handleCopyMarkdown = async () => {
    const textSource =
      briefMarkdown ||
      buildDeterministicExecutiveBrief({
        heading: reportHeading,
        notes: filteredData.matchingNotes,
        tasks: filteredData.matchingTasks,
        decisions: filteredData.matchingDecisions,
      });
    await navigator.clipboard.writeText(textSource);
    setCopied('md');
    setTimeout(() => setCopied(null), 1800);
  };

  const handleCopyDailyDigest = async () => {
    const fullDigest =
      dailyBriefingState &&
      dailyBriefingState.date === todayDate &&
      dailyBriefingState.fullNoteMarkdown
        ? dailyBriefingState.fullNoteMarkdown
        : deterministicDailyBriefing.fullNoteMarkdown;
    const formatted = fullDigest.replace(/\[\[([^\]]+)\]\]/g, '"$1"');
    await navigator.clipboard.writeText(formatted);
    setDailyCopied(true);
    setTimeout(() => setDailyCopied(false), 1800);
  };

  const openTasks = filteredData.matchingTasks.filter((t) => t.status !== 'done');
  const doneTasks = filteredData.matchingTasks.filter((t) => t.status === 'done');

  const handleOpenNoteLink = (targetTitle: string) => {
    if (onOpenNoteByTitle) {
      onOpenNoteByTitle(targetTitle);
      return;
    }
    const found = notes.find((n) => n.title.toLowerCase() === targetTitle.toLowerCase());
    if (found) onOpenNote(found.id);
  };

  const applyPersonFilter = (rawName: string) => {
    const trimmed = rawName.trim();
    if (!trimmed) {
      setPersonFilter('');
      return;
    }
    const canonical = allPeopleNames.find(
      (name) => name.toLowerCase() === trimmed.toLowerCase()
    );
    setPersonFilter(canonical || trimmed);
    switchHubMode('explorer');
  };

  const applyLabelFilterFromPill = (lbl: string) => {
    setLabelFilter(lbl);
    switchHubMode('explorer');
  };

  const labelOptions = useMemo(() => {
    if (!labelFilter || allLabels.includes(labelFilter)) return allLabels;
    return [labelFilter, ...allLabels];
  }, [allLabels, labelFilter]);

  const peopleOptions = useMemo(() => {
    if (
      !personFilter ||
      allPeopleNames.some((name) => name.toLowerCase() === personFilter.toLowerCase())
    ) {
      return allPeopleNames;
    }
    return [personFilter, ...allPeopleNames];
  }, [allPeopleNames, personFilter]);

  const renderInline = (text: string) => (
    <RichInlineText
      text={text}
      people={directory.people}
      clients={directory.clients}
      notes={notes}
      onClickPerson={applyPersonFilter}
      onClickLabel={applyLabelFilterFromPill}
      onClickNoteLink={handleOpenNoteLink}
    />
  );

  const displayedDailyTasks = useMemo(() => {
    if (dailyTaskTab === 'urgent') {
      return [...dailyData.overdueTasks, ...dailyData.dueTodayTasks];
    }
    if (dailyTaskTab === 'all') {
      return dailyData.allOpenTasks;
    }
    if (dailyTaskTab === 'done') {
      return dailyData.recentlyCompletedTasks;
    }
    return dailyData.urgentAndFocusTasks.length > 0
      ? dailyData.urgentAndFocusTasks
      : dailyData.allOpenTasks;
  }, [dailyData, dailyTaskTab]);

  const urgentCount = dailyData.overdueTasks.length + dailyData.dueTodayTasks.length;

  return (
    <div className={embeddedInOverlay ? 'overlay-report-view' : 'page-scroll'}>
      <div className={embeddedInOverlay ? 'page-container overlay-page-container' : 'page-container'}>
        {/* Top Segmented Mode Switcher (Daily Briefing vs. Custom Explorer & Rollups) */}
        {!embeddedInOverlay && (
          <div className="reports-mode-bar no-print" role="tablist" aria-label="Reports View Mode">
            <button
              id="tab-daily-briefing"
              type="button"
              role="tab"
              aria-selected={hubMode === 'daily'}
              className={`reports-mode-tab ${hubMode === 'daily' ? 'active' : ''}`}
              onClick={() => switchHubMode('daily')}
            >
              <Sun size={14} />
              <span>Daily Briefing &amp; Overview</span>
              <span className="reports-mode-badge">
                {urgentCount > 0 ? `${urgentCount} due/overdue` : 'Today'}
              </span>
            </button>

            <button
              id="tab-custom-explorer"
              type="button"
              role="tab"
              aria-selected={hubMode === 'explorer'}
              className={`reports-mode-tab ${hubMode === 'explorer' ? 'active' : ''}`}
              onClick={() => switchHubMode('explorer')}
            >
              <Filter size={14} />
              <span>Custom Explorer &amp; Topic Rollups</span>
              <span className="reports-mode-badge">{dailyData.sourceNotes.length} notes</span>
            </button>
          </div>
        )}

        {hubMode === 'daily' ? (
          <>
            {/* Daily Briefing Header */}
            <div className="page-header">
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <h1 className="page-h1">Daily Briefing — {formatHumanDate(todayDate)}</h1>
                  <span className="daily-live-pill">
                    <CalendarCheck size={12} /> Auto-Updates Daily
                  </span>
                </div>
                <p className="page-subtitle">
                  AI-synthesized executive overview, today&apos;s top priorities, deadlines, pending decisions, and recent
                  note summaries — automatically synced with your{' '}
                  <button
                    type="button"
                    className="inline-note-jump-btn"
                    onClick={() => {
                      if (onOpenDailyReportNote) {
                        onOpenDailyReportNote();
                      } else if (dailyReportNote) {
                        onOpenNote(dailyReportNote.id);
                      }
                    }}
                  >
                    [[Daily Briefing — {todayDate}]]
                  </button>{' '}
                  note.
                </p>
              </div>

              <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <select
                  className="meta-select"
                  aria-label="Recent activity window"
                  value={dailyWindowDays}
                  onChange={(e) => {
                    const nextDays = Number(e.target.value);
                    setDailyWindowDays(nextDays);
                  }}
                >
                  <option value={2}>Recent Window: Last 48 Hours</option>
                  <option value={7}>Recent Window: Last 7 Days</option>
                  <option value={14}>Recent Window: Last 14 Days</option>
                  <option value={30}>Recent Window: Last 30 Days</option>
                </select>

                <button
                  id="btn-refresh-daily-briefing"
                  type="button"
                  className="btn btn-primary"
                  disabled={isRefreshingDailyBriefing}
                  onClick={() => void onRefreshDailyBriefing?.(dailyWindowDays)}
                  title="Synthesize fresh Daily Briefing with configured AI engine and update Daily Report note"
                >
                  {isRefreshingDailyBriefing ? (
                    <Loader2 size={14} className="ai-spin" />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  {isRefreshingDailyBriefing
                    ? 'Synthesizing Daily Briefing…'
                    : aiConfig.provider === 'local'
                    ? 'Refresh Daily Briefing'
                    : 'Synthesize Daily Briefing with AI'}
                </button>

                {onOpenDailyReportNote && (
                  <button
                    id="btn-open-daily-report-note"
                    type="button"
                    className="btn btn-soft"
                    onClick={onOpenDailyReportNote}
                    title="Open the auto-updated Daily Briefing note in the editor"
                  >
                    <FileText size={14} />
                    Open Daily Report Note
                  </button>
                )}

                <button type="button" className="btn" onClick={handleCopyDailyDigest}>
                  {dailyCopied ? <Check size={14} /> : <Copy size={14} />}
                  {dailyCopied ? 'Copied Digest!' : 'Copy Daily Digest'}
                </button>

                <button type="button" className="btn" onClick={() => window.print()}>
                  <Printer size={14} /> Print / PDF
                </button>
              </div>
            </div>

            {/* 5-Card Daily Pulse KPI Strip */}
            <div className="stat-strip">
              <div className={`stat-box ${urgentCount > 0 ? 'stat-box-urgent' : ''}`}>
                <div className="stat-value">{urgentCount}</div>
                <div className="stat-label">
                  Due Today &amp; Overdue ({dailyData.overdueTasks.length} overdue · {dailyData.dueTodayTasks.length}{' '}
                  today)
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-value">
                  {dailyData.highPriorityOpenTasks.length + dailyData.inProgressTasks.length}
                </div>
                <div className="stat-label">
                  High Priority &amp; Doing ({dailyData.highPriorityOpenTasks.length} !high ·{' '}
                  {dailyData.inProgressTasks.length} doing)
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-value">
                  {dailyData.waitingTasks.length + dailyData.proposedDecisions.length}
                </div>
                <div className="stat-label">
                  Waiting &amp; Pending ({dailyData.waitingTasks.length} waiting ·{' '}
                  {dailyData.proposedDecisions.length} proposed)
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-value">{dailyData.recentAgreedDecisions.length}</div>
                <div className="stat-label">
                  Recent Agreed Decisions ({dailyData.allDecisions.length} total)
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-value">{dailyData.recentNotes.length}</div>
                <div className="stat-label">
                  Recent Notes ({dailyData.todayNotes.length} active today)
                </div>
              </div>
            </div>

            {/* AI Daily Executive Overview & Top Priorities Panel */}
            <div className="surface-panel daily-overview-panel">
              <div className="daily-panel-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="daily-ai-badge">
                    <Sparkles size={13} />
                    <span>Daily Executive Overview &amp; Top Priorities</span>
                  </span>
                  <span className="due-chip">Engine: {activeDailyProvider}</span>
                  <AiPrivacyInlineControls
                    report={activeDailyPrivacyReport}
                    isOpen={showDailyPrivacyPrompt}
                    onToggleOpen={() => setShowDailyPrivacyPrompt((v) => !v)}
                  />
                  {dailyBriefingState?.generatedAt && (
                    <span className="due-chip">
                      <Clock size={11} /> Updated{' '}
                      {new Date(dailyBriefingState.generatedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  )}
                </div>

                <div className="no-print" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {onOpenDailyReportNote && (
                    <button
                      type="button"
                      className="btn btn-xs btn-soft"
                      onClick={onOpenDailyReportNote}
                      title="View or edit the synced Daily Briefing note in the workspace editor"
                    >
                      <ExternalLink size={12} /> View in Note Editor
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => void onRefreshDailyBriefing?.(dailyWindowDays)}
                    disabled={isRefreshingDailyBriefing}
                    title="Re-synthesize today's overview"
                  >
                    <RefreshCw size={12} className={isRefreshingDailyBriefing ? 'ai-spin' : ''} />
                    Regenerate
                  </button>
                </div>
              </div>

              <AiPrivacyPromptDrawer
                report={activeDailyPrivacyReport}
                isOpen={showDailyPrivacyPrompt}
              />

              {isRefreshingDailyBriefing ? (
                <AiLoadingState
                  title="Synthesizing Today's Executive Overview & Priorities…"
                  subtitle={`Analyzing ${dailyData.sourceNotes.length} note(s), ${dailyData.allOpenTasks.length} open task(s), and ${dailyData.allDecisions.length} decision(s)`}
                  providerLabel={formatAiEngineLabel(aiConfig)}
                />
              ) : (
                <div className="narrative-brief">
                  <RichMarkdown
                    markdown={activeDailyOverviewMarkdown}
                    people={directory.people}
                    clients={directory.clients}
                    notes={notes}
                    onClickPerson={applyPersonFilter}
                    onClickLabel={applyLabelFilterFromPill}
                    onClickNoteLink={handleOpenNoteLink}
                  />
                </div>
              )}
            </div>

            {/* Today's Action Items & Priorities (2-Way Synced with Source Notes) */}
            <div className="surface-panel">
              <div className="daily-panel-header">
                <strong style={{ fontSize: 14.5 }}>
                  Action Items &amp; Priorities ({dailyData.allOpenTasks.length} Open ·{' '}
                  {dailyData.recentlyCompletedTasks.length} Completed Recently)
                </strong>

                <div className="no-print" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`btn btn-xs ${dailyTaskTab === 'focus' ? 'btn-primary' : ''}`}
                    onClick={() => setDailyTaskTab('focus')}
                  >
                    Priority Focus ({dailyData.urgentAndFocusTasks.length})
                  </button>
                  <button
                    type="button"
                    className={`btn btn-xs ${dailyTaskTab === 'urgent' ? 'btn-primary' : ''}`}
                    onClick={() => setDailyTaskTab('urgent')}
                  >
                    Due Today &amp; Overdue ({urgentCount})
                  </button>
                  <button
                    type="button"
                    className={`btn btn-xs ${dailyTaskTab === 'all' ? 'btn-primary' : ''}`}
                    onClick={() => setDailyTaskTab('all')}
                  >
                    All Open ({dailyData.allOpenTasks.length})
                  </button>
                  <button
                    type="button"
                    className={`btn btn-xs ${dailyTaskTab === 'done' ? 'btn-primary' : ''}`}
                    onClick={() => setDailyTaskTab('done')}
                  >
                    Completed ({dailyData.recentlyCompletedTasks.length})
                  </button>
                </div>
              </div>

              {displayedDailyTasks.length === 0 ? (
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {dailyTaskTab === 'urgent'
                    ? 'No overdue or due-today tasks — you are caught up on immediate deadlines!'
                    : dailyTaskTab === 'done'
                    ? 'No completed tasks in the selected window yet.'
                    : 'No open action items across your notes.'}
                </span>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {displayedDailyTasks.map((t) => {
                    const nextStatus = TASK_CYCLE[(TASK_CYCLE.indexOf(t.status) + 1) % TASK_CYCLE.length];
                    const inlineMentions = extractInlineMentions(t.text, directory.people);
                    const ownerAlreadyInline = Boolean(
                      t.owner &&
                        inlineMentions.some((m) => m.toLowerCase() === t.owner!.toLowerCase())
                    );
                    const isOverdue = Boolean(
                      t.status !== 'done' && t.dueDate && t.dueDate < todayDate
                    );
                    const isDueToday = Boolean(
                      t.status !== 'done' && t.dueDate === todayDate
                    );
                    const taskClient = t.clientId
                      ? directory.clients.find((c) => c.id === t.clientId)
                      : null;

                    return (
                      <div
                        key={t.id}
                        className={`task-inline-card ${t.status === 'done' ? 'is-done' : ''} ${
                          isOverdue ? 'task-card-overdue' : isDueToday ? 'task-card-due-today' : ''
                        }`}
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

                          {isOverdue && (
                            <span className="priority-high" title={`Overdue since ${t.dueDate}`}>
                              <AlertTriangle size={10} style={{ marginRight: 3, verticalAlign: '-1px' }} />
                              OVERDUE · {t.dueDate}
                            </span>
                          )}
                          {isDueToday && (
                            <span className="daily-due-today-badge">DUE TODAY</span>
                          )}

                          <span className="task-text">{renderInline(t.text)}</span>

                          {t.owner && !ownerAlreadyInline && (
                            <button
                              type="button"
                              className="pill pill-person"
                              onClick={() => applyPersonFilter(t.owner!)}
                            >
                              @{t.owner}
                            </button>
                          )}
                        </div>

                        <div className="task-right">
                          {t.priority === 'high' && <span className="priority-high">!HIGH</span>}
                          {t.dueDate && !isOverdue && !isDueToday && (
                            <span className="due-chip">due {t.dueDate}</span>
                          )}
                          {taskClient && (
                            <span
                              className="context-chip"
                              onClick={() => {
                                setClientId(taskClient.id);
                                setHubMode('explorer');
                              }}
                            >
                              <span
                                className="client-dot"
                                style={{ background: taskClient.color }}
                              />
                              {taskClient.name}
                            </span>
                          )}
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

            {/* Decisions Radar (Pending Sign-off & Recent Agreements) */}
            <div className="surface-panel">
              <div className="daily-panel-header">
                <strong style={{ fontSize: 14.5 }}>
                  Decisions Radar ({dailyData.proposedDecisions.length} Pending Sign-off ·{' '}
                  {dailyData.recentAgreedDecisions.length} Recently Agreed)
                </strong>
              </div>

              {dailyData.proposedDecisions.length === 0 &&
              dailyData.recentAgreedDecisions.length === 0 ? (
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  No active or proposed decisions documented yet. Use <code>- [D:agreed]</code> or{' '}
                  <code>- [D:proposed]</code> in any note.
                </span>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[...dailyData.proposedDecisions, ...dailyData.recentAgreedDecisions].map((d) => {
                    const nextStatus =
                      DEC_CYCLE[(DEC_CYCLE.indexOf(d.status) + 1) % DEC_CYCLE.length];
                    const decClient = d.clientId
                      ? directory.clients.find((c) => c.id === d.clientId)
                      : null;

                    return (
                      <div
                        key={d.id}
                        className={`decision-inline-card ${
                          d.status === 'proposed' ? 'decision-card-pending' : ''
                        }`}
                      >
                        <div className="decision-main">
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              flexWrap: 'wrap',
                            }}
                          >
                            <button
                              type="button"
                              className={`status-badge decision-badge-${d.status}`}
                              onClick={() => onUpdateDecisionStatus(d, nextStatus)}
                              title="Click to cycle status (agreed / proposed / superseded) in source note"
                            >
                              <Gavel size={11} /> {d.status}
                            </button>
                            {d.status === 'proposed' && (
                              <span className="daily-due-today-badge">Needs Sign-off</span>
                            )}
                            <span style={{ fontWeight: 550 }}>{renderInline(d.text)}</span>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {decClient && (
                              <span
                                className="context-chip"
                                onClick={() => {
                                  setClientId(decClient.id);
                                  setHubMode('explorer');
                                }}
                              >
                                <span
                                  className="client-dot"
                                  style={{ background: decClient.color }}
                                />
                                {decClient.name}
                              </span>
                            )}
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
                        {d.rationale && (
                          <div className="decision-rationale">
                            Rationale: {renderInline(d.rationale)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Recent Notes & Activity Rollup */}
            <div className="surface-panel">
              <div className="daily-panel-header">
                <strong style={{ fontSize: 14.5 }}>
                  Recent Notes &amp; Summaries ({dailyData.recentNotes.length})
                </strong>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Click any note card to open in editor
                </span>
              </div>

              {dailyData.recentNotes.length === 0 ? (
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  No source notes in workspace yet.
                </span>
              ) : (
                <div className="report-notes-grid">
                  {dailyData.recentNotes.map((n) => {
                    const noteClient = n.clientId
                      ? directory.clients.find((c) => c.id === n.clientId)
                      : undefined;
                    const noteProject = n.projectId
                      ? directory.projects.find((p) => p.id === n.projectId)
                      : undefined;
                    const noteLabels = getAllNoteLabels(n);
                    const notePeople = Array.from(
                      new Set([
                        ...n.participants,
                        ...extractInlineMentions(n.body, directory.people),
                      ])
                    );
                    const parsedItems = parseNoteItems(n, directory.people);
                    const noteOpenTasks = parsedItems.tasks.filter((t) => t.status !== 'done').length;
                    const cleanPreview = stripMarkdownFormatting(n.body);
                    const snippet =
                      cleanPreview.length > 210
                        ? `${cleanPreview.slice(0, 210).trimEnd()}…`
                        : cleanPreview;
                    const isToday =
                      n.date === todayDate || n.updatedAt.slice(0, 10) === todayDate;

                    return (
                      <div
                        key={n.id}
                        className="report-note-card"
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpenNote(n.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onOpenNote(n.id);
                          }
                        }}
                      >
                        <div className="report-note-card-top">
                          <div className="report-note-card-title-row">
                            <FileText size={14} className="report-note-icon" />
                            <span className="report-note-card-title">
                              {n.title || 'Untitled Note'}
                            </span>
                            {isToday && <span className="report-origin-badge">Today</span>}
                          </div>

                          <div className="report-note-card-meta">
                            {noteClient ? (
                              <span
                                className="context-chip"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setClientId(noteClient.id);
                                  setHubMode('explorer');
                                }}
                              >
                                <span
                                  className="client-dot"
                                  style={{ background: noteClient.color }}
                                />
                                {noteClient.name}
                                {noteProject ? ` · ${noteProject.name}` : ''}
                              </span>
                            ) : n.scope === 'internal' ? (
                              <span
                                className="context-chip"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setClientId('__internal__');
                                  setHubMode('explorer');
                                }}
                              >
                                Internal{noteProject ? ` · ${noteProject.name}` : ''}
                              </span>
                            ) : null}

                            {parsedItems.decisions.length > 0 && (
                              <span className="due-chip">
                                {parsedItems.decisions.length} decision
                                {parsedItems.decisions.length === 1 ? '' : 's'}
                              </span>
                            )}
                            {noteOpenTasks > 0 && (
                              <span className="due-chip">{noteOpenTasks} open task(s)</span>
                            )}
                            <span className="due-chip">{n.date}</span>
                            <span className="report-note-open-hint no-print">
                              <ExternalLink size={11} /> Open
                            </span>
                          </div>
                        </div>

                        {snippet && <div className="report-note-card-snippet">{snippet}</div>}

                        {(noteLabels.length > 0 || notePeople.length > 0) && (
                          <div className="report-note-card-pills">
                            {notePeople.slice(0, 5).map((pName) => (
                              <button
                                key={`p-${pName}`}
                                type="button"
                                className="pill pill-person"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  applyPersonFilter(pName);
                                }}
                              >
                                @{pName}
                              </button>
                            ))}
                            {noteLabels.slice(0, 6).map((lbl) => (
                              <button
                                key={`l-${lbl}`}
                                type="button"
                                className="pill pill-label"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  applyLabelFilterFromPill(lbl);
                                }}
                              >
                                #{lbl}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Custom Explorer & Multi-Dimensional Rollup Header */}
            <div className="page-header">
              <div>
                <h1 className="page-h1">{reportHeading}</h1>
                <p className="page-subtitle">
                  Live cross-note rollups for topics, tasks, decisions, clients, and stakeholders — plus 1-click
                  executive narrative synthesis.
                </p>
              </div>
              <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleGenerateBrief}
                  disabled={generatingBrief}
                >
                  {generatingBrief ? <Loader2 size={14} className="ai-spin" /> : <Sparkles size={14} />}
                  {generatingBrief ? 'Synthesizing Brief…' : 'Generate Narrative Brief'}
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
                {labelOptions.map((l) => (
                  <option key={l} value={l}>
                    #{l}
                  </option>
                ))}
              </select>

              <select
                className="meta-select"
                value={personFilter}
                onChange={(e) => applyPersonFilter(e.target.value)}
              >
                <option value="">All @People</option>
                {peopleOptions.map((name) => (
                  <option key={name} value={name}>
                    @{name}
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
            {(generatingBrief || briefMarkdown) && (
              <div className="surface-panel">
                {generatingBrief ? (
                  <AiLoadingState
                    title="Synthesizing Executive Narrative Brief…"
                    subtitle={`Summarizing ${filteredData.matchingNotes.length} note(s), ${filteredData.matchingDecisions.length} decision(s), and ${openTasks.length} open action item(s)`}
                    providerLabel={formatAiEngineLabel(aiConfig)}
                  />
                ) : (
                  briefMarkdown && (
                    <>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: 8,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: 14 }}>
                            Synthesized Executive Brief ({briefProvider})
                          </strong>
                          <AiPrivacyInlineControls
                            report={briefPrivacyReport}
                            isOpen={showBriefPrivacyPrompt}
                            onToggleOpen={() => setShowBriefPrivacyPrompt((v) => !v)}
                          />
                        </div>
                        <div className="no-print" style={{ display: 'flex', gap: 6 }}>
                          <button
                            type="button"
                            className="btn btn-xs btn-soft"
                            onClick={() =>
                              onSaveBriefAsNote(
                                `${reportHeading} (${todayDate})`,
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
                            onClick={() => {
                              setBriefMarkdown(null);
                              setBriefPrivacyReport(undefined);
                              setShowBriefPrivacyPrompt(false);
                            }}
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                      <AiPrivacyPromptDrawer
                        report={briefPrivacyReport}
                        isOpen={showBriefPrivacyPrompt}
                      />
                      <div className="narrative-brief">
                        <RichMarkdown
                          markdown={briefMarkdown}
                          people={directory.people}
                          clients={directory.clients}
                          notes={notes}
                          onClickPerson={applyPersonFilter}
                          onClickLabel={(lbl) => setLabelFilter(lbl)}
                          onClickNoteLink={handleOpenNoteLink}
                        />
                      </div>
                    </>
                  )
                )}
              </div>
            )}

            {/* Matched Notes Rollup */}
            <div className="surface-panel">
              <strong style={{ fontSize: 14.5 }}>
                Matched Notes ({filteredData.matchingNotes.length})
              </strong>
              {filteredData.matchingNotes.length === 0 ? (
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  No notes match the active filters.
                </span>
              ) : (
                <div className="report-notes-grid">
                  {filteredData.matchingNotes.map((n) => {
                    const noteClient = n.clientId
                      ? directory.clients.find((c) => c.id === n.clientId)
                      : undefined;
                    const noteProject = n.projectId
                      ? directory.projects.find((p) => p.id === n.projectId)
                      : undefined;
                    const noteLabels = getAllNoteLabels(n);
                    const notePeople = Array.from(
                      new Set([
                        ...n.participants,
                        ...extractInlineMentions(n.body, directory.people),
                      ])
                    );
                    const cleanPreview = stripMarkdownFormatting(n.body);
                    const snippet =
                      cleanPreview.length > 200
                        ? `${cleanPreview.slice(0, 200).trimEnd()}…`
                        : cleanPreview;
                    const isActiveBelow = Boolean(activeEditorNoteId && activeEditorNoteId === n.id);

                    return (
                      <div
                        key={n.id}
                        className={`report-note-card ${isActiveBelow ? 'is-active-origin' : ''}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpenNote(n.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onOpenNote(n.id);
                          }
                        }}
                      >
                        <div className="report-note-card-top">
                          <div className="report-note-card-title-row">
                            <FileText size={14} className="report-note-icon" />
                            <span className="report-note-card-title">
                              {n.title || 'Untitled Note'}
                            </span>
                            {isActiveBelow && (
                              <span
                                className="report-origin-badge"
                                title="Currently open underneath this overlay"
                              >
                                Current note
                              </span>
                            )}
                          </div>
                          <div className="report-note-card-meta">
                            {noteClient ? (
                              <span
                                className="context-chip"
                                style={{ cursor: 'pointer' }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setClientId(noteClient.id);
                                }}
                              >
                                <span
                                  className="client-dot"
                                  style={{ background: noteClient.color }}
                                />
                                {noteClient.name}
                                {noteProject ? ` · ${noteProject.name}` : ''}
                              </span>
                            ) : n.scope === 'internal' ? (
                              <span
                                className="context-chip"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setClientId('__internal__');
                                }}
                              >
                                Internal{noteProject ? ` · ${noteProject.name}` : ''}
                              </span>
                            ) : null}
                            <span className="due-chip">{n.date}</span>
                            <span className="report-note-open-hint no-print">
                              <ExternalLink size={11} /> {embeddedInOverlay ? 'Preview' : 'Open'}
                            </span>
                          </div>
                        </div>

                        {snippet && <div className="report-note-card-snippet">{snippet}</div>}

                        {(noteLabels.length > 0 || notePeople.length > 0) && (
                          <div className="report-note-card-pills">
                            {notePeople.slice(0, 5).map((pName) => (
                              <button
                                key={`p-${pName}`}
                                type="button"
                                className="pill pill-person"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  applyPersonFilter(pName);
                                }}
                              >
                                @{pName}
                              </button>
                            ))}
                            {noteLabels.slice(0, 6).map((lbl) => (
                              <button
                                key={`l-${lbl}`}
                                type="button"
                                className="pill pill-label"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setLabelFilter(lbl);
                                }}
                              >
                                #{lbl}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

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
                            <span style={{ fontWeight: 550 }}>{renderInline(d.text)}</span>
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
                        {d.rationale && (
                          <div className="decision-rationale">Rationale: {renderInline(d.rationale)}</div>
                        )}
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
                    const inlineMentions = extractInlineMentions(t.text, directory.people);
                    const ownerAlreadyInline = Boolean(
                      t.owner &&
                        inlineMentions.some((m) => m.toLowerCase() === t.owner!.toLowerCase())
                    );
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
                          <span className="task-text">{renderInline(t.text)}</span>
                          {t.owner && !ownerAlreadyInline && (
                            <button
                              type="button"
                              className="pill pill-person"
                              onClick={() => applyPersonFilter(t.owner!)}
                            >
                              @{t.owner}
                            </button>
                          )}
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
          </>
        )}
      </div>
    </div>
  );
};
