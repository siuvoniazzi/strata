import type {
  DailyRetroDayEntry,
  DailyRetroStore,
  DecisionRetroFeedback,
  Note,
  NoteRetroFeedback,
  ParsedDecision,
  ParsedTask,
  Project,
  RetroSignalRating,
  TaskHorizonBucket,
  TaskRetroPlan,
  WorkspaceDirectory,
} from '../types';
import {
  extractInlineMentions,
  getAllNoteLabels,
  isDailyBriefingNote,
  parseNoteItems,
} from './markdown';

export type EffectiveTaskHorizon = 'today' | 'tomorrow' | 'this-week' | 'sometime';

export interface WaitingOnPersonGroup {
  personName: string;
  clientName?: string;
  tasks: ParsedTask[];
  decisions: ParsedDecision[];
  totalCount: number;
  oldestDays: number;
}

export interface StaleSignalItem {
  id: string;
  kind: 'waiting-task' | 'proposed-decision' | 'unassigned-urgent';
  title: string;
  noteId: string;
  noteTitle: string;
  ageDays: number;
  personName?: string | null;
  clientName?: string | null;
}

export interface SilentProjectSignal {
  project: Project;
  clientName?: string | null;
  daysSinceLastNote: number | null;
  lastNoteDate?: string | null;
}

export interface TodayContextPrepItem {
  id: string;
  label: string;
  color?: string;
  todayNoteTitles: string[];
  openTaskCount: number;
  pendingDecisionCount: number;
  clientId?: string | null;
  projectId?: string | null;
}

export interface WorkspaceSignals {
  waitingByPerson: WaitingOnPersonGroup[];
  staleItems: StaleSignalItem[];
  silentProjects: SilentProjectSignal[];
  todayContextPrep: TodayContextPrepItem[];
  emergingLabels: Array<{ label: string; count: number }>;
  untriagedInboxCount: number;
}

export interface DailyRetroQueueSummary {
  todayDate: string;
  isCompletedToday: boolean;
  completedAt: string | null;
  steeringNote: string;
  notesQueue: Note[];
  tasksQueue: ParsedTask[];
  decisionsQueue: ParsedDecision[];
  reviewedNotesToday: number;
  reviewedTasksToday: number;
  reviewedDecisionsToday: number;
  pendingNotesCount: number;
  pendingTasksCount: number;
  pendingDecisionsCount: number;
  totalPendingCount: number;
  totalItemsCount: number;
  usedFallbackWindow: boolean;
}

export function createEmptyDailyRetroStore(): DailyRetroStore {
  return {
    notes: {},
    tasks: {},
    decisions: {},
    days: {},
  };
}

export function addDaysIso(baseDateStr: string, days: number): string {
  const d = new Date(`${baseDateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return baseDateStr;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenIso(earlierIso: string, laterIso: string): number {
  const a = new Date(`${earlierIso}T12:00:00`).getTime();
  const b = new Date(`${laterIso}T12:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Computes a sensible end-of-week ISO date for "This Week":
 * - Mon–Wed: upcoming Sunday of the current week
 * - Thu–Sun: rolling +6 days so Friday/weekend commute triage doesn't expire immediately on Monday morning
 */
export function computeThisWeekUntilDate(todayDate: string): string {
  const d = new Date(`${todayDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return addDaysIso(todayDate, 6);
  const dayOfWeek = d.getDay(); // 0 = Sun, 1 = Mon ... 6 = Sat
  if (dayOfWeek >= 1 && dayOfWeek <= 3) {
    const daysToSunday = 7 - dayOfWeek;
    return addDaysIso(todayDate, daysToSunday);
  }
  return addDaysIso(todayDate, 6);
}

function normalizeFingerprint(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\bdue:\d{4}-\d{2}-\d{2}\b/gi, '')
    .replace(/(?:^|\s)!(?:high|medium|med|low)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

export function getTaskRetroKey(task: Pick<ParsedTask, 'noteId' | 'text'>): string {
  return `${task.noteId}::t::${normalizeFingerprint(task.text)}`;
}

export function getDecisionRetroKey(decision: Pick<ParsedDecision, 'noteId' | 'text'>): string {
  return `${decision.noteId}::d::${normalizeFingerprint(decision.text)}`;
}

export function getNoteRetroFeedback(
  store: DailyRetroStore | undefined,
  noteId: string
): NoteRetroFeedback | undefined {
  return store?.notes?.[noteId];
}

export function getTaskRetroPlan(
  store: DailyRetroStore | undefined,
  task: Pick<ParsedTask, 'id' | 'noteId' | 'text'>
): TaskRetroPlan | undefined {
  if (!store?.tasks) return undefined;
  const key = getTaskRetroKey(task);
  if (store.tasks[key]) return store.tasks[key];
  return Object.values(store.tasks).find((entry) => entry.taskId === task.id);
}

export function getDecisionRetroFeedback(
  store: DailyRetroStore | undefined,
  decision: Pick<ParsedDecision, 'id' | 'noteId' | 'text'>
): DecisionRetroFeedback | undefined {
  if (!store?.decisions) return undefined;
  const key = getDecisionRetroKey(decision);
  if (store.decisions[key]) return store.decisions[key];
  return Object.values(store.decisions).find((entry) => entry.decisionId === decision.id);
}

export function getDailyRetroDayEntry(
  store: DailyRetroStore | undefined,
  date: string
): DailyRetroDayEntry | undefined {
  return store?.days?.[date];
}

export function normalizeDailyRetroStore(raw?: Partial<DailyRetroStore> | null): DailyRetroStore {
  if (!raw || typeof raw !== 'object') {
    return createEmptyDailyRetroStore();
  }
  return {
    notes: { ...(raw.notes || {}) },
    tasks: { ...(raw.tasks || {}) },
    decisions: { ...(raw.decisions || {}) },
    days: { ...(raw.days || {}) },
  };
}

function pickNewerRecord<T extends { updatedAt?: string }>(
  mapA: Record<string, T> | undefined,
  mapB: Record<string, T> | undefined
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(mapA || {})) {
    if (v && typeof v === 'object') out[k] = { ...v };
  }
  for (const [k, v] of Object.entries(mapB || {})) {
    if (!v || typeof v !== 'object') continue;
    const existing = out[k];
    if (!existing || (v.updatedAt || '') >= (existing.updatedAt || '')) {
      out[k] = { ...v };
    }
  }
  return out;
}

/**
 * Multi-device LWW merge so Daily Retro triage done on a phone on the train
 * merges cleanly with desktop state via Google Drive / Folder Sync.
 */
export function mergeDailyRetroStores(
  a?: Partial<DailyRetroStore> | null,
  b?: Partial<DailyRetroStore> | null
): DailyRetroStore {
  const days = pickNewerRecord(a?.days, b?.days);
  // Keep day entries bounded to most recent 90 days so directory.json stays compact
  const sortedDates = Object.keys(days).sort((x, y) => y.localeCompare(x));
  if (sortedDates.length > 90) {
    for (const oldDate of sortedDates.slice(90)) {
      delete days[oldDate];
    }
  }

  return {
    notes: pickNewerRecord(a?.notes, b?.notes),
    tasks: pickNewerRecord(a?.tasks, b?.tasks),
    decisions: pickNewerRecord(a?.decisions, b?.decisions),
    days,
  };
}

export function computeDailyRetroSignature(
  store: DailyRetroStore | undefined,
  todayDate: string
): string {
  if (!store) return 'no-retro';
  const day = store.days[todayDate];
  const dayPart = day
    ? `${day.completedAt || 'open'}:${(day.steeringNote || '').length}:${day.updatedAt}`
    : 'none';
  const notesPart = Object.values(store.notes)
    .map((n) => `${n.noteId}:${n.rating}:${(n.comment || '').length}:${n.updatedAt}`)
    .sort()
    .join(',');
  const tasksPart = Object.values(store.tasks)
    .map(
      (t) =>
        `${t.key}:${t.bucket}:${t.targetDate || ''}:${t.starred ? 1 : 0}:${(t.comment || '').length}:${t.updatedAt}`
    )
    .sort()
    .join(',');
  const decsPart = Object.values(store.decisions)
    .map((d) => `${d.key}:${d.rating}:${(d.comment || '').length}:${d.updatedAt}`)
    .sort()
    .join(',');
  return `${dayPart}|n(${notesPart})|t(${tasksPart})|d(${decsPart})`;
}

/**
 * Resolves which horizon bucket an open task currently belongs to,
 * honoring explicit Daily Retro slotting + automatic day-over-day promotion.
 */
export function resolveEffectiveTaskHorizon(
  task: ParsedTask,
  store: DailyRetroStore | undefined,
  todayDate: string
): EffectiveTaskHorizon {
  const tomorrowDate = addDaysIso(todayDate, 1);
  const plus7Date = addDaysIso(todayDate, 7);
  const plan = getTaskRetroPlan(store, task);

  if (plan) {
    if (plan.bucket === 'sometime') {
      // Only override 'sometime' if user subsequently added a due date after the retro review
      if (task.dueDate && task.dueDate <= todayDate && plan.reviewedDate < task.noteDate) {
        return 'today';
      }
      return 'sometime';
    }

    if (plan.bucket === 'today') {
      return 'today';
    }

    if (plan.bucket === 'tomorrow') {
      const target = plan.targetDate || addDaysIso(plan.reviewedDate, 1);
      if (todayDate >= target) {
        return 'today';
      }
      return 'tomorrow';
    }

    if (plan.bucket === 'date') {
      const target = task.dueDate || plan.targetDate;
      if (!target) return 'this-week';
      if (target <= todayDate) return 'today';
      if (target === tomorrowDate) return 'tomorrow';
      if (target <= plus7Date) return 'this-week';
      return 'sometime';
    }

    if (plan.bucket === 'this-week') {
      // Promote to Today if hard due date arrives today (and wasn't deferred today)
      if (task.dueDate && task.dueDate <= todayDate && plan.reviewedDate < todayDate) {
        return 'today';
      }
      if (plan.untilDate && todayDate > plan.untilDate) {
        return 'today';
      }
      return 'this-week';
    }
  }

  // Fallback for tasks not yet slotted in Daily Retro
  if (task.dueDate) {
    if (task.dueDate <= todayDate) return 'today';
    if (task.dueDate === tomorrowDate) return 'tomorrow';
    if (task.dueDate <= plus7Date) return 'this-week';
    return 'sometime';
  }

  if (task.priority === 'high' || task.status === 'doing') {
    return 'today';
  }

  return 'this-week';
}

/**
 * Checks whether an overdue task was explicitly deferred by the user (e.g. to This Week or Sometime)
 * so it doesn't keep screaming as an unacknowledged overdue alert.
 */
export function isTaskActivelyOverdue(
  task: ParsedTask,
  store: DailyRetroStore | undefined,
  todayDate: string
): boolean {
  if (task.status === 'done' || !task.dueDate || task.dueDate >= todayDate) {
    return false;
  }
  const horizon = resolveEffectiveTaskHorizon(task, store, todayDate);
  return horizon === 'today';
}

/**
 * Computes a composite priority score so "Today's Focus" surfaces the highest-leverage items first.
 */
export function scoreTaskForFocus(
  task: ParsedTask,
  store: DailyRetroStore | undefined,
  todayDate: string,
  activeTodayContextIds?: { clientIds: Set<string>; projectIds: Set<string> }
): number {
  let score = 0;
  const plan = getTaskRetroPlan(store, task);

  if (plan?.starred) score += 35;
  if (plan?.bucket === 'today') score += 26;
  else if (plan?.bucket === 'tomorrow' || plan?.bucket === 'date') score += 22;

  if (task.dueDate) {
    if (task.dueDate < todayDate) {
      const daysLate = Math.max(1, daysBetweenIso(task.dueDate, todayDate));
      score += 30 + Math.min(daysLate * 2, 14);
    } else if (task.dueDate === todayDate) {
      score += 28;
    }
  }

  if (task.priority === 'high') score += 18;
  else if (task.priority === 'medium') score += 7;

  if (task.status === 'doing') score += 12;
  else if (task.status === 'waiting') score += 4;

  if (plan?.comment?.trim()) score += 8;

  if (activeTodayContextIds) {
    if (task.clientId && activeTodayContextIds.clientIds.has(task.clientId)) score += 8;
    if (task.projectId && activeTodayContextIds.projectIds.has(task.projectId)) score += 6;
  }

  return score;
}

export function formatTaskHorizonLabel(
  task: ParsedTask,
  store: DailyRetroStore | undefined,
  todayDate: string
): string {
  const plan = getTaskRetroPlan(store, task);
  const effective = resolveEffectiveTaskHorizon(task, store, todayDate);
  if (plan?.bucket === 'date' && (task.dueDate || plan.targetDate) && effective !== 'today') {
    const dt = (task.dueDate || plan.targetDate)!;
    return dt.slice(5); // MM-DD
  }
  if (effective === 'today') return 'Today';
  if (effective === 'tomorrow') return 'Tomorrow';
  if (effective === 'this-week') return 'This Week';
  return 'Sometime';
}

/**
 * Builds the Daily Retro review queue for a given day.
 * Automatically falls back to last 48h if nothing was touched strictly today so a morning or late-night
 * commute retro still catches yesterday's untriaged items.
 */
export function computeDailyRetroQueue(
  notes: Note[],
  directory: WorkspaceDirectory,
  todayDate: string,
  options?: { includeRecent48h?: boolean }
): DailyRetroQueueSummary {
  const store = directory.dailyRetro;
  const yesterdayDate = addDaysIso(todayDate, -1);
  const recent7Date = addDaysIso(todayDate, -7);

  const sourceNotes = notes
    .filter((n) => !isDailyBriefingNote(n))
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));

  const strictlyTodayNotes = sourceNotes.filter(
    (n) =>
      n.date === todayDate ||
      n.updatedAt.slice(0, 10) === todayDate ||
      getNoteRetroFeedback(store, n.id)?.reviewedDate === todayDate
  );

  const recent48hNotes = sourceNotes.filter(
    (n) =>
      n.date >= yesterdayDate ||
      n.updatedAt.slice(0, 10) >= yesterdayDate ||
      getNoteRetroFeedback(store, n.id)?.reviewedDate === todayDate
  );

  const usedFallbackWindow =
    Boolean(options?.includeRecent48h) ||
    (strictlyTodayNotes.length === 0 && recent48hNotes.length > 0);

  const notesQueue = usedFallbackWindow ? recent48hNotes : strictlyTodayNotes;
  const queueNoteIds = new Set(notesQueue.map((n) => n.id));

  const allTasks: ParsedTask[] = [];
  const allDecisions: ParsedDecision[] = [];
  for (const n of sourceNotes) {
    const parsed = parseNoteItems(n, directory.people);
    allTasks.push(...parsed.tasks);
    allDecisions.push(...parsed.decisions);
  }

  const tasksQueue = allTasks.filter((t) => {
    const plan = getTaskRetroPlan(store, t);
    // Keep items already triaged in today's session stable in the deck
    if (plan?.reviewedDate === todayDate) return true;
    if (t.status === 'done') return false;
    // 1. Captured in today's (or active window's) notes
    if (queueNoteIds.has(t.noteId) || t.noteDate === todayDate) return true;
    // 2. Currently in Today's horizon (due today, overdue, carried over Today, or promoted Tomorrow)
    const effective = resolveEffectiveTaskHorizon(t, store, todayDate);
    if (effective === 'today') return true;
    // 3. Untriaged recent open tasks (last 7 days) that haven't been assigned a bucket yet
    if (!plan && t.noteDate >= recent7Date) return true;
    return false;
  });

  const decisionsQueue = allDecisions.filter((d) => {
    const fb = getDecisionRetroFeedback(store, d);
    if (fb?.reviewedDate === todayDate) return true;
    if (d.status === 'superseded') return false;
    if (d.status === 'proposed') return true;
    if (queueNoteIds.has(d.noteId) || d.noteDate === todayDate) return true;
    return false;
  });

  const reviewedNotesToday = notesQueue.filter(
    (n) => getNoteRetroFeedback(store, n.id)?.reviewedDate === todayDate
  ).length;

  const reviewedTasksToday = tasksQueue.filter(
    (t) => getTaskRetroPlan(store, t)?.reviewedDate === todayDate || t.status === 'done'
  ).length;

  const reviewedDecisionsToday = decisionsQueue.filter(
    (d) => getDecisionRetroFeedback(store, d)?.reviewedDate === todayDate
  ).length;

  const pendingNotesCount = Math.max(0, notesQueue.length - reviewedNotesToday);
  const pendingTasksCount = Math.max(0, tasksQueue.length - reviewedTasksToday);
  const pendingDecisionsCount = Math.max(0, decisionsQueue.length - reviewedDecisionsToday);
  const totalPendingCount = pendingNotesCount + pendingTasksCount + pendingDecisionsCount;
  const totalItemsCount = notesQueue.length + tasksQueue.length + decisionsQueue.length;

  const dayEntry = getDailyRetroDayEntry(store, todayDate);

  return {
    todayDate,
    isCompletedToday: Boolean(dayEntry?.completedAt),
    completedAt: dayEntry?.completedAt || null,
    steeringNote: dayEntry?.steeringNote || '',
    notesQueue,
    tasksQueue,
    decisionsQueue,
    reviewedNotesToday,
    reviewedTasksToday,
    reviewedDecisionsToday,
    pendingNotesCount,
    pendingTasksCount,
    pendingDecisionsCount,
    totalPendingCount,
    totalItemsCount,
    usedFallbackWindow,
  };
}

/**
 * Extracts high-signal workspace intelligence from existing notes, tasks, decisions, and directory metadata:
 * - Follow-up batches grouped by @Person
 * - Stale waiting tasks / proposed decisions (>5d) & unassigned urgent tasks
 * - Silent active projects (no notes in 14+ days)
 * - Context prep for clients/projects active today
 * - Emerging #label themes
 */
export function computeWorkspaceSignals(
  notes: Note[],
  directory: WorkspaceDirectory,
  todayDate: string
): WorkspaceSignals {
  const store = directory.dailyRetro;
  const sourceNotes = notes.filter((n) => !isDailyBriefingNote(n));
  const recent7Date = addDaysIso(todayDate, -7);

  const allTasks: ParsedTask[] = [];
  const allDecisions: ParsedDecision[] = [];
  for (const n of sourceNotes) {
    const parsed = parseNoteItems(n, directory.people);
    allTasks.push(...parsed.tasks);
    allDecisions.push(...parsed.decisions);
  }

  const openTasks = allTasks.filter((t) => t.status !== 'done');
  const activeOpenTasks = openTasks.filter(
    (t) => resolveEffectiveTaskHorizon(t, store, todayDate) !== 'sometime'
  );

  // 1. Waiting-on-Person batches
  const personBuckets = new Map<
    string,
    {
      personName: string;
      tasks: ParsedTask[];
      decisions: ParsedDecision[];
      oldestDays: number;
    }
  >();

  const ensurePersonBucket = (rawName: string) => {
    const clean = rawName.trim();
    const key = clean.toLowerCase();
    let b = personBuckets.get(key);
    if (!b) {
      const known = directory.people.find((p) => p.name.toLowerCase() === key);
      b = {
        personName: known ? known.name : clean,
        tasks: [],
        decisions: [],
        oldestDays: 0,
      };
      personBuckets.set(key, b);
    }
    return b;
  };

  for (const t of activeOpenTasks) {
    const isWaitingOrOverdue =
      t.status === 'waiting' || Boolean(t.dueDate && t.dueDate < todayDate && t.owner);
    if (!isWaitingOrOverdue) continue;
    const people = t.owner
      ? [t.owner]
      : extractInlineMentions(t.text, directory.people);
    const age = Math.max(0, daysBetweenIso(t.noteDate, todayDate));
    for (const p of people) {
      const b = ensurePersonBucket(p);
      if (!b.tasks.some((x) => x.id === t.id)) {
        b.tasks.push(t);
        if (age > b.oldestDays) b.oldestDays = age;
      }
    }
  }

  for (const d of allDecisions) {
    if (d.status !== 'proposed') continue;
    const fb = getDecisionRetroFeedback(store, d);
    if (fb?.rating === 'low') continue;
    const age = Math.max(0, daysBetweenIso(d.noteDate, todayDate));
    for (const p of d.stakeholders) {
      const b = ensurePersonBucket(p);
      if (!b.decisions.some((x) => x.id === d.id)) {
        b.decisions.push(d);
        if (age > b.oldestDays) b.oldestDays = age;
      }
    }
  }

  const waitingByPerson: WaitingOnPersonGroup[] = Array.from(personBuckets.values())
    .map((b) => {
      const personObj = directory.people.find(
        (p) => p.name.toLowerCase() === b.personName.toLowerCase()
      );
      const clientName = personObj?.clientId
        ? directory.clients.find((c) => c.id === personObj.clientId)?.name
        : undefined;
      return {
        personName: b.personName,
        clientName,
        tasks: b.tasks,
        decisions: b.decisions,
        totalCount: b.tasks.length + b.decisions.length,
        oldestDays: b.oldestDays,
      };
    })
    .filter((g) => g.totalCount > 0)
    .sort((a, b) => b.totalCount - a.totalCount || b.oldestDays - a.oldestDays)
    .slice(0, 6);

  // 2. Stale & Drift items
  const staleItems: StaleSignalItem[] = [];

  for (const t of activeOpenTasks) {
    const ageDays = daysBetweenIso(t.noteDate, todayDate);
    const clientName = t.clientId
      ? directory.clients.find((c) => c.id === t.clientId)?.name || null
      : null;

    if (t.status === 'waiting' && ageDays >= 5) {
      staleItems.push({
        id: `stale-w-${t.id}`,
        kind: 'waiting-task',
        title: t.text,
        noteId: t.noteId,
        noteTitle: t.noteTitle,
        ageDays,
        personName: t.owner,
        clientName,
      });
    } else if (
      !t.owner &&
      (t.priority === 'high' || (t.dueDate && t.dueDate <= addDaysIso(todayDate, 2)))
    ) {
      staleItems.push({
        id: `unassigned-${t.id}`,
        kind: 'unassigned-urgent',
        title: t.text,
        noteId: t.noteId,
        noteTitle: t.noteTitle,
        ageDays: Math.max(0, ageDays),
        personName: null,
        clientName,
      });
    }
  }

  for (const d of allDecisions) {
    if (d.status !== 'proposed') continue;
    const fb = getDecisionRetroFeedback(store, d);
    if (fb?.rating === 'low') continue;
    const ageDays = daysBetweenIso(d.noteDate, todayDate);
    if (ageDays >= 5) {
      const clientName = d.clientId
        ? directory.clients.find((c) => c.id === d.clientId)?.name || null
        : null;
      staleItems.push({
        id: `stale-d-${d.id}`,
        kind: 'proposed-decision',
        title: d.text,
        noteId: d.noteId,
        noteTitle: d.noteTitle,
        ageDays,
        personName: d.stakeholders[0] || null,
        clientName,
      });
    }
  }

  staleItems.sort((a, b) => b.ageDays - a.ageDays);

  // 3. Silent active projects (active status, no notes in >= 14 days)
  const silentProjects: SilentProjectSignal[] = [];
  if (sourceNotes.length >= 2) {
    for (const proj of directory.projects) {
      if (proj.status !== 'active') continue;
      const projNotes = sourceNotes.filter((n) => n.projectId === proj.id);
      if (projNotes.length === 0) continue;
      const latestDate = projNotes.reduce(
        (max, n) => (n.date > max ? n.date : max),
        projNotes[0].date
      );
      const daysSilent = daysBetweenIso(latestDate, todayDate);
      if (daysSilent >= 14) {
        const clientName = proj.clientId
          ? directory.clients.find((c) => c.id === proj.clientId)?.name || null
          : null;
        silentProjects.push({
          project: proj,
          clientName,
          daysSinceLastNote: daysSilent,
          lastNoteDate: latestDate,
        });
      }
    }
    silentProjects.sort(
      (a, b) => (b.daysSinceLastNote || 0) - (a.daysSinceLastNote || 0)
    );
  }

  // 4. Today's Context Prep (clients/projects touched today that carry open tasks/decisions)
  const todayNotes = sourceNotes.filter(
    (n) => n.date === todayDate || n.updatedAt.slice(0, 10) === todayDate
  );
  const todayContextMap = new Map<string, TodayContextPrepItem>();

  for (const n of todayNotes) {
    if (n.clientId) {
      const client = directory.clients.find((c) => c.id === n.clientId);
      if (!client) continue;
      const key = `client:${client.id}`;
      const existing = todayContextMap.get(key);
      if (existing) {
        if (n.title && !existing.todayNoteTitles.includes(n.title)) {
          existing.todayNoteTitles.push(n.title);
        }
      } else {
        const cTasks = activeOpenTasks.filter((t) => t.clientId === client.id).length;
        const cDecs = allDecisions.filter(
          (d) => d.clientId === client.id && d.status === 'proposed'
        ).length;
        if (cTasks > 0 || cDecs > 0) {
          todayContextMap.set(key, {
            id: key,
            label: client.name,
            color: client.color,
            todayNoteTitles: n.title ? [n.title] : [],
            openTaskCount: cTasks,
            pendingDecisionCount: cDecs,
            clientId: client.id,
          });
        }
      }
    } else if (n.projectId) {
      const proj = directory.projects.find((p) => p.id === n.projectId);
      if (!proj) continue;
      const key = `proj:${proj.id}`;
      const existing = todayContextMap.get(key);
      if (existing) {
        if (n.title && !existing.todayNoteTitles.includes(n.title)) {
          existing.todayNoteTitles.push(n.title);
        }
      } else {
        const pTasks = activeOpenTasks.filter((t) => t.projectId === proj.id).length;
        const pDecs = allDecisions.filter(
          (d) => d.projectId === proj.id && d.status === 'proposed'
        ).length;
        if (pTasks > 0 || pDecs > 0) {
          todayContextMap.set(key, {
            id: key,
            label: proj.name,
            todayNoteTitles: n.title ? [n.title] : [],
            openTaskCount: pTasks,
            pendingDecisionCount: pDecs,
            projectId: proj.id,
          });
        }
      }
    }
  }

  // 5. Emerging #label spikes in the last 7 days
  const labelCounts = new Map<string, number>();
  for (const n of sourceNotes) {
    if (n.date < recent7Date && n.updatedAt.slice(0, 10) < recent7Date) continue;
    for (const lbl of getAllNoteLabels(n)) {
      if (lbl === 'report' || lbl === 'daily-briefing') continue;
      labelCounts.set(lbl, (labelCounts.get(lbl) || 0) + 1);
    }
  }
  const emergingLabels = Array.from(labelCounts.entries())
    .filter(([, count]) => count >= 2)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const untriagedInboxCount = sourceNotes.filter(
    (n) =>
      n.scope === 'inbox' &&
      getNoteRetroFeedback(store, n.id)?.rating !== 'low'
  ).length;

  return {
    waitingByPerson,
    staleItems: staleItems.slice(0, 8),
    silentProjects: silentProjects.slice(0, 4),
    todayContextPrep: Array.from(todayContextMap.values()).slice(0, 4),
    emergingLabels,
    untriagedInboxCount,
  };
}

export function upsertNoteRetroInDirectory(
  directory: WorkspaceDirectory,
  params: {
    noteId: string;
    rating: RetroSignalRating;
    comment?: string;
    todayDate: string;
  }
): WorkspaceDirectory {
  const prevStore = normalizeDailyRetroStore(directory.dailyRetro);
  const existing = prevStore.notes[params.noteId];
  const nextComment = params.comment !== undefined ? params.comment.trim() : existing?.comment;
  const nowIso = new Date().toISOString();

  return {
    ...directory,
    dailyRetro: {
      ...prevStore,
      notes: {
        ...prevStore.notes,
        [params.noteId]: {
          noteId: params.noteId,
          rating: params.rating,
          comment: nextComment || undefined,
          reviewedDate: params.todayDate,
          updatedAt: nowIso,
        },
      },
    },
  };
}

export function upsertTaskRetroInDirectory(
  directory: WorkspaceDirectory,
  task: Pick<ParsedTask, 'id' | 'noteId' | 'text'>,
  params: {
    bucket?: TaskHorizonBucket;
    targetDate?: string | null;
    starred?: boolean;
    comment?: string;
    todayDate: string;
  }
): WorkspaceDirectory {
  const prevStore = normalizeDailyRetroStore(directory.dailyRetro);
  const key = getTaskRetroKey(task);
  const existing = getTaskRetroPlan(prevStore, task);
  const nextBucket = params.bucket ?? existing?.bucket ?? 'today';
  const nowIso = new Date().toISOString();

  let targetDate =
    params.targetDate !== undefined ? params.targetDate : existing?.targetDate ?? null;
  let untilDate: string | null = existing?.untilDate ?? null;

  if (nextBucket === 'today') {
    targetDate = params.todayDate;
    untilDate = null;
  } else if (nextBucket === 'tomorrow') {
    targetDate = params.targetDate || addDaysIso(params.todayDate, 1);
    untilDate = null;
  } else if (nextBucket === 'this-week') {
    targetDate = null;
    untilDate = computeThisWeekUntilDate(params.todayDate);
  } else if (nextBucket === 'sometime') {
    targetDate = null;
    untilDate = null;
  } else if (nextBucket === 'date') {
    untilDate = null;
  }

  const nextComment = params.comment !== undefined ? params.comment.trim() : existing?.comment;
  const nextStarred = params.starred !== undefined ? params.starred : existing?.starred;

  return {
    ...directory,
    dailyRetro: {
      ...prevStore,
      tasks: {
        ...prevStore.tasks,
        [key]: {
          key,
          taskId: task.id,
          noteId: task.noteId,
          taskText: task.text,
          bucket: nextBucket,
          targetDate,
          untilDate,
          starred: nextStarred || undefined,
          comment: nextComment || undefined,
          reviewedDate: params.todayDate,
          updatedAt: nowIso,
        },
      },
    },
  };
}

export function upsertDecisionRetroInDirectory(
  directory: WorkspaceDirectory,
  decision: Pick<ParsedDecision, 'id' | 'noteId' | 'text'>,
  params: {
    rating?: RetroSignalRating;
    comment?: string;
    todayDate: string;
  }
): WorkspaceDirectory {
  const prevStore = normalizeDailyRetroStore(directory.dailyRetro);
  const key = getDecisionRetroKey(decision);
  const existing = getDecisionRetroFeedback(prevStore, decision);
  const nextRating = params.rating ?? existing?.rating ?? 'normal';
  const nextComment = params.comment !== undefined ? params.comment.trim() : existing?.comment;
  const nowIso = new Date().toISOString();

  return {
    ...directory,
    dailyRetro: {
      ...prevStore,
      decisions: {
        ...prevStore.decisions,
        [key]: {
          key,
          decisionId: decision.id,
          noteId: decision.noteId,
          decisionText: decision.text,
          rating: nextRating,
          comment: nextComment || undefined,
          reviewedDate: params.todayDate,
          updatedAt: nowIso,
        },
      },
    },
  };
}

export function upsertDailyRetroDayInDirectory(
  directory: WorkspaceDirectory,
  params: {
    todayDate: string;
    steeringNote?: string;
    markCompleted?: boolean;
  }
): WorkspaceDirectory {
  const prevStore = normalizeDailyRetroStore(directory.dailyRetro);
  const existing = prevStore.days[params.todayDate];
  const nowIso = new Date().toISOString();
  const nextSteering =
    params.steeringNote !== undefined ? params.steeringNote.trim() : existing?.steeringNote;

  return {
    ...directory,
    dailyRetro: {
      ...prevStore,
      days: {
        ...prevStore.days,
        [params.todayDate]: {
          date: params.todayDate,
          steeringNote: nextSteering || undefined,
          completedAt: params.markCompleted ? nowIso : existing?.completedAt ?? null,
          updatedAt: nowIso,
        },
      },
    },
  };
}
