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
  overdueTasks: ParsedTask[];
  dueTodayTasks: ParsedTask[];
  upcomingTasks: ParsedTask[];
  highPriorityOpenTasks: ParsedTask[];
  inProgressTasks: ParsedTask[];
  waitingTasks: ParsedTask[];
  urgentAndFocusTasks: ParsedTask[];
  otherOpenTasks: ParsedTask[];
  allOpenTasks: ParsedTask[];
  recentlyCompletedTasks: ParsedTask[];
  proposedDecisions: ParsedDecision[];
  recentAgreedDecisions: ParsedDecision[];
  allDecisions: ParsedDecision[];
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

function addDaysToIsoDate(baseDateStr: string, days: number): string {
  const d = new Date(`${baseDateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return baseDateStr;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
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
  const sourceNotes = notes
    .filter((n) => !isDailyBriefingNote(n))
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));

  const minWindowDate = addDaysToIsoDate(todayDate, -recentDaysWindow);
  const plus7Date = addDaysToIsoDate(todayDate, 7);

  const todayNotes = sourceNotes.filter(
    (n) => n.date === todayDate || n.updatedAt.slice(0, 10) === todayDate
  );

  const notesInWindow = sourceNotes.filter(
    (n) => n.date >= minWindowDate || n.updatedAt.slice(0, 10) >= minWindowDate
  );
  const recentNotes = notesInWindow.length > 0 ? notesInWindow : sourceNotes.slice(0, 6);

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

  const overdueTasks = allOpenTasks.filter((t) => Boolean(t.dueDate && t.dueDate < todayDate));
  const dueTodayTasks = allOpenTasks.filter((t) => t.dueDate === todayDate);
  const upcomingTasks = allOpenTasks.filter(
    (t) => Boolean(t.dueDate && t.dueDate > todayDate && t.dueDate <= plus7Date)
  );
  const highPriorityOpenTasks = allOpenTasks.filter((t) => t.priority === 'high');
  const inProgressTasks = allOpenTasks.filter((t) => t.status === 'doing');
  const waitingTasks = allOpenTasks.filter((t) => t.status === 'waiting');

  const focusIds = new Set<string>();
  const urgentAndFocusTasks: ParsedTask[] = [];
  for (const t of [
    ...overdueTasks,
    ...dueTodayTasks,
    ...highPriorityOpenTasks,
    ...inProgressTasks,
    ...waitingTasks,
    ...upcomingTasks,
  ]) {
    if (!focusIds.has(t.id)) {
      focusIds.add(t.id);
      urgentAndFocusTasks.push(t);
    }
  }

  const otherOpenTasks = allOpenTasks.filter((t) => !focusIds.has(t.id));

  const recentlyCompletedTasks = allTasks.filter(
    (t) => t.status === 'done' && t.noteDate >= minWindowDate
  );

  const proposedDecisions = allDecisions
    .filter((d) => d.status === 'proposed')
    .sort((a, b) => b.noteDate.localeCompare(a.noteDate));

  const agreedInWindow = allDecisions
    .filter((d) => d.status === 'agreed' && d.noteDate >= minWindowDate)
    .sort((a, b) => b.noteDate.localeCompare(a.noteDate));
  const recentAgreedDecisions =
    agreedInWindow.length > 0
      ? agreedInWindow
      : allDecisions
          .filter((d) => d.status === 'agreed')
          .sort((a, b) => b.noteDate.localeCompare(a.noteDate))
          .slice(0, 6);

  const sigParts = sourceNotes.map(
    (n) => `${n.id}:${n.date}:${n.updatedAt}:${n.title}:${n.body.length}`
  );
  const sourceSignature = `${todayDate}|w${recentDaysWindow}|${sigParts.join(';')}`;

  return {
    todayDate,
    recentDaysWindow,
    sourceNotes,
    todayNotes,
    recentNotes,
    overdueTasks,
    dueTodayTasks,
    upcomingTasks,
    highPriorityOpenTasks,
    inProgressTasks,
    waitingTasks,
    urgentAndFocusTasks,
    otherOpenTasks,
    allOpenTasks,
    recentlyCompletedTasks,
    proposedDecisions,
    recentAgreedDecisions,
    allDecisions,
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
  todaysAttentionLine: (overdue: number, dueToday: number, highPrio: number, inProgress: number, totalOpen: number) => string;
  decisionAlignmentLine: (proposed: number, agreed: number) => string;
  activeWorkstreamsLine: (recentCount: number, clientsStr: string, projectsStr: string) => string;
  topPrioritiesHeading: string;
  nextOpenActionsHeading: string;
  blockersHeading: string;
  autoUpdatedBanner: (humanDate: string, isoDate: string, notesCount: number, openTasksCount: number, decisionsCount: number) => string;
  actionItemsRollupHeading: string;
  dueTodayAndOverdueHeading: string;
  highPriorityAndInProgressHeading: string;
  waitingBlockedHeading: string;
  otherOpenTasksHeading: string;
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
    statusLabels: {
      todo: 'TODO',
      doing: 'DOING',
      waiting: 'WAITING',
      done: 'DONE',
      proposed: 'PROPOSED',
      agreed: 'AGREED',
    },
    emptyOverviewHeading: 'Daily Executive Overview',
    emptyOverviewBody:
      'Your workspace does not have any source notes yet. Spin up a note (`Alt+N`) and add tasks (`- [ ] Task @Owner due:YYYY-MM-DD !high`) or decisions (`- [D:agreed] Decision`) — your Daily Briefing and this Daily Report note will automatically synthesize your priorities, deadlines, and decisions here.',
    emptyBanner: (humanDate, isoDate) =>
      `> **Daily Workspace Briefing** for **${humanDate}** (${isoDate}). Automatically updates as you capture notes, action items, and decisions.`,
    executivePulseHeading: 'Executive Pulse',
    todaysAttentionLine: (overdue, dueToday, highPrio, inProgress, totalOpen) =>
      `- **Today's Attention:** **${overdue}** overdue, **${dueToday}** due today, **${highPrio}** high-priority (!high), and **${inProgress}** in-progress action item(s) across **${totalOpen}** total open task(s).`,
    decisionAlignmentLine: (proposed, agreed) =>
      `- **Decision Alignment:** **${proposed}** pending/proposed decision(s) awaiting final agreement and **${agreed}** recently agreed decision(s).`,
    activeWorkstreamsLine: (recentCount, clientsStr, projectsStr) =>
      `- **Active Workstreams:** **${recentCount}** recent note(s)${clientsStr ? ` spanning **${clientsStr}**` : ''}${projectsStr ? ` (${projectsStr})` : ''}.`,
    topPrioritiesHeading: 'Top Priorities for Today',
    nextOpenActionsHeading: 'Next Open Action Items',
    blockersHeading: 'Blockers & Decisions Needing Resolution',
    autoUpdatedBanner: (humanDate, isoDate, notesCount, openTasksCount, decisionsCount) =>
      `> **Auto-Updated Daily Report** for **${humanDate}** (${isoDate}) · Coverage: ${notesCount} workspace note(s), ${openTasksCount} open task(s), ${decisionsCount} decision(s).`,
    actionItemsRollupHeading: 'Action Items & Deadlines Rollup',
    dueTodayAndOverdueHeading: 'Due Today & Overdue',
    highPriorityAndInProgressHeading: 'High Priority & In Progress',
    waitingBlockedHeading: 'Waiting / Blocked',
    otherOpenTasksHeading: 'Other Open Tasks',
    recentlyCompletedHeading: (count) => `Recently Completed (${count})`,
    decisionsRegisterHeading: 'Decisions Register',
    pendingDecisionsHeading: 'Pending / Proposed Decisions',
    recentAgreedDecisionsHeading: 'Recent Agreed Decisions',
    recentNotesHeading: 'Recent Notes & Summaries',
    untitledNote: 'Untitled Note',
    internalLabel: 'Internal',
    inboxLabel: 'Inbox',
  },
  de: {
    overdueDuePrefix: 'ÜBERFÄLLIG · fällig',
    dueToday: 'HEUTE FÄLLIG',
    duePrefix: 'fällig',
    fromPrefix: 'aus',
    proposedNeedsSignoff: 'VORGESCHLAGEN · Freigabe erforderlich',
    rationaleLabel: 'Begründung',
    statusLabels: {
      todo: 'OFFEN',
      doing: 'IN ARBEIT',
      waiting: 'WARTEND',
      done: 'ERLEDIGT',
      proposed: 'VORGESCHLAGEN',
      agreed: 'BESCHLOSSEN',
    },
    emptyOverviewHeading: 'Täglicher Executive-Überblick',
    emptyOverviewBody:
      'Dein Arbeitsbereich enthält noch keine Quellnotizen. Erstelle eine Notiz (`Alt+N`) und füge Aufgaben (`- [ ] Aufgabe @Verantwortlich due:YYYY-MM-DD !high`) oder Entscheidungen (`- [D:agreed] Entscheidung`) hinzu — dein Tagesbriefing und diese Tagesberichts-Notiz fassen deine Prioritäten, Fristen und Entscheidungen hier automatisch zusammen.',
    emptyBanner: (humanDate, isoDate) =>
      `> **Tägliches Workspace-Briefing** für **${humanDate}** (${isoDate}). Wird automatisch aktualisiert, sobald du Notizen, Aufgaben und Entscheidungen erfasst.`,
    executivePulseHeading: 'Tagespuls',
    todaysAttentionLine: (overdue, dueToday, highPrio, inProgress, totalOpen) =>
      `- **Heutiger Fokus:** **${overdue}** überfällig, **${dueToday}** heute fällig, **${highPrio}** mit hoher Priorität (!high) und **${inProgress}** in Bearbeitung bei insgesamt **${totalOpen}** offenen Aufgabe(n).`,
    decisionAlignmentLine: (proposed, agreed) =>
      `- **Entscheidungsstand:** **${proposed}** offene/vorgeschlagene Entscheidung(en) zur finalen Abstimmung und **${agreed}** kürzlich beschlossene Entscheidung(en).`,
    activeWorkstreamsLine: (recentCount, clientsStr, projectsStr) =>
      `- **Aktive Workstreams:** **${recentCount}** aktuelle Notiz(en)${clientsStr ? ` über **${clientsStr}**` : ''}${projectsStr ? ` (${projectsStr})` : ''}.`,
    topPrioritiesHeading: 'Top-Prioritäten für heute',
    nextOpenActionsHeading: 'Nächste offene Aufgaben',
    blockersHeading: 'Blocker & offene Entscheidungen',
    autoUpdatedBanner: (humanDate, isoDate, notesCount, openTasksCount, decisionsCount) =>
      `> **Automatisch aktualisierter Tagesbericht** für **${humanDate}** (${isoDate}) · Abdeckung: ${notesCount} Notiz(en), ${openTasksCount} offene Aufgabe(n), ${decisionsCount} Entscheidung(en).`,
    actionItemsRollupHeading: 'Aufgaben & Fristen im Überblick',
    dueTodayAndOverdueHeading: 'Heute fällig & überfällig',
    highPriorityAndInProgressHeading: 'Hohe Priorität & in Bearbeitung',
    waitingBlockedHeading: 'Wartend / Blockiert',
    otherOpenTasksHeading: 'Weitere offene Aufgaben',
    recentlyCompletedHeading: (count) => `Kürzlich erledigt (${count})`,
    decisionsRegisterHeading: 'Entscheidungsregister',
    pendingDecisionsHeading: 'Offene / vorgeschlagene Entscheidungen',
    recentAgreedDecisionsHeading: 'Kürzlich beschlossene Entscheidungen',
    recentNotesHeading: 'Aktuelle Notizen & Zusammenfassungen',
    untitledNote: 'Unbenannte Notiz',
    internalLabel: 'Intern',
    inboxLabel: 'Eingang',
  },
  fr: {
    overdueDuePrefix: 'EN RETARD · échéance',
    dueToday: 'ÉCHÉANCE AUJOURD’HUI',
    duePrefix: 'échéance',
    fromPrefix: 'de',
    proposedNeedsSignoff: 'PROPOSÉE · Validation requise',
    rationaleLabel: 'Justification',
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
      'Votre espace de travail ne contient pas encore de notes sources. Créez une note (`Alt+N`) et ajoutez des tâches (`- [ ] Tâche @Responsable due:YYYY-MM-DD !high`) ou des décisions (`- [D:agreed] Décision`) — votre briefing quotidien les synthétisera automatiquement ici.',
    emptyBanner: (humanDate, isoDate) =>
      `> **Briefing quotidien de l’espace** pour **${humanDate}** (${isoDate}). Mis à jour automatiquement au fil de vos notes, tâches et décisions.`,
    executivePulseHeading: 'Pouls exécutif',
    todaysAttentionLine: (overdue, dueToday, highPrio, inProgress, totalOpen) =>
      `- **Priorités du jour :** **${overdue}** en retard, **${dueToday}** à échéance aujourd’hui, **${highPrio}** haute priorité (!high) et **${inProgress}** en cours sur **${totalOpen}** tâche(s) ouverte(s).`,
    decisionAlignmentLine: (proposed, agreed) =>
      `- **Décisions :** **${proposed}** décision(s) en attente de validation et **${agreed}** décision(s) récemment validée(s).`,
    activeWorkstreamsLine: (recentCount, clientsStr, projectsStr) =>
      `- **Flux actifs :** **${recentCount}** note(s) récente(s)${clientsStr ? ` concernant **${clientsStr}**` : ''}${projectsStr ? ` (${projectsStr})` : ''}.`,
    topPrioritiesHeading: 'Priorités principales du jour',
    nextOpenActionsHeading: 'Prochaines actions ouvertes',
    blockersHeading: 'Blocages & décisions en attente',
    autoUpdatedBanner: (humanDate, isoDate, notesCount, openTasksCount, decisionsCount) =>
      `> **Rapport quotidien automatique** pour **${humanDate}** (${isoDate}) · Couverture : ${notesCount} note(s), ${openTasksCount} tâche(s) ouverte(s), ${decisionsCount} décision(s).`,
    actionItemsRollupHeading: 'Suivi des actions & échéances',
    dueTodayAndOverdueHeading: 'Échéance aujourd’hui & en retard',
    highPriorityAndInProgressHeading: 'Haute priorité & en cours',
    waitingBlockedHeading: 'En attente / Bloqué',
    otherOpenTasksHeading: 'Autres tâches ouvertes',
    recentlyCompletedHeading: (count) => `Terminées récemment (${count})`,
    decisionsRegisterHeading: 'Registre des décisions',
    pendingDecisionsHeading: 'Décisions en attente / proposées',
    recentAgreedDecisionsHeading: 'Décisions récemment validées',
    recentNotesHeading: 'Notes récentes & résumés',
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
      'Tu espacio de trabajo aún no tiene notas fuente. Crea una nota (`Alt+N`) y añade tareas (`- [ ] Tarea @Responsable due:YYYY-MM-DD !high`) o decisiones (`- [D:agreed] Decisión`) — tu resumen diario se sintetizará aquí automáticamente.',
    emptyBanner: (humanDate, isoDate) =>
      `> **Resumen diario del espacio** para **${humanDate}** (${isoDate}). Se actualiza automáticamente con tus notas, tareas y decisiones.`,
    executivePulseHeading: 'Pulso ejecutivo',
    todaysAttentionLine: (overdue, dueToday, highPrio, inProgress, totalOpen) =>
      `- **Atención de hoy:** **${overdue}** vencida(s), **${dueToday}** para hoy, **${highPrio}** de alta prioridad (!high) y **${inProgress}** en curso de un total de **${totalOpen}** tarea(s) abierta(s).`,
    decisionAlignmentLine: (proposed, agreed) =>
      `- **Estado de decisiones:** **${proposed}** decisión(es) propuesta(s) pendiente(s) de aprobación y **${agreed}** acordada(s) recientemente.`,
    activeWorkstreamsLine: (recentCount, clientsStr, projectsStr) =>
      `- **Frentes activos:** **${recentCount}** nota(s) reciente(s)${clientsStr ? ` sobre **${clientsStr}**` : ''}${projectsStr ? ` (${projectsStr})` : ''}.`,
    topPrioritiesHeading: 'Prioridades principales para hoy',
    nextOpenActionsHeading: 'Próximas tareas abiertas',
    blockersHeading: 'Bloqueos y decisiones pendientes',
    autoUpdatedBanner: (humanDate, isoDate, notesCount, openTasksCount, decisionsCount) =>
      `> **Informe diario automático** para **${humanDate}** (${isoDate}) · Cobertura: ${notesCount} nota(s), ${openTasksCount} tarea(s) abierta(s), ${decisionsCount} decisión(es).`,
    actionItemsRollupHeading: 'Resumen de tareas y plazos',
    dueTodayAndOverdueHeading: 'Para hoy y vencidas',
    highPriorityAndInProgressHeading: 'Alta prioridad y en curso',
    waitingBlockedHeading: 'En espera / Bloqueadas',
    otherOpenTasksHeading: 'Otras tareas abiertas',
    recentlyCompletedHeading: (count) => `Completadas recientemente (${count})`,
    decisionsRegisterHeading: 'Registro de decisiones',
    pendingDecisionsHeading: 'Decisiones pendientes / propuestas',
    recentAgreedDecisionsHeading: 'Decisiones acordadas recientemente',
    recentNotesHeading: 'Notas recientes y resúmenes',
    untitledNote: 'Nota sin título',
    internalLabel: 'Interno',
    inboxLabel: 'Entrada',
  },
  it: {
    overdueDuePrefix: 'SCADUTA · scadenza',
    dueToday: 'IN SCADENZA OGGI',
    duePrefix: 'scadenza',
    fromPrefix: 'da',
    proposedNeedsSignoff: 'PROPOSTA · Richiede approvazione',
    rationaleLabel: 'Motivazione',
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
      'Il tuo spazio di lavoro non contiene ancora note sorgente. Crea una nota (`Alt+N`) e aggiungi attività (`- [ ] Attività @Responsabile due:YYYY-MM-DD !high`) o decisioni (`- [D:agreed] Decisione`) — il briefing giornaliero verrà sintetizzato automaticamente qui.',
    emptyBanner: (humanDate, isoDate) =>
      `> **Briefing giornaliero dell’area di lavoro** per **${humanDate}** (${isoDate}). Si aggiorna automaticamente con note, attività e decisioni.`,
    executivePulseHeading: 'Sintesi esecutiva',
    todaysAttentionLine: (overdue, dueToday, highPrio, inProgress, totalOpen) =>
      `- **Attenzione oggi:** **${overdue}** scaduta/e, **${dueToday}** in scadenza oggi, **${highPrio}** ad alta priorità (!high) e **${inProgress}** in corso su **${totalOpen}** attività aperte.`,
    decisionAlignmentLine: (proposed, agreed) =>
      `- **Allineamento decisioni:** **${proposed}** decisione/i proposta/e in attesa di approvazione e **${agreed}** approvata/e di recente.`,
    activeWorkstreamsLine: (recentCount, clientsStr, projectsStr) =>
      `- **Flussi attivi:** **${recentCount}** nota/e recente/i${clientsStr ? ` su **${clientsStr}**` : ''}${projectsStr ? ` (${projectsStr})` : ''}.`,
    topPrioritiesHeading: 'Priorità principali di oggi',
    nextOpenActionsHeading: 'Prossime attività aperte',
    blockersHeading: 'Blocchi e decisioni da risolvere',
    autoUpdatedBanner: (humanDate, isoDate, notesCount, openTasksCount, decisionsCount) =>
      `> **Report giornaliero automatico** per **${humanDate}** (${isoDate}) · Copertura: ${notesCount} nota/e, ${openTasksCount} attività aperte, ${decisionsCount} decisione/i.`,
    actionItemsRollupHeading: 'Riepilogo attività e scadenze',
    dueTodayAndOverdueHeading: 'In scadenza oggi e scadute',
    highPriorityAndInProgressHeading: 'Alta priorità e in corso',
    waitingBlockedHeading: 'In attesa / Bloccate',
    otherOpenTasksHeading: 'Altre attività aperte',
    recentlyCompletedHeading: (count) => `Completate di recente (${count})`,
    decisionsRegisterHeading: 'Registro delle decisioni',
    pendingDecisionsHeading: 'Decisioni in sospeso / proposte',
    recentAgreedDecisionsHeading: 'Decisioni approvate di recente',
    recentNotesHeading: 'Note recenti e riepiloghi',
    untitledNote: 'Nota senza titolo',
    internalLabel: 'Interno',
    inboxLabel: 'In arrivo',
  },
};

function formatTaskRollupBullet(
  t: ParsedTask,
  todayDate: string,
  language: AiOutputLanguage = 'en'
): string {
  const copy = BRIEFING_COPY[language];
  const badges: string[] = [];
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

  return `- **[${badges.join(' · ')}]** ${t.text}${ownerSuffix}${labelsSuffix} — *${copy.fromPrefix} [[${t.noteTitle}]]*`;
}

function formatDecisionRollupBullet(
  d: ParsedDecision,
  language: AiOutputLanguage = 'en'
): string {
  const copy = BRIEFING_COPY[language];
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
  return `- **[${statusTag}]** ${d.text}${rationaleSuffix}${labelsSuffix} — *${copy.fromPrefix} [[${d.noteTitle}]] (${d.noteDate})*`;
}

function sanitizeRollupMarkdown(md: string, language: AiOutputLanguage = 'en'): string {
  const copy = BRIEFING_COPY[language];
  // Ensure AI-generated overview bullets don't use raw `- [ ]` or `- [D:...]` task/decision syntax
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

  // Active clients & projects touched recently
  const activeClientNames = new Set<string>();
  const activeProjectNames = new Set<string>();
  for (const n of data.recentNotes) {
    if (n.clientId) {
      const c = directory.clients.find((x) => x.id === n.clientId);
      if (c) activeClientNames.add(c.name);
    }
    if (n.projectId) {
      const p = directory.projects.find((x) => x.id === n.projectId);
      if (p) activeProjectNames.add(p.name);
    }
  }

  const clientsStr = Array.from(activeClientNames).slice(0, 4).join(', ');
  const projectsStr = Array.from(activeProjectNames).slice(0, 4).join(', ');

  const overviewLines: string[] = [
    `### ${copy.executivePulseHeading} — ${humanDate}`,
    copy.todaysAttentionLine(
      data.overdueTasks.length,
      data.dueTodayTasks.length,
      data.highPriorityOpenTasks.length,
      data.inProgressTasks.length,
      data.allOpenTasks.length
    ),
    copy.decisionAlignmentLine(
      data.proposedDecisions.length,
      data.recentAgreedDecisions.length
    ),
    copy.activeWorkstreamsLine(data.recentNotes.length, clientsStr, projectsStr),
  ];

  // Top Priorities for Today
  const topFocus = data.urgentAndFocusTasks.slice(0, 5);
  if (topFocus.length > 0) {
    overviewLines.push('', `### ${copy.topPrioritiesHeading}`);
    for (const t of topFocus) {
      overviewLines.push(formatTaskRollupBullet(t, data.todayDate, language));
    }
  } else if (data.allOpenTasks.length > 0) {
    overviewLines.push('', `### ${copy.nextOpenActionsHeading}`);
    for (const t of data.allOpenTasks.slice(0, 5)) {
      overviewLines.push(formatTaskRollupBullet(t, data.todayDate, language));
    }
  }

  // Blockers & Pending Decisions to Resolve
  if (data.waitingTasks.length > 0 || data.proposedDecisions.length > 0) {
    overviewLines.push('', `### ${copy.blockersHeading}`);
    for (const d of data.proposedDecisions.slice(0, 4)) {
      overviewLines.push(formatDecisionRollupBullet(d, language));
    }
    for (const w of data.waitingTasks.slice(0, 4)) {
      overviewLines.push(formatTaskRollupBullet(w, data.todayDate, language));
    }
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
      data.sourceNotes.length,
      data.allOpenTasks.length,
      data.allDecisions.length
    ),
    '',
    sanitizeRollupMarkdown(overviewMarkdown.trim(), language),
  ];

  // Action Items Breakdown
  if (data.allOpenTasks.length > 0 || data.recentlyCompletedTasks.length > 0) {
    sections.push('', '---', '', `## ${copy.actionItemsRollupHeading}`);

    if (data.overdueTasks.length > 0 || data.dueTodayTasks.length > 0) {
      sections.push('', `### ${copy.dueTodayAndOverdueHeading}`);
      for (const t of [...data.overdueTasks, ...data.dueTodayTasks]) {
        sections.push(formatTaskRollupBullet(t, data.todayDate, language));
      }
    }

    const highAndDoing = [...data.highPriorityOpenTasks, ...data.inProgressTasks].filter(
      (t, idx, arr) =>
        arr.findIndex((x) => x.id === t.id) === idx &&
        !data.overdueTasks.some((o) => o.id === t.id) &&
        !data.dueTodayTasks.some((d) => d.id === t.id)
    );
    if (highAndDoing.length > 0) {
      sections.push('', `### ${copy.highPriorityAndInProgressHeading}`);
      for (const t of highAndDoing) {
        sections.push(formatTaskRollupBullet(t, data.todayDate, language));
      }
    }

    if (data.waitingTasks.length > 0) {
      sections.push('', `### ${copy.waitingBlockedHeading}`);
      for (const t of data.waitingTasks) {
        sections.push(formatTaskRollupBullet(t, data.todayDate, language));
      }
    }

    if (data.otherOpenTasks.length > 0) {
      sections.push('', `### ${copy.otherOpenTasksHeading}`);
      for (const t of data.otherOpenTasks.slice(0, 12)) {
        sections.push(formatTaskRollupBullet(t, data.todayDate, language));
      }
    }

    if (data.recentlyCompletedTasks.length > 0) {
      sections.push('', `### ${copy.recentlyCompletedHeading(data.recentlyCompletedTasks.length)}`);
      for (const t of data.recentlyCompletedTasks.slice(0, 6)) {
        sections.push(formatTaskRollupBullet(t, data.todayDate, language));
      }
    }
  }

  // Decisions Breakdown
  if (data.proposedDecisions.length > 0 || data.recentAgreedDecisions.length > 0) {
    sections.push('', '---', '', `## ${copy.decisionsRegisterHeading}`);

    if (data.proposedDecisions.length > 0) {
      sections.push('', `### ${copy.pendingDecisionsHeading}`);
      for (const d of data.proposedDecisions) {
        sections.push(formatDecisionRollupBullet(d, language));
      }
    }

    if (data.recentAgreedDecisions.length > 0) {
      sections.push('', `### ${copy.recentAgreedDecisionsHeading}`);
      for (const d of data.recentAgreedDecisions.slice(0, 10)) {
        sections.push(formatDecisionRollupBullet(d, language));
      }
    }
  }

  // Recent Notes Summary
  if (data.recentNotes.length > 0) {
    sections.push('', '---', '', `## ${copy.recentNotesHeading}`);
    for (const n of data.recentNotes.slice(0, 10)) {
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
      const rawPreview = stripMarkdownFormatting(n.body);
      const snippet =
        rawPreview.length > 180 ? `${rawPreview.slice(0, 180).trimEnd()}…` : rawPreview;

      sections.push(
        `- **${n.date} — [[${n.title || copy.untitledNote}]]** (${contextStr}${peopleStr}${labelsStr})${
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
      const tasksContext = data.allOpenTasks
        .slice(0, 20)
        .map(
          (t) =>
            `- [${t.status.toUpperCase()}] ${t.text} (Owner: ${t.owner || 'Unassigned'}, Due: ${
              t.dueDate || 'None'
            }, Priority: ${t.priority || 'normal'}, Source: [[${t.noteTitle}]])`
        )
        .join('\n');

      const decisionsContext = [
        ...data.proposedDecisions.slice(0, 8),
        ...data.recentAgreedDecisions.slice(0, 8),
      ]
        .map(
          (d) =>
            `- [${d.status.toUpperCase()}] ${d.text}${
              d.rationale ? ` (Rationale: ${d.rationale})` : ''
            } (Source: [[${d.noteTitle}]], ${d.noteDate})`
        )
        .join('\n');

      const notesContext = data.recentNotes
        .slice(0, 8)
        .map((n) => {
          const client = n.clientId
            ? directory.clients.find((c) => c.id === n.clientId)?.name
            : null;
          const title = n.title || 'Untitled Note';
          return `[[${title}]] (Topic: ${title}, ${n.date}${client ? ` · ${client}` : ''}):\n${n.body.slice(
            0,
            900
          )}`;
        })
        .join('\n\n');

      const languageInstruction =
        language === 'en'
          ? 'Write the entire Daily Briefing in English.'
          : `Write the ENTIRE Daily Briefing (all prose, bullet points, status tags, and summaries) in ${langMeta?.englishName || language} (${langMeta?.label || language}), translating any English task/decision descriptions naturally if helpful while keeping proper nouns, exact [[Note Title]] links, @[Full Name] mentions, and #label tags intact.`;

      const systemPrompt = `You are an executive Chief-of-Staff AI synthesizing a crisp, high-signal Daily Briefing for ${humanDate} (${data.todayDate}).
${languageInstruction}
Write in clean Markdown using these exact section headings:
### ${copy.executivePulseHeading} — ${humanDate}
(2-3 high-signal bullet points summarizing today's focus, key client/internal momentum, and urgent risks)
### ${copy.topPrioritiesHeading}
(Prioritized action items focusing on overdue, due today, high-priority, and in-progress tasks with @[Full Name] owners and due dates)
### ${copy.blockersHeading}
(Proposed decisions needing sign-off and waiting/blocked items)

IMPORTANT RULES:
- Cite source notes inline using [[Exact Note Title]].
- Mention people using @[Full Name] and topics using #label.
- Do NOT use raw "- [ ]" or "- [D:...]" checkbox syntax; instead use bold status tags in the target language (e.g. "- **[${copy.dueToday} · !HIGH]**" or "- **[${copy.statusLabels.proposed}]**") so items are formatted as an executive briefing.`;

      const userPrompt = `Today's Date: ${data.todayDate}

Open Tasks (${data.allOpenTasks.length} total, ${data.overdueTasks.length} overdue, ${data.dueTodayTasks.length} due today):
${tasksContext || 'None'}

Decisions (${data.proposedDecisions.length} proposed, ${data.recentAgreedDecisions.length} recently agreed):
${decisionsContext || 'None'}

Recent Workspace Notes:
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
