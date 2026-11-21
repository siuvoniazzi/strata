import type {
  AiConfig,
  AiOutputLanguage,
  AiPrivacyReport,
  Note,
  ParsedDecision,
  ParsedTask,
  WorkspaceDirectory,
} from '../types';
import {
  AI_LANGUAGE_OPTIONS,
  callConfiguredLlmDetailed,
  formatAiEngineLabel,
  getEffectiveAiLanguage,
  unwrapOuterMarkdownFence,
  withAiActivity,
} from './aiProvider';
import {
  addDaysIso,
  computeDailyRetroQueue,
  computeDailyRetroSignature,
  computeWorkspaceSignals,
  type DailyRetroQueueSummary,
  getDailyRetroDayEntry,
  getDecisionRetroFeedback,
  getNoteRetroFeedback,
  getTaskRetroPlan,
  isTaskActivelyOverdue,
  resolveEffectiveTaskHorizon,
  scoreTaskForFocus,
  type WorkspaceSignals,
} from './dailyRetro';
import {
  computeNoteFilePath,
  extractInlineMentions,
  formatPersonMention,
  getAllNoteLabels,
  isDailyBriefingNote,
  parseNoteItems,
  stripMarkdownFormatting,
} from './markdown';

export const DAILY_BRIEFING_NOTE_ID = 'note-daily-briefing';
export const DAILY_BRIEFING_LABEL = 'daily-briefing';
const DAILY_BRIEFING_STORAGE_KEY = 'strata.dailyBriefing.v1';

export interface PersistedDailyBriefingState {
  date: string;
  generatedAt: string;
  sourceSignature: string;
  overviewMarkdown: string;
  fullNoteMarkdown: string;
  usedProvider: string;
  language?: AiOutputLanguage;
  privacyReport?: AiPrivacyReport;
}

export interface DailyBriefingData {
  todayDate: string;
  recentDaysWindow: number;
  sourceNotes: Note[];
  todayNotes: Note[];
  recentNotes: Note[];
  visibleRecentNotes: Note[];
  highSignalNotes: Note[];
  hiddenLowSignalNotesCount: number;
  overdueTasks: ParsedTask[];
  dueTodayTasks: ParsedTask[];
  upcomingTasks: ParsedTask[];
  highPriorityOpenTasks: ParsedTask[];
  inProgressTasks: ParsedTask[];
  waitingTasks: ParsedTask[];
  focusTodayTasks: ParsedTask[];
  tomorrowTasks: ParsedTask[];
  thisWeekTasks: ParsedTask[];
  sometimeTasks: ParsedTask[];
  urgentAndFocusTasks: ParsedTask[];
  otherOpenTasks: ParsedTask[];
  allOpenTasks: ParsedTask[];
  recentlyCompletedTasks: ParsedTask[];
  proposedDecisions: ParsedDecision[];
  activeProposedDecisions: ParsedDecision[];
  recentAgreedDecisions: ParsedDecision[];
  allDecisions: ParsedDecision[];
  retroQueue: DailyRetroQueueSummary;
  signals: WorkspaceSignals;
  todaySteeringNote: string;
  carryoverSteeringNote: string;
  sourceSignature: string;
}

export function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatHumanDate(dateStr: string, language: AiOutputLanguage = 'en'): string {
  try {
    const d = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(d.getTime())) return dateStr;
    const locale =
      AI_LANGUAGE_OPTIONS.find((opt) => opt.code === language)?.locale || 'en-US';
    return d.toLocaleDateString(locale, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export function loadDailyBriefingState(): PersistedDailyBriefingState | null {
  try {
    const raw = localStorage.getItem(DAILY_BRIEFING_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedDailyBriefingState;
  } catch {
    return null;
  }
}

export function saveDailyBriefingState(state: PersistedDailyBriefingState): void {
  try {
    localStorage.setItem(DAILY_BRIEFING_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage write errors in restricted contexts
  }
}

function sortTasksByUrgency(tasks: ParsedTask[], todayDate: string): ParsedTask[] {
  const prioRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const statusRank: Record<string, number> = { doing: 0, waiting: 1, todo: 2, done: 3 };
  return [...tasks].sort((a, b) => {
    const aOverdue = a.dueDate && a.dueDate < todayDate ? 0 : a.dueDate === todayDate ? 1 : 2;
    const bOverdue = b.dueDate && b.dueDate < todayDate ? 0 : b.dueDate === todayDate ? 1 : 2;
    if (aOverdue !== bOverdue) return aOverdue - bOverdue;

    const pa = a.priority ? prioRank[a.priority] ?? 3 : 3;
    const pb = b.priority ? prioRank[b.priority] ?? 3 : 3;
    if (pa !== pb) return pa - pb;

    const sa = statusRank[a.status] ?? 2;
    const sb = statusRank[b.status] ?? 2;
    if (sa !== sb) return sa - sb;

    return (a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99');
  });
}

export function computeDailyBriefingData(
  notes: Note[],
  directory: WorkspaceDirectory,
  todayDate: string = getTodayDateString(),
  recentDaysWindow = 7
): DailyBriefingData {
  const retroStore = directory.dailyRetro;
  const sourceNotes = notes
    .filter((n) => !isDailyBriefingNote(n))
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));

  const minWindowDate = addDaysIso(todayDate, -recentDaysWindow);
  const plus7Date = addDaysIso(todayDate, 7);
  const yesterdayDate = addDaysIso(todayDate, -1);

  const todayNotes = sourceNotes.filter(
    (n) => n.date === todayDate || n.updatedAt.slice(0, 10) === todayDate
  );

  const activeTodayClientIds = new Set<string>();
  const activeTodayProjectIds = new Set<string>();
  for (const n of todayNotes) {
    if (n.clientId) activeTodayClientIds.add(n.clientId);
    if (n.projectId) activeTodayProjectIds.add(n.projectId);
  }

  const notesInWindow = sourceNotes.filter(
    (n) => n.date >= minWindowDate || n.updatedAt.slice(0, 10) >= minWindowDate
  );
  const recentNotes = notesInWindow.length > 0 ? notesInWindow : sourceNotes.slice(0, 6);

  let hiddenLowSignalNotesCount = 0;
  const visibleRecentNotes = recentNotes
    .filter((n) => {
      const fb = getNoteRetroFeedback(retroStore, n.id);
      if (fb?.rating === 'low') {
        hiddenLowSignalNotesCount++;
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const ra = getNoteRetroFeedback(retroStore, a.id)?.rating === 'high' ? 0 : 1;
      const rb = getNoteRetroFeedback(retroStore, b.id)?.rating === 'high' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt);
    });

  const highSignalNotes = sourceNotes.filter(
    (n) =>
      getNoteRetroFeedback(retroStore, n.id)?.rating === 'high' &&
      (n.date >= minWindowDate || n.updatedAt.slice(0, 10) >= minWindowDate)
  );

  const allTasks: ParsedTask[] = [];
  const allDecisions: ParsedDecision[] = [];

  for (const n of sourceNotes) {
    const parsed = parseNoteItems(n, directory.people);
    allTasks.push(...parsed.tasks);
    allDecisions.push(...parsed.decisions);
  }

  const allOpenTasks = sortTasksByUrgency(
    allTasks.filter((t) => t.status !== 'done'),
    todayDate
  );

  const focusContext = {
    clientIds: activeTodayClientIds,
    projectIds: activeTodayProjectIds,
  };

  const focusTodayTasks: ParsedTask[] = [];
  const tomorrowTasks: ParsedTask[] = [];
  const thisWeekTasks: ParsedTask[] = [];
  const sometimeTasks: ParsedTask[] = [];

  for (const t of allOpenTasks) {
    const horizon = resolveEffectiveTaskHorizon(t, retroStore, todayDate);
    if (horizon === 'today') {
      focusTodayTasks.push(t);
    } else if (horizon === 'tomorrow') {
      tomorrowTasks.push(t);
    } else if (horizon === 'this-week') {
      thisWeekTasks.push(t);
    } else {
      sometimeTasks.push(t);
    }
  }

  focusTodayTasks.sort(
    (a, b) =>
      scoreTaskForFocus(b, retroStore, todayDate, focusContext) -
      scoreTaskForFocus(a, retroStore, todayDate, focusContext)
  );

  const overdueTasks = allOpenTasks.filter((t) =>
    isTaskActivelyOverdue(t, retroStore, todayDate)
  );
  const dueTodayTasks = allOpenTasks.filter(
    (t) =>
      t.dueDate === todayDate &&
      resolveEffectiveTaskHorizon(t, retroStore, todayDate) === 'today'
  );
  const upcomingTasks = allOpenTasks.filter(
    (t) =>
      Boolean(t.dueDate && t.dueDate > todayDate && t.dueDate <= plus7Date) &&
      resolveEffectiveTaskHorizon(t, retroStore, todayDate) !== 'sometime'
  );
  const highPriorityOpenTasks = allOpenTasks.filter(
    (t) =>
      t.priority === 'high' &&
      resolveEffectiveTaskHorizon(t, retroStore, todayDate) !== 'sometime'
  );
  const inProgressTasks = allOpenTasks.filter(
    (t) =>
      t.status === 'doing' &&
      resolveEffectiveTaskHorizon(t, retroStore, todayDate) !== 'sometime'
  );
  const waitingTasks = allOpenTasks.filter(
    (t) =>
      t.status === 'waiting' &&
      resolveEffectiveTaskHorizon(t, retroStore, todayDate) !== 'sometime'
  );

  // Capped, high-signal Today Focus list (instead of an unbounded union of 6 buckets)
  const urgentAndFocusTasks = focusTodayTasks.slice(0, 8);
  const focusIds = new Set(urgentAndFocusTasks.map((t) => t.id));
  const otherOpenTasks = allOpenTasks.filter((t) => !focusIds.has(t.id));

  const recentlyCompletedTasks = allTasks.filter(
    (t) => t.status === 'done' && t.noteDate >= minWindowDate
  );

  const proposedDecisions = allDecisions
    .filter((d) => d.status === 'proposed')
    .sort((a, b) => b.noteDate.localeCompare(a.noteDate));

  const activeProposedDecisions = proposedDecisions
    .filter((d) => getDecisionRetroFeedback(retroStore, d)?.rating !== 'low')
    .sort((a, b) => {
      const ra = getDecisionRetroFeedback(retroStore, a)?.rating === 'high' ? 0 : 1;
      const rb = getDecisionRetroFeedback(retroStore, b)?.rating === 'high' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return b.noteDate.localeCompare(a.noteDate);
    });

  const agreedInWindow = allDecisions
    .filter(
      (d) =>
        d.status === 'agreed' &&
        d.noteDate >= minWindowDate &&
        getDecisionRetroFeedback(retroStore, d)?.rating !== 'low'
    )
    .sort((a, b) => b.noteDate.localeCompare(a.noteDate));

  const recentAgreedDecisions =
    agreedInWindow.length > 0
      ? agreedInWindow
      : allDecisions
          .filter(
            (d) =>
              d.status === 'agreed' &&
              getDecisionRetroFeedback(retroStore, d)?.rating !== 'low'
          )
          .sort((a, b) => b.noteDate.localeCompare(a.noteDate))
          .slice(0, 5);

  const retroQueue = computeDailyRetroQueue(notes, directory, todayDate);
  const signals = computeWorkspaceSignals(notes, directory, todayDate);

  const todaySteeringNote = getDailyRetroDayEntry(retroStore, todayDate)?.steeringNote || '';
  const carryoverSteeringNote =
    getDailyRetroDayEntry(retroStore, yesterdayDate)?.steeringNote || '';

  const sigParts = sourceNotes.map(
    (n) => `${n.id}:${n.date}:${n.updatedAt}:${n.title}:${n.body.length}`
  );
  const retroSig = computeDailyRetroSignature(retroStore, todayDate);
  const yesterdayRetroSig = getDailyRetroDayEntry(retroStore, yesterdayDate)?.updatedAt || '';
  const sourceSignature = `${todayDate}|w${recentDaysWindow}|r(${retroSig}|y:${yesterdayRetroSig})|${sigParts.join(';')}`;

  return {
    todayDate,
    recentDaysWindow,
    sourceNotes,
    todayNotes,
    recentNotes,
    visibleRecentNotes,
    highSignalNotes,
    hiddenLowSignalNotesCount,
    overdueTasks,
    dueTodayTasks,
    upcomingTasks,
    highPriorityOpenTasks,
    inProgressTasks,
    waitingTasks,
    focusTodayTasks,
    tomorrowTasks,
    thisWeekTasks,
    sometimeTasks,
    urgentAndFocusTasks,
    otherOpenTasks,
    allOpenTasks,
    recentlyCompletedTasks,
    proposedDecisions,
    activeProposedDecisions,
    recentAgreedDecisions,
    allDecisions,
    retroQueue,
    signals,
    todaySteeringNote,
    carryoverSteeringNote,
    sourceSignature,
  };
}

interface BriefingCopy {
  overdueDuePrefix: string;
  dueToday: string;
  duePrefix: string;
  fromPrefix: string;
  proposedNeedsSignoff: string;
  rationaleLabel: string;
  retroNoteLabel: string;
  statusLabels: {
    todo: string;
    doing: string;
    waiting: string;
    done: string;
    proposed: string;
    agreed: string;
  };
  emptyOverviewHeading: string;
  emptyOverviewBody: string;
  emptyBanner: (humanDate: string, isoDate: string) => string;
  executivePulseHeading: string;
  focusPulseLine: (
    focusCount: number,
    overdueCount: number,
    tomorrowCount: number,
    parkedCount: number
  ) => string;
  steeringCalloutLine: (note: string) => string;
  highSignalTakeawaysHeading: string;
  watchlistSignalsHeading: string;
  waitingOnLine: (peopleSummary: string) => string;
  driftSignalLine: (staleCount: number, silentProjectNames: string) => string;
  decisionPendingLine: (proposedCount: number, agreedCount: number) => string;
  calmWorkspaceLine: (completedCount: number, activeStreams: string) => string;
  autoUpdatedBanner: (
    humanDate: string,
    isoDate: string,
    focusCount: number,
    tomorrowCount: number,
    decisionsCount: number
  ) => string;
  retroSectionHeading: string;
  actionItemsRollupHeading: string;
  todaysFocusHeading: string;
  tomorrowHorizonHeading: string;
  thisWeekHorizonHeading: string;
  sometimeParkedHeading: (count: number) => string;
  recentlyCompletedHeading: (count: number) => string;
  decisionsRegisterHeading: string;
  pendingDecisionsHeading: string;
  recentAgreedDecisionsHeading: string;
  recentNotesHeading: string;
  untitledNote: string;
  internalLabel: string;
  inboxLabel: string;
}

const BRIEFING_COPY: Record<AiOutputLanguage, BriefingCopy> = {
  en: {
    overdueDuePrefix: 'OVERDUE · due',
    dueToday: 'DUE TODAY',
    duePrefix: 'due',
    fromPrefix: 'from',
    proposedNeedsSignoff: 'PROPOSED · Needs Sign-off',
    rationaleLabel: 'Rationale',
    retroNoteLabel: 'Note',
    statusLabels: {
      todo: 'TODO',
      doing: 'DOING',
      waiting: 'WAITING',
      done: 'DONE',
      proposed: 'PROPOSED',
      agreed: 'AGREED',
    },
    emptyOverviewHeading: 'Daily Executive Brief',
    emptyOverviewBody:
      'Your workspace does not have any source notes yet. Spin up a note (`Alt+N`) and capture tasks (`- [ ] Task @Owner due:YYYY-MM-DD !high`) or decisions (`- [D:agreed] Decision`). Use **Daily Retro** at the end of the day to rate signal and slot tasks into Today, Tomorrow, This Week, or Sometime.',
    emptyBanner: (humanDate, isoDate) =>
      `> **Daily Workspace Briefing** for **${humanDate}** (${isoDate}). Powered by your notes and Daily Retro signals.`,
    executivePulseHeading: 'Chief-of-Staff Synthesis',
    focusPulseLine: (focusCount, overdueCount, tomorrowCount, parkedCount) =>
      `- **Today's Horizon:** **${focusCount}** item(s) in Today's Focus${overdueCount > 0 ? ` (**${overdueCount}** overdue)` : ''}${tomorrowCount > 0 ? ` · **${tomorrowCount}** queued for Tomorrow` : ''}${parkedCount > 0 ? ` · **${parkedCount}** parked in This Week / Sometime` : ''}.`,
    steeringCalloutLine: (note) => `- **Your Retro Steering:** *"${note}"*`,
    highSignalTakeawaysHeading: 'Key Context & Momentum',
    watchlistSignalsHeading: 'Watchlist & Follow-ups',
    waitingOnLine: (peopleSummary) => `- **Batch Follow-ups:** Waiting on ${peopleSummary}.`,
    driftSignalLine: (staleCount, silentProjectNames) =>
      `- **Drift Radar:** ${staleCount > 0 ? `**${staleCount}** stalled/unassigned item(s) needing a nudge` : ''}${staleCount > 0 && silentProjectNames ? ' · ' : ''}${silentProjectNames ? `Quiet active project(s): **${silentProjectNames}**` : ''}.`,
    decisionPendingLine: (proposedCount, agreedCount) =>
      `- **Decision Alignment:** **${proposedCount}** proposed decision(s) awaiting sign-off${agreedCount > 0 ? ` · **${agreedCount}** recently agreed` : ''}.`,
    calmWorkspaceLine: (completedCount, activeStreams) =>
      `- **Momentum:** ${completedCount > 0 ? `**${completedCount}** task(s) completed recently` : 'Clear immediate horizon'}${activeStreams ? ` across **${activeStreams}**` : ''}.`,
    autoUpdatedBanner: (humanDate, isoDate, focusCount, tomorrowCount, decisionsCount) =>
      `> **Daily Briefing** · **${humanDate}** (${isoDate}) · **${focusCount}** Today · **${tomorrowCount}** Tomorrow · **${decisionsCount}** Pending Decision(s).`,
    retroSectionHeading: 'Daily Retro & Steering Signals',
    actionItemsRollupHeading: 'Action Horizons',
    todaysFocusHeading: "Today's Focus",
    tomorrowHorizonHeading: 'Tomorrow',
    thisWeekHorizonHeading: 'This Week',
    sometimeParkedHeading: (count) => `Sometime / Parked (${count})`,
    recentlyCompletedHeading: (count) => `Recently Completed (${count})`,
    decisionsRegisterHeading: 'Decisions Radar',
    pendingDecisionsHeading: 'Needs Sign-off',
    recentAgreedDecisionsHeading: 'Recently Agreed',
    recentNotesHeading: 'High-Signal & Recent Notes',
    untitledNote: 'Untitled Note',
    internalLabel: 'Internal',
    inboxLabel: 'Inbox',
  },
  de: {
    overdueDuePrefix: 'ÜBERFÄLLIG · fällig',
    dueToday: 'HEUTE FÄLLIG',
    duePrefix: 'fällig',
    fromPrefix: 'aus',
    proposedNeedsSignoff: 'VORGESCHLAGEN · Freigabe nötig',
    rationaleLabel: 'Begründung',
    retroNoteLabel: 'Kommentar',
    statusLabels: {
      todo: 'OFFEN',
      doing: 'IN ARBEIT',
      waiting: 'WARTEND',
      done: 'ERLEDIGT',
      proposed: 'VORGESCHLAGEN',
      agreed: 'BESCHLOSSEN',
    },
    emptyOverviewHeading: 'Tägliches Executive-Briefing',
    emptyOverviewBody:
      'Dein Arbeitsbereich enthält noch keine Quellnotizen. Erstelle eine Notiz (`Alt+N`) mit Aufgaben oder Entscheidungen und nutze das **Tages-Retro**, um Wichtiges zu bewerten und Aufgaben für Heute, Morgen, Diese Woche oder Irgendwann einzuplanen.',
    emptyBanner: (humanDate, isoDate) =>
      `> **Tägliches Workspace-Briefing** für **${humanDate}** (${isoDate}). Gesteuert durch deine Notizen und Tages-Retro-Signale.`,
    executivePulseHeading: 'Chief-of-Staff-Synthese',
    focusPulseLine: (focusCount, overdueCount, tomorrowCount, parkedCount) =>
      `- **Heutiger Horizont:** **${focusCount}** Punkt(e) im Fokus heute${overdueCount > 0 ? ` (**${overdueCount}** überfällig)` : ''}${tomorrowCount > 0 ? ` · **${tomorrowCount}** für morgen geplant` : ''}${parkedCount > 0 ? ` · **${parkedCount}** in Diese Woche / Später geparkt` : ''}.`,
    steeringCalloutLine: (note) => `- **Dein Retro-Fokus:** *"${note}"*`,
    highSignalTakeawaysHeading: 'Wichtiger Kontext & Dynamik',
    watchlistSignalsHeading: 'Watchlist & Follow-ups',
    waitingOnLine: (peopleSummary) => `- **Gebündelte Follow-ups:** Wartend auf ${peopleSummary}.`,
    driftSignalLine: (staleCount, silentProjectNames) =>
      `- **Drift-Radar:** ${staleCount > 0 ? `**${staleCount}** blockierte/unzugewiesene Punkte` : ''}${staleCount > 0 && silentProjectNames ? ' · ' : ''}${silentProjectNames ? `Ruhige aktive Projekte: **${silentProjectNames}**` : ''}.`,
    decisionPendingLine: (proposedCount, agreedCount) =>
      `- **Entscheidungen:** **${proposedCount}** offene Entscheidung(en) zur Freigabe${agreedCount > 0 ? ` · **${agreedCount}** kürzlich beschlossen` : ''}.`,
    calmWorkspaceLine: (completedCount, activeStreams) =>
      `- **Dynamik:** ${completedCount > 0 ? `**${completedCount}** Aufgabe(n) kürzlich erledigt` : 'Klarer Fokus für heute'}${activeStreams ? ` über **${activeStreams}**` : ''}.`,
    autoUpdatedBanner: (humanDate, isoDate, focusCount, tomorrowCount, decisionsCount) =>
      `> **Tagesbriefing** · **${humanDate}** (${isoDate}) · **${focusCount}** Heute · **${tomorrowCount}** Morgen · **${decisionsCount}** offene Entscheidung(en).`,
    retroSectionHeading: 'Tages-Retro & Steuerungssignale',
    actionItemsRollupHeading: 'Aufgaben nach Horizont',
    todaysFocusHeading: 'Fokus heute',
    tomorrowHorizonHeading: 'Morgen',
    thisWeekHorizonHeading: 'Diese Woche',
    sometimeParkedHeading: (count) => `Irgendwann / Geparkt (${count})`,
    recentlyCompletedHeading: (count) => `Kürzlich erledigt (${count})`,
    decisionsRegisterHeading: 'Entscheidungs-Radar',
    pendingDecisionsHeading: 'Freigabe erforderlich',
    recentAgreedDecisionsHeading: 'Kürzlich beschlossen',
    recentNotesHeading: 'Wichtige & aktuelle Notizen',
    untitledNote: 'Unbenannte Notiz',
    internalLabel: 'Intern',
    inboxLabel: 'Eingang',
  },
  fr: {
    overdueDuePrefix: 'EN RETARD · échéance',
    dueToday: 'AUJOURD’HUI',
    duePrefix: 'échéance',
    fromPrefix: 'de',
    proposedNeedsSignoff: 'PROPOSÉE · Validation requise',
    rationaleLabel: 'Justification',
    retroNoteLabel: 'Note',
    statusLabels: {
      todo: 'À FAIRE',
      doing: 'EN COURS',
      waiting: 'EN ATTENTE',
      done: 'TERMINÉ',
      proposed: 'PROPOSÉE',
      agreed: 'VALIDÉE',
    },
    emptyOverviewHeading: 'Synthèse quotidienne',
    emptyOverviewBody:
      'Votre espace ne contient pas encore de notes sources. Créez une note (`Alt+N`) et utilisez la **Rétro quotidienne** pour évaluer vos notes et planifier vos tâches.',
    emptyBanner: (humanDate, isoDate) =>
      `> **Briefing quotidien** pour **${humanDate}** (${isoDate}).`,
    executivePulseHeading: 'Synthèse Chief-of-Staff',
    focusPulseLine: (focusCount, overdueCount, tomorrowCount, parkedCount) =>
      `- **Horizon du jour :** **${focusCount}** action(s) prioritaires aujourd’hui${overdueCount > 0 ? ` (**${overdueCount}** en retard)` : ''}${tomorrowCount > 0 ? ` · **${tomorrowCount}** pour demain` : ''}${parkedCount > 0 ? ` · **${parkedCount}** planifiée(s) plus tard` : ''}.`,
    steeringCalloutLine: (note) => `- **Consigne Rétro :** *"${note}"*`,
    highSignalTakeawaysHeading: 'Contexte clé & dynamique',
    watchlistSignalsHeading: 'Suivis & points d’attention',
    waitingOnLine: (peopleSummary) => `- **Relances groupées :** En attente de ${peopleSummary}.`,
    driftSignalLine: (staleCount, silentProjectNames) =>
      `- **Radar de dérive :** ${staleCount > 0 ? `**${staleCount}** élément(s) bloqués ou sans responsable` : ''}${staleCount > 0 && silentProjectNames ? ' · ' : ''}${silentProjectNames ? `Projets silencieux : **${silentProjectNames}**` : ''}.`,
    decisionPendingLine: (proposedCount, agreedCount) =>
      `- **Décisions :** **${proposedCount}** en attente de validation${agreedCount > 0 ? ` · **${agreedCount}** validée(s) récemment` : ''}.`,
    calmWorkspaceLine: (completedCount, activeStreams) =>
      `- **Dynamique :** ${completedCount > 0 ? `**${completedCount}** tâche(s) terminée(s) récemment` : 'Horizon dégagé'}${activeStreams ? ` sur **${activeStreams}**` : ''}.`,
    autoUpdatedBanner: (humanDate, isoDate, focusCount, tomorrowCount, decisionsCount) =>
      `> **Rapport quotidien** · **${humanDate}** (${isoDate}) · **${focusCount}** Aujourd’hui · **${tomorrowCount}** Demain · **${decisionsCount}** Décision(s) en attente.`,
    retroSectionHeading: 'Rétro quotidienne & consignes',
    actionItemsRollupHeading: 'Horizons d’action',
    todaysFocusHeading: 'Focus du jour',
    tomorrowHorizonHeading: 'Demain',
    thisWeekHorizonHeading: 'Cette semaine',
    sometimeParkedHeading: (count) => `Plus tard / En réserve (${count})`,
    recentlyCompletedHeading: (count) => `Terminées récemment (${count})`,
    decisionsRegisterHeading: 'Radar des décisions',
    pendingDecisionsHeading: 'En attente de validation',
    recentAgreedDecisionsHeading: 'Validées récemment',
    recentNotesHeading: 'Notes clés & récentes',
    untitledNote: 'Note sans titre',
    internalLabel: 'Interne',
    inboxLabel: 'Boîte de réception',
  },
  es: {
    overdueDuePrefix: 'VENCIDA · vence',
    dueToday: 'VENCE HOY',
    duePrefix: 'vence',
    fromPrefix: 'de',
    proposedNeedsSignoff: 'PROPUESTA · Requiere aprobación',
    rationaleLabel: 'Justificación',
    retroNoteLabel: 'Comentario',
    statusLabels: {
      todo: 'PENDIENTE',
      doing: 'EN CURSO',
      waiting: 'EN ESPERA',
      done: 'HECHO',
      proposed: 'PROPUESTA',
      agreed: 'ACORDADA',
    },
    emptyOverviewHeading: 'Resumen ejecutivo diario',
    emptyOverviewBody:
      'Tu espacio aún no tiene notas fuente. Crea una nota (`Alt+N`) y usa la **Retro diaria** para priorizar notas y ubicar tareas en Hoy, Mañana, Esta semana o Algún día.',
    emptyBanner: (humanDate, isoDate) =>
      `> **Resumen diario** para **${humanDate}** (${isoDate}).`,
    executivePulseHeading: 'Síntesis Chief-of-Staff',
    focusPulseLine: (focusCount, overdueCount, tomorrowCount, parkedCount) =>
      `- **Horizonte de hoy:** **${focusCount}** tarea(s) en foco hoy${overdueCount > 0 ? ` (**${overdueCount}** vencida(s))` : ''}${tomorrowCount > 0 ? ` · **${tomorrowCount}** para mañana` : ''}${parkedCount > 0 ? ` · **${parkedCount}** aparcada(s) para después` : ''}.`,
    steeringCalloutLine: (note) => `- **Nota de Retro:** *"${note}"*`,
    highSignalTakeawaysHeading: 'Contexto clave e impulso',
    watchlistSignalsHeading: 'Seguimientos y alertas',
    waitingOnLine: (peopleSummary) => `- **Seguimientos agrupados:** Esperando a ${peopleSummary}.`,
    driftSignalLine: (staleCount, silentProjectNames) =>
      `- **Radar de bloqueo:** ${staleCount > 0 ? `**${staleCount}** elemento(s) estancados o sin responsable` : ''}${staleCount > 0 && silentProjectNames ? ' · ' : ''}${silentProjectNames ? `Proyectos sin actividad reciente: **${silentProjectNames}**` : ''}.`,
    decisionPendingLine: (proposedCount, agreedCount) =>
      `- **Decisiones:** **${proposedCount}** pendiente(s) de aprobación${agreedCount > 0 ? ` · **${agreedCount}** acordada(s) recientemente` : ''}.`,
    calmWorkspaceLine: (completedCount, activeStreams) =>
      `- **Impulso:** ${completedCount > 0 ? `**${completedCount}** tarea(s) completada(s) recientemente` : 'Horizonte despejado'}${activeStreams ? ` en **${activeStreams}**` : ''}.`,
    autoUpdatedBanner: (humanDate, isoDate, focusCount, tomorrowCount, decisionsCount) =>
      `> **Informe diario** · **${humanDate}** (${isoDate}) · **${focusCount}** Hoy · **${tomorrowCount}** Mañana · **${decisionsCount}** Decisión(es) pendiente(s).`,
    retroSectionHeading: 'Retro diaria y señales',
    actionItemsRollupHeading: 'Horizontes de acción',
    todaysFocusHeading: 'Foco de hoy',
    tomorrowHorizonHeading: 'Mañana',
    thisWeekHorizonHeading: 'Esta semana',
    sometimeParkedHeading: (count) => `Algún día / Aparcadas (${count})`,
    recentlyCompletedHeading: (count) => `Completadas recientemente (${count})`,
    decisionsRegisterHeading: 'Radar de decisiones',
    pendingDecisionsHeading: 'Pendientes de aprobación',
    recentAgreedDecisionsHeading: 'Acordadas recientemente',
    recentNotesHeading: 'Notas clave y recientes',
    untitledNote: 'Nota sin título',
    internalLabel: 'Interno',
    inboxLabel: 'Entrada',
  },
  it: {
    overdueDuePrefix: 'SCADUTA · scadenza',
    dueToday: 'OGGI',
    duePrefix: 'scadenza',
    fromPrefix: 'da',
    proposedNeedsSignoff: 'PROPOSTA · Richiede approvazione',
    rationaleLabel: 'Motivazione',
    retroNoteLabel: 'Nota',
    statusLabels: {
      todo: 'DA FARE',
      doing: 'IN CORSO',
      waiting: 'IN ATTESA',
      done: 'COMPLETATO',
      proposed: 'PROPOSTA',
      agreed: 'APPROVATA',
    },
    emptyOverviewHeading: 'Panoramica esecutiva giornaliera',
    emptyOverviewBody:
      'Il tuo spazio non contiene ancora note sorgente. Crea una nota (`Alt+N`) e usa la **Retro giornaliera** per valutare le note e pianificare le attività.',
    emptyBanner: (humanDate, isoDate) =>
      `> **Briefing giornaliero** per **${humanDate}** (${isoDate}).`,
    executivePulseHeading: 'Sintesi Chief-of-Staff',
    focusPulseLine: (focusCount, overdueCount, tomorrowCount, parkedCount) =>
      `- **Orizzonte di oggi:** **${focusCount}** attività in focus oggi${overdueCount > 0 ? ` (**${overdueCount}** scaduta/e)` : ''}${tomorrowCount > 0 ? ` · **${tomorrowCount}** per domani` : ''}${parkedCount > 0 ? ` · **${parkedCount}** pianificata/e più avanti` : ''}.`,
    steeringCalloutLine: (note) => `- **Indicazione Retro:** *"${note}"*`,
    highSignalTakeawaysHeading: 'Contesto chiave e slancio',
    watchlistSignalsHeading: 'Follow-up e attenzione',
    waitingOnLine: (peopleSummary) => `- **Follow-up raggruppati:** In attesa di ${peopleSummary}.`,
    driftSignalLine: (staleCount, silentProjectNames) =>
      `- **Radar di stallo:** ${staleCount > 0 ? `**${staleCount}** elemento/i in stallo o senza responsabile` : ''}${staleCount > 0 && silentProjectNames ? ' · ' : ''}${silentProjectNames ? `Progetti silenziosi: **${silentProjectNames}**` : ''}.`,
    decisionPendingLine: (proposedCount, agreedCount) =>
      `- **Decisioni:** **${proposedCount}** in attesa di approvazione${agreedCount > 0 ? ` · **${agreedCount}** approvata/e di recente` : ''}.`,
    calmWorkspaceLine: (completedCount, activeStreams) =>
      `- **Slancio:** ${completedCount > 0 ? `**${completedCount}** attività completata/e di recente` : 'Orizzonte libero'}${activeStreams ? ` su **${activeStreams}**` : ''}.`,
    autoUpdatedBanner: (humanDate, isoDate, focusCount, tomorrowCount, decisionsCount) =>
      `> **Report giornaliero** · **${humanDate}** (${isoDate}) · **${focusCount}** Oggi · **${tomorrowCount}** Domani · **${decisionsCount}** Decisione/i in sospeso.`,
    retroSectionHeading: 'Retro giornaliera e segnali',
    actionItemsRollupHeading: 'Orizzonti operativi',
    todaysFocusHeading: 'Focus di oggi',
    tomorrowHorizonHeading: 'Domani',
    thisWeekHorizonHeading: 'Questa settimana',
    sometimeParkedHeading: (count) => `Prima o poi / In parcheggio (${count})`,
    recentlyCompletedHeading: (count) => `Completate di recente (${count})`,
    decisionsRegisterHeading: 'Radar delle decisioni',
    pendingDecisionsHeading: 'In attesa di approvazione',
    recentAgreedDecisionsHeading: 'Approvate di recente',
    recentNotesHeading: 'Note chiave e recenti',
    untitledNote: 'Nota senza titolo',
    internalLabel: 'Interno',
    inboxLabel: 'In arrivo',
  },
};

function formatTaskRollupBullet(
  t: ParsedTask,
  todayDate: string,
  directory: WorkspaceDirectory,
  language: AiOutputLanguage = 'en'
): string {
  const copy = BRIEFING_COPY[language];
  const badges: string[] = [];
  const plan = getTaskRetroPlan(directory.dailyRetro, t);
  if (plan?.starred) {
    badges.push('★ FOCUS');
  }
  if (t.dueDate && t.dueDate < todayDate) {
    badges.push(`${copy.overdueDuePrefix} ${t.dueDate}`);
  } else if (t.dueDate === todayDate) {
    badges.push(copy.dueToday);
  } else if (t.dueDate) {
    badges.push(`${copy.duePrefix} ${t.dueDate}`);
  }
  if (t.priority === 'high') {
    badges.push('!HIGH');
  }
  badges.push(copy.statusLabels[t.status] || t.status.toUpperCase());

  const ownerMention = t.owner ? formatPersonMention(t.owner) : null;
  const alreadyHasOwner =
    ownerMention && t.text.toLowerCase().includes(t.owner!.toLowerCase());
  const ownerSuffix = ownerMention && !alreadyHasOwner ? ` (${ownerMention})` : '';
  const labelsSuffix =
    t.labels.length > 0
      ? ` ${t.labels
          .slice(0, 3)
          .map((l) => `#${l}`)
          .join(' ')}`
      : '';
  const commentSuffix = plan?.comment
    ? `\n  > *${copy.retroNoteLabel}: ${plan.comment}*`
    : '';

  return `- **[${badges.join(' · ')}]** ${t.text}${ownerSuffix}${labelsSuffix} — *${copy.fromPrefix} [[${t.noteTitle}]]*${commentSuffix}`;
}

function formatDecisionRollupBullet(
  d: ParsedDecision,
  directory: WorkspaceDirectory,
  language: AiOutputLanguage = 'en'
): string {
  const copy = BRIEFING_COPY[language];
  const fb = getDecisionRetroFeedback(directory.dailyRetro, d);
  const statusTag =
    d.status === 'proposed'
      ? copy.proposedNeedsSignoff
      : copy.statusLabels[d.status as keyof typeof copy.statusLabels] || d.status.toUpperCase();
  const rationaleSuffix = d.rationale ? ` — *${copy.rationaleLabel}: ${d.rationale}*` : '';
  const labelsSuffix =
    d.labels.length > 0
      ? ` ${d.labels
          .slice(0, 3)
          .map((l) => `#${l}`)
          .join(' ')}`
      : '';
  const commentSuffix = fb?.comment
    ? `\n  > *${copy.retroNoteLabel}: ${fb.comment}*`
    : '';
  return `- **[${statusTag}]** ${d.text}${rationaleSuffix}${labelsSuffix} — *${copy.fromPrefix} [[${d.noteTitle}]] (${d.noteDate})*${commentSuffix}`;
}

function sanitizeRollupMarkdown(md: string, language: AiOutputLanguage = 'en'): string {
  const copy = BRIEFING_COPY[language];
  return md
    .replace(/^(\s*[-*+•]\s*)\[([ /?xX])\]\s+/gm, (_, prefix: string, ch: string) => {
      const label =
        ch === '/'
          ? copy.statusLabels.doing
          : ch === '?'
          ? copy.statusLabels.waiting
          : ch.toLowerCase() === 'x'
          ? copy.statusLabels.done
          : copy.statusLabels.todo;
      return `${prefix}**[${label}]** `;
    })
    .replace(/^(\s*[-*+•]\s*)\[D(?::([a-zA-Z_-]+))?\]\s+/gim, (_, prefix: string, st?: string) => {
      const normalized = (st || 'agreed').toLowerCase();
      const localized =
        normalized === 'proposed'
          ? copy.statusLabels.proposed
          : normalized === 'agreed'
          ? copy.statusLabels.agreed
          : (st || 'AGREED').toUpperCase();
      return `${prefix}**[${localized}]** `;
    });
}

/**
 * Builds a high-signal, non-duplicative Chief-of-Staff synthesis.
 * Instead of repeating the interactive task inventory below, it synthesizes:
 * - Your Retro steering note & horizon balance
 * - High-signal note takeaways & today's active client/project context
 * - Follow-up batches (@Person), drift/staleness signals, and pending decisions
 */
export function buildDeterministicDailyBriefing(
  data: DailyBriefingData,
  directory: WorkspaceDirectory,
  language: AiOutputLanguage = 'en'
): {
  overviewMarkdown: string;
  fullNoteMarkdown: string;
  usedProvider: string;
} {
  const copy = BRIEFING_COPY[language];
  const humanDate = formatHumanDate(data.todayDate, language);

  if (data.sourceNotes.length === 0) {
    const emptyOverview = [
      `### ${copy.emptyOverviewHeading} — ${humanDate}`,
      '',
      copy.emptyOverviewBody,
    ].join('\n');

    return {
      overviewMarkdown: emptyOverview,
      fullNoteMarkdown: [
        copy.emptyBanner(humanDate, data.todayDate),
        '',
        emptyOverview,
      ].join('\n'),
      usedProvider: 'Local Smart Engine',
    };
  }

  const activeStreamNames = new Set<string>();
  for (const n of data.visibleRecentNotes) {
    if (n.clientId) {
      const c = directory.clients.find((x) => x.id === n.clientId);
      if (c) activeStreamNames.add(c.name);
    } else if (n.projectId) {
      const p = directory.projects.find((x) => x.id === n.projectId);
      if (p) activeStreamNames.add(p.name);
    }
  }
  const activeStreamsStr = Array.from(activeStreamNames).slice(0, 4).join(', ');

  const effectiveSteering = data.todaySteeringNote || data.carryoverSteeringNote;
  const parkedCount = data.thisWeekTasks.length + data.sometimeTasks.length;

  const overviewLines: string[] = [
    `### ${copy.executivePulseHeading} — ${humanDate}`,
  ];

  if (effectiveSteering) {
    overviewLines.push(copy.steeringCalloutLine(effectiveSteering));
  }

  overviewLines.push(
    copy.focusPulseLine(
      data.focusTodayTasks.length,
      data.overdueTasks.length,
      data.tomorrowTasks.length,
      parkedCount
    )
  );

  overviewLines.push(
    copy.calmWorkspaceLine(data.recentlyCompletedTasks.length, activeStreamsStr)
  );

  // High-Signal Takeaways & Context Prep
  const contextBullets: string[] = [];
  for (const hn of data.highSignalNotes.slice(0, 3)) {
    const fb = getNoteRetroFeedback(directory.dailyRetro, hn.id);
    const title = hn.title || copy.untitledNote;
    const summaryText = fb?.comment
      ? fb.comment
      : stripMarkdownFormatting(hn.body).slice(0, 120).trimEnd();
    contextBullets.push(
      `- **★ [[${title}]]** (${hn.date})${summaryText ? ` — ${summaryText}${summaryText.length >= 120 && !fb?.comment ? '…' : ''}` : ''}`
    );
  }

  for (const prep of data.signals.todayContextPrep.slice(0, 2)) {
    const noteLinks = prep.todayNoteTitles
      .slice(0, 2)
      .map((t) => `[[${t}]]`)
      .join(', ');
    contextBullets.push(
      `- **${prep.label}** (${noteLinks || data.todayDate}): **${prep.openTaskCount}** open task(s)${
        prep.pendingDecisionCount > 0 ? `, **${prep.pendingDecisionCount}** pending decision(s)` : ''
      }.`
    );
  }

  if (data.signals.emergingLabels.length > 0 && contextBullets.length < 3) {
    const topThemes = data.signals.emergingLabels
      .slice(0, 3)
      .map((item) => `#${item.label} (${item.count})`)
      .join(' · ');
    contextBullets.push(`- **Active Themes:** ${topThemes}`);
  }

  if (contextBullets.length > 0) {
    overviewLines.push('', `### ${copy.highSignalTakeawaysHeading}`, ...contextBullets);
  }

  // Watchlist & Follow-ups (People batches, Drift/Stale items, Pending Decisions)
  const watchBullets: string[] = [];

  if (data.signals.waitingByPerson.length > 0) {
    const peopleSummary = data.signals.waitingByPerson
      .slice(0, 4)
      .map(
        (g) =>
          `${formatPersonMention(g.personName)} (**${g.totalCount}**${g.oldestDays >= 5 ? `, ${g.oldestDays}d` : ''})`
      )
      .join(', ');
    watchBullets.push(copy.waitingOnLine(peopleSummary));
  }

  if (data.activeProposedDecisions.length > 0) {
    watchBullets.push(
      copy.decisionPendingLine(
        data.activeProposedDecisions.length,
        data.recentAgreedDecisions.length
      )
    );
  }

  if (data.signals.staleItems.length > 0 || data.signals.silentProjects.length > 0) {
    const silentNames = data.signals.silentProjects
      .slice(0, 2)
      .map((sp) => `${sp.project.name} (${sp.daysSinceLastNote}d)`)
      .join(', ');
    watchBullets.push(copy.driftSignalLine(data.signals.staleItems.length, silentNames));
  }

  // Surface any explicit retro comments on Today's Focus tasks so AI/local overview calls them out
  const commentedFocusTasks = data.focusTodayTasks
    .filter((t) => Boolean(getTaskRetroPlan(directory.dailyRetro, t)?.comment))
    .slice(0, 2);
  for (const ct of commentedFocusTasks) {
    const comment = getTaskRetroPlan(directory.dailyRetro, ct)?.comment;
    watchBullets.push(`- **${ct.text}** ([[${ct.noteTitle}]]) — *${comment}*`);
  }

  if (watchBullets.length > 0) {
    overviewLines.push('', `### ${copy.watchlistSignalsHeading}`, ...watchBullets);
  }

  const overviewMarkdown = overviewLines.join('\n');
  const fullNoteMarkdown = composeFullDailyNoteMarkdown(
    overviewMarkdown,
    data,
    directory,
    language
  );

  return {
    overviewMarkdown,
    fullNoteMarkdown,
    usedProvider: 'Local Smart Engine',
  };
}

export function composeFullDailyNoteMarkdown(
  overviewMarkdown: string,
  data: DailyBriefingData,
  directory: WorkspaceDirectory,
  language: AiOutputLanguage = 'en'
): string {
  const copy = BRIEFING_COPY[language];
  const humanDate = formatHumanDate(data.todayDate, language);
  const sections: string[] = [
    copy.autoUpdatedBanner(
      humanDate,
      data.todayDate,
      data.focusTodayTasks.length,
      data.tomorrowTasks.length,
      data.activeProposedDecisions.length
    ),
    '',
    sanitizeRollupMarkdown(overviewMarkdown.trim(), language),
  ];

  // Daily Retro & Steering Log (if present)
  const effectiveSteering = data.todaySteeringNote || data.carryoverSteeringNote;
  if (effectiveSteering || data.highSignalNotes.length > 0) {
    sections.push('', '---', '', `## ${copy.retroSectionHeading}`);
    if (effectiveSteering) {
      sections.push(`> **AI Steering:** ${effectiveSteering}`);
    }
    for (const hn of data.highSignalNotes.slice(0, 5)) {
      const fb = getNoteRetroFeedback(directory.dailyRetro, hn.id);
      sections.push(
        `- **★ [[${hn.title || copy.untitledNote}]]** (${hn.date})${
          fb?.comment ? ` — *${fb.comment}*` : ''
        }`
      );
    }
  }

  // Horizon-Bucketed Action Items
  if (data.allOpenTasks.length > 0 || data.recentlyCompletedTasks.length > 0) {
    sections.push('', '---', '', `## ${copy.actionItemsRollupHeading}`);

    if (data.focusTodayTasks.length > 0) {
      sections.push('', `### ${copy.todaysFocusHeading}`);
      for (const t of data.focusTodayTasks.slice(0, 10)) {
        sections.push(formatTaskRollupBullet(t, data.todayDate, directory, language));
      }
    }

    if (data.tomorrowTasks.length > 0) {
      sections.push('', `### ${copy.tomorrowHorizonHeading}`);
      for (const t of data.tomorrowTasks.slice(0, 8)) {
        sections.push(formatTaskRollupBullet(t, data.todayDate, directory, language));
      }
    }

    if (data.thisWeekTasks.length > 0) {
      sections.push('', `### ${copy.thisWeekHorizonHeading}`);
      for (const t of data.thisWeekTasks.slice(0, 10)) {
        sections.push(formatTaskRollupBullet(t, data.todayDate, directory, language));
      }
    }

    if (data.sometimeTasks.length > 0) {
      sections.push('', `### ${copy.sometimeParkedHeading(data.sometimeTasks.length)}`);
      for (const t of data.sometimeTasks.slice(0, 6)) {
        sections.push(formatTaskRollupBullet(t, data.todayDate, directory, language));
      }
    }

    if (data.recentlyCompletedTasks.length > 0) {
      sections.push('', `### ${copy.recentlyCompletedHeading(data.recentlyCompletedTasks.length)}`);
      for (const t of data.recentlyCompletedTasks.slice(0, 6)) {
        sections.push(formatTaskRollupBullet(t, data.todayDate, directory, language));
      }
    }
  }

  // Decisions Breakdown
  if (data.activeProposedDecisions.length > 0 || data.recentAgreedDecisions.length > 0) {
    sections.push('', '---', '', `## ${copy.decisionsRegisterHeading}`);

    if (data.activeProposedDecisions.length > 0) {
      sections.push('', `### ${copy.pendingDecisionsHeading}`);
      for (const d of data.activeProposedDecisions) {
        sections.push(formatDecisionRollupBullet(d, directory, language));
      }
    }

    if (data.recentAgreedDecisions.length > 0) {
      sections.push('', `### ${copy.recentAgreedDecisionsHeading}`);
      for (const d of data.recentAgreedDecisions.slice(0, 8)) {
        sections.push(formatDecisionRollupBullet(d, directory, language));
      }
    }
  }

  // Filtered Recent Notes Summary (excluding low-rated archive notes)
  if (data.visibleRecentNotes.length > 0) {
    sections.push('', '---', '', `## ${copy.recentNotesHeading}`);
    for (const n of data.visibleRecentNotes.slice(0, 8)) {
      const client = n.clientId ? directory.clients.find((c) => c.id === n.clientId) : null;
      const proj = n.projectId ? directory.projects.find((p) => p.id === n.projectId) : null;
      const contextStr = client
        ? `${client.name}${proj ? ` · ${proj.name}` : ''}`
        : n.scope === 'internal'
        ? `${copy.internalLabel}${proj ? ` · ${proj.name}` : ''}`
        : copy.inboxLabel;
      const people = Array.from(
        new Set([...n.participants, ...extractInlineMentions(n.body, directory.people)])
      );
      const peopleStr =
        people.length > 0
          ? ` · ${people
              .slice(0, 4)
              .map((p) => formatPersonMention(p))
              .join(', ')}`
          : '';
      const labels = getAllNoteLabels(n);
      const labelsStr =
        labels.length > 0
          ? ` · ${labels
              .slice(0, 4)
              .map((l) => `#${l}`)
              .join(' ')}`
          : '';
      const fb = getNoteRetroFeedback(directory.dailyRetro, n.id);
      const signalBadge = fb?.rating === 'high' ? '★ ' : '';
      const rawPreview = stripMarkdownFormatting(n.body);
      const snippet = fb?.comment
        ? `*${copy.retroNoteLabel}: ${fb.comment}*`
        : rawPreview.length > 160
        ? `${rawPreview.slice(0, 160).trimEnd()}…`
        : rawPreview;

      sections.push(
        `- **${signalBadge}${n.date} — [[${n.title || copy.untitledNote}]]** (${contextStr}${peopleStr}${labelsStr})${
          snippet ? `\n  ${snippet}` : ''
        }`
      );
    }
  }

  return sections.join('\n').trim();
}

export async function generateDailyBriefingWithAiOrFallback(
  data: DailyBriefingData,
  directory: WorkspaceDirectory,
  config: AiConfig
): Promise<{
  overviewMarkdown: string;
  fullNoteMarkdown: string;
  usedProvider: string;
  language: AiOutputLanguage;
  privacyReport?: AiPrivacyReport;
}> {
  const language = getEffectiveAiLanguage(config);
  const copy = BRIEFING_COPY[language];
  const langMeta = AI_LANGUAGE_OPTIONS.find((opt) => opt.code === language);
  const humanDate = formatHumanDate(data.todayDate, language);

  return withAiActivity('AI: Synthesizing daily briefing…', config, async () => {
    const localResult = buildDeterministicDailyBriefing(data, directory, language);
    if (
      config.provider === 'local' ||
      !config.apiKey.trim() ||
      data.sourceNotes.length === 0
    ) {
      return { ...localResult, language };
    }

    try {
      const retroStore = directory.dailyRetro;

      const formatTaskForPrompt = (t: ParsedTask, horizonLabel: string) => {
        const plan = getTaskRetroPlan(retroStore, t);
        const commentPart = plan?.comment ? ` | User Retro Comment: "${plan.comment}"` : '';
        const starPart = plan?.starred ? ' [★ USER STARRED]' : '';
        return `- [${horizonLabel} · ${t.status.toUpperCase()}]${starPart} ${t.text} (Owner: ${
          t.owner ? formatPersonMention(t.owner) : 'Unassigned'
        }, Due: ${t.dueDate || 'None'}, Priority: ${t.priority || 'normal'}, Source: [[${
          t.noteTitle
        }]])${commentPart}`;
      };

      const focusTasksContext = [
        ...data.focusTodayTasks.slice(0, 10).map((t) => formatTaskForPrompt(t, 'TODAY')),
        ...data.tomorrowTasks.slice(0, 6).map((t) => formatTaskForPrompt(t, 'TOMORROW')),
        ...data.thisWeekTasks.slice(0, 6).map((t) => formatTaskForPrompt(t, 'THIS_WEEK')),
      ].join('\n');

      const decisionsContext = [
        ...data.activeProposedDecisions.slice(0, 8),
        ...data.recentAgreedDecisions.slice(0, 5),
      ]
        .map((d) => {
          const fb = getDecisionRetroFeedback(retroStore, d);
          const ratingTag = fb?.rating === 'high' ? ' [★ KEY DECISION]' : '';
          const commentPart = fb?.comment ? ` | User Retro Comment: "${fb.comment}"` : '';
          return `- [${d.status.toUpperCase()}]${ratingTag} ${d.text}${
            d.rationale ? ` (Rationale: ${d.rationale})` : ''
          } (Source: [[${d.noteTitle}]], ${d.noteDate})${commentPart}`;
        })
        .join('\n');

      const notesContext = data.visibleRecentNotes
        .slice(0, 7)
        .map((n) => {
          const client = n.clientId
            ? directory.clients.find((c) => c.id === n.clientId)?.name
            : null;
          const fb = getNoteRetroFeedback(retroStore, n.id);
          const signalTag = fb?.rating === 'high' ? ' [★ HIGH SIGNAL]' : '';
          const commentLine = fb?.comment ? `\nUser Retro Takeaway: "${fb.comment}"` : '';
          const title = n.title || 'Untitled Note';
          return `[[${title}]]${signalTag} (${n.date}${client ? ` · ${client}` : ''}):${commentLine}\n${n.body.slice(
            0,
            750
          )}`;
        })
        .join('\n\n');

      const waitingContext = data.signals.waitingByPerson
        .map(
          (g) =>
            `- ${formatPersonMention(g.personName)}: ${g.totalCount} item(s), oldest ${g.oldestDays}d`
        )
        .join('\n');

      const driftContext = [
        ...data.signals.staleItems.slice(0, 5).map(
          (s) => `- [${s.kind.toUpperCase()} · ${s.ageDays}d] ${s.title} ([[${s.noteTitle}]])`
        ),
        ...data.signals.silentProjects.map(
          (sp) => `- [SILENT_PROJECT · ${sp.daysSinceLastNote}d] ${sp.project.name}`
        ),
      ].join('\n');

      const steeringLines: string[] = [];
      if (data.todaySteeringNote) {
        steeringLines.push(`Today's Retro Steering Note: "${data.todaySteeringNote}"`);
      }
      if (data.carryoverSteeringNote && data.carryoverSteeringNote !== data.todaySteeringNote) {
        steeringLines.push(
          `Yesterday Evening's Commute Retro Note for Today: "${data.carryoverSteeringNote}"`
        );
      }

      const languageInstruction =
        language === 'en'
          ? 'Write the entire synthesis in English.'
          : `Write the ENTIRE synthesis (all prose, bullet points, and status callouts) in ${langMeta?.englishName || language} (${langMeta?.label || language}), keeping proper nouns, exact [[Note Title]] links, @[Full Name] mentions, and #label tags intact.`;

      const systemPrompt = `You are a calm, razor-sharp executive Chief-of-Staff AI writing the top synthesis card of a Daily Briefing for ${humanDate} (${data.todayDate}).
${languageInstruction}

CRITICAL ANTI-CLUTTER GOAL:
Interactive task cards and decision cards are ALREADY displayed right below your synthesis in the UI. DO NOT dump or repeat a raw inventory of tasks!
Instead, keep your entire response under 170 words using ONLY these concise sections (omit a section if empty):

### ${copy.executivePulseHeading} — ${humanDate}
(2–3 crisp bullets honoring the user's Retro Steering Note first, summarizing today's true focus vs. parked horizons, and connecting cross-note priorities)
### ${copy.highSignalTakeawaysHeading}
(1–3 bullets distilling insights from ★ HIGH SIGNAL notes, user retro comments, and active client/project momentum)
### ${copy.watchlistSignalsHeading}
(1–3 bullets highlighting batch follow-ups by @[Full Name], stalled/unassigned drift risks, or key decisions needing sign-off)

IMPORTANT RULES:
- Treat User Retro Steering Notes, ★ ratings, horizon buckets, and per-item User Retro Comments as ground-truth executive intent.
- Cite source notes inline using [[Exact Note Title]], people using @[Full Name], and themes using #label.
- Never use raw "- [ ]" or "- [D:...]" checkbox syntax.`;

      const userPrompt = `Today's Date: ${data.todayDate}

User Daily Retro Steering (Highest Priority):
${steeringLines.join('\n') || 'None'}

Horizon Counts: ${data.focusTodayTasks.length} in Today's Focus (${data.overdueTasks.length} overdue), ${data.tomorrowTasks.length} Tomorrow, ${data.thisWeekTasks.length} This Week, ${data.sometimeTasks.length} parked in Sometime (excluded below).

Prioritized Tasks & User Comments:
${focusTasksContext || 'None'}

Active Decisions & User Comments:
${decisionsContext || 'None'}

Waiting-on-Person Follow-up Clusters:
${waitingContext || 'None'}

Drift / Staleness Signals:
${driftContext || 'None'}

Recent High-Signal & Active Notes (${data.hiddenLowSignalNotesCount} low-signal notes filtered out):
${notesContext || 'None'}`;

      const llmRes = await callConfiguredLlmDetailed(systemPrompt, userPrompt, config, {
        directory,
        notes: data.sourceNotes,
      });
      const cleanedOverview = sanitizeRollupMarkdown(
        unwrapOuterMarkdownFence(llmRes.text),
        language
      );
      if (!cleanedOverview) {
        return { ...localResult, language, privacyReport: llmRes.privacyReport };
      }

      const providerLabel = formatAiEngineLabel(config);
      const fullNoteMarkdown = composeFullDailyNoteMarkdown(
        cleanedOverview,
        data,
        directory,
        language
      );

      return {
        overviewMarkdown: cleanedOverview,
        fullNoteMarkdown,
        usedProvider: providerLabel,
        language,
        privacyReport: llmRes.privacyReport,
      };
    } catch {
      return {
        ...localResult,
        language,
        usedProvider: 'Local Smart Engine (Fallback)',
      };
    }
  });
}

export function buildDailyBriefingNote(params: {
  existingNote?: Note;
  todayDate: string;
  fullNoteMarkdown: string;
  directory: WorkspaceDirectory;
}): Note {
  const nowIso = new Date().toISOString();
  const base: Note = {
    id: DAILY_BRIEFING_NOTE_ID,
    title: `Daily Briefing — ${params.todayDate}`,
    date: params.todayDate,
    scope: 'internal',
    clientId: null,
    projectId: null,
    participants: params.existingNote?.participants || [],
    labels: Array.from(
      new Set([...(params.existingNote?.labels || []), DAILY_BRIEFING_LABEL, 'report'])
    ),
    body: params.fullNoteMarkdown,
    createdAt: params.existingNote?.createdAt || nowIso,
    updatedAt: nowIso,
  };
  return {
    ...base,
    filePath: computeNoteFilePath(base, params.directory),
  };
}
