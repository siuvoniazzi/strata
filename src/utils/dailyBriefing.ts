import type {
  AiConfig,
  AiPrivacyReport,
  Note,
  ParsedDecision,
  ParsedTask,
  WorkspaceDirectory,
} from '../types';
import {
  callConfiguredLlmDetailed,
  formatAiEngineLabel,
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

export function formatHumanDate(dateStr: string): string {
  try {
    const d = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', {
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

function formatTaskRollupBullet(t: ParsedTask, todayDate: string): string {
  const badges: string[] = [];
  if (t.dueDate && t.dueDate < todayDate) {
    badges.push(`OVERDUE · due ${t.dueDate}`);
  } else if (t.dueDate === todayDate) {
    badges.push('DUE TODAY');
  } else if (t.dueDate) {
    badges.push(`due ${t.dueDate}`);
  }
  if (t.priority === 'high') {
    badges.push('!HIGH');
  }
  badges.push(t.status.toUpperCase());

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

  return `- **[${badges.join(' · ')}]** ${t.text}${ownerSuffix}${labelsSuffix} — *from [[${t.noteTitle}]]*`;
}

function formatDecisionRollupBullet(d: ParsedDecision): string {
  const statusTag = d.status === 'proposed' ? 'PROPOSED · Needs Sign-off' : d.status.toUpperCase();
  const rationaleSuffix = d.rationale ? ` — *Rationale: ${d.rationale}*` : '';
  const labelsSuffix =
    d.labels.length > 0
      ? ` ${d.labels
          .slice(0, 3)
          .map((l) => `#${l}`)
          .join(' ')}`
      : '';
  return `- **[${statusTag}]** ${d.text}${rationaleSuffix}${labelsSuffix} — *from [[${d.noteTitle}]] (${d.noteDate})*`;
}

function sanitizeRollupMarkdown(md: string): string {
  // Ensure AI-generated overview bullets don't use raw `- [ ]` or `- [D:...]` task/decision syntax
  return md
    .replace(/^(\s*[-*+•]\s*)\[([ /?xX])\]\s+/gm, (_, prefix: string, ch: string) => {
      const label =
        ch === '/' ? 'DOING' : ch === '?' ? 'WAITING' : ch.toLowerCase() === 'x' ? 'DONE' : 'TODO';
      return `${prefix}**[${label}]** `;
    })
    .replace(/^(\s*[-*+•]\s*)\[D(?::([a-zA-Z_-]+))?\]\s+/gim, (_, prefix: string, st?: string) => {
      return `${prefix}**[${(st || 'AGREED').toUpperCase()}]** `;
    });
}

export function buildDeterministicDailyBriefing(
  data: DailyBriefingData,
  directory: WorkspaceDirectory
): {
  overviewMarkdown: string;
  fullNoteMarkdown: string;
  usedProvider: string;
} {
  const humanDate = formatHumanDate(data.todayDate);

  if (data.sourceNotes.length === 0) {
    const emptyOverview = [
      `### Daily Executive Overview — ${humanDate}`,
      '',
      'Your workspace does not have any source notes yet. Spin up a note (`Alt+N`) and add tasks (`- [ ] Task @Owner due:YYYY-MM-DD !high`) or decisions (`- [D:agreed] Decision`) — your Daily Briefing and this Daily Report note will automatically synthesize your priorities, deadlines, and decisions here.',
    ].join('\n');

    return {
      overviewMarkdown: emptyOverview,
      fullNoteMarkdown: [
        `> **Daily Workspace Briefing** for **${humanDate}** (${data.todayDate}). Automatically updates as you capture notes, action items, and decisions.`,
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

  const overviewLines: string[] = [
    `### Executive Pulse — ${humanDate}`,
    `- **Today's Attention:** **${data.overdueTasks.length}** overdue, **${data.dueTodayTasks.length}** due today, **${data.highPriorityOpenTasks.length}** high-priority (` +
      `!high), and **${data.inProgressTasks.length}** in-progress action item(s) across **${data.allOpenTasks.length}** total open task(s).`,
    `- **Decision Alignment:** **${data.proposedDecisions.length}** pending/proposed decision(s) awaiting final agreement and **${data.recentAgreedDecisions.length}** recently agreed decision(s).`,
    `- **Active Workstreams:** **${data.recentNotes.length}** recent note(s)${
      activeClientNames.size > 0
        ? ` spanning **${Array.from(activeClientNames).slice(0, 4).join(', ')}**`
        : ''
    }${
      activeProjectNames.size > 0
        ? ` (${Array.from(activeProjectNames).slice(0, 4).join(', ')})`
        : ''
    }.`,
  ];

  // Top Priorities for Today
  const topFocus = data.urgentAndFocusTasks.slice(0, 5);
  if (topFocus.length > 0) {
    overviewLines.push('', '### Top Priorities for Today');
    for (const t of topFocus) {
      overviewLines.push(formatTaskRollupBullet(t, data.todayDate));
    }
  } else if (data.allOpenTasks.length > 0) {
    overviewLines.push('', '### Next Open Action Items');
    for (const t of data.allOpenTasks.slice(0, 5)) {
      overviewLines.push(formatTaskRollupBullet(t, data.todayDate));
    }
  }

  // Blockers & Pending Decisions to Resolve
  if (data.waitingTasks.length > 0 || data.proposedDecisions.length > 0) {
    overviewLines.push('', '### Blockers & Decisions Needing Resolution');
    for (const d of data.proposedDecisions.slice(0, 4)) {
      overviewLines.push(formatDecisionRollupBullet(d));
    }
    for (const w of data.waitingTasks.slice(0, 4)) {
      overviewLines.push(formatTaskRollupBullet(w, data.todayDate));
    }
  }

  const overviewMarkdown = overviewLines.join('\n');
  const fullNoteMarkdown = composeFullDailyNoteMarkdown(overviewMarkdown, data, directory);

  return {
    overviewMarkdown,
    fullNoteMarkdown,
    usedProvider: 'Local Smart Engine',
  };
}

export function composeFullDailyNoteMarkdown(
  overviewMarkdown: string,
  data: DailyBriefingData,
  directory: WorkspaceDirectory
): string {
  const humanDate = formatHumanDate(data.todayDate);
  const sections: string[] = [
    `> **Auto-Updated Daily Report** for **${humanDate}** (${data.todayDate}) · Coverage: ${data.sourceNotes.length} workspace note(s), ${data.allOpenTasks.length} open task(s), ${data.allDecisions.length} decision(s).`,
    '',
    sanitizeRollupMarkdown(overviewMarkdown.trim()),
  ];

  // Action Items Breakdown
  if (data.allOpenTasks.length > 0 || data.recentlyCompletedTasks.length > 0) {
    sections.push('', '---', '', '## Action Items & Deadlines Rollup');

    if (data.overdueTasks.length > 0 || data.dueTodayTasks.length > 0) {
      sections.push('', '### Due Today & Overdue');
      for (const t of [...data.overdueTasks, ...data.dueTodayTasks]) {
        sections.push(formatTaskRollupBullet(t, data.todayDate));
      }
    }

    const highAndDoing = [...data.highPriorityOpenTasks, ...data.inProgressTasks].filter(
      (t, idx, arr) =>
        arr.findIndex((x) => x.id === t.id) === idx &&
        !data.overdueTasks.some((o) => o.id === t.id) &&
        !data.dueTodayTasks.some((d) => d.id === t.id)
    );
    if (highAndDoing.length > 0) {
      sections.push('', '### High Priority & In Progress');
      for (const t of highAndDoing) {
        sections.push(formatTaskRollupBullet(t, data.todayDate));
      }
    }

    if (data.waitingTasks.length > 0) {
      sections.push('', '### Waiting / Blocked');
      for (const t of data.waitingTasks) {
        sections.push(formatTaskRollupBullet(t, data.todayDate));
      }
    }

    if (data.otherOpenTasks.length > 0) {
      sections.push('', '### Other Open Tasks');
      for (const t of data.otherOpenTasks.slice(0, 12)) {
        sections.push(formatTaskRollupBullet(t, data.todayDate));
      }
    }

    if (data.recentlyCompletedTasks.length > 0) {
      sections.push('', `### Recently Completed (${data.recentlyCompletedTasks.length})`);
      for (const t of data.recentlyCompletedTasks.slice(0, 6)) {
        sections.push(formatTaskRollupBullet(t, data.todayDate));
      }
    }
  }

  // Decisions Breakdown
  if (data.proposedDecisions.length > 0 || data.recentAgreedDecisions.length > 0) {
    sections.push('', '---', '', '## Decisions Register');

    if (data.proposedDecisions.length > 0) {
      sections.push('', '### Pending / Proposed Decisions');
      for (const d of data.proposedDecisions) {
        sections.push(formatDecisionRollupBullet(d));
      }
    }

    if (data.recentAgreedDecisions.length > 0) {
      sections.push('', '### Recent Agreed Decisions');
      for (const d of data.recentAgreedDecisions.slice(0, 10)) {
        sections.push(formatDecisionRollupBullet(d));
      }
    }
  }

  // Recent Notes Summary
  if (data.recentNotes.length > 0) {
    sections.push('', '---', '', '## Recent Notes & Summaries');
    for (const n of data.recentNotes.slice(0, 10)) {
      const client = n.clientId ? directory.clients.find((c) => c.id === n.clientId) : null;
      const proj = n.projectId ? directory.projects.find((p) => p.id === n.projectId) : null;
      const contextStr = client
        ? `${client.name}${proj ? ` · ${proj.name}` : ''}`
        : n.scope === 'internal'
        ? `Internal${proj ? ` · ${proj.name}` : ''}`
        : 'Inbox';
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
        `- **${n.date} — [[${n.title || 'Untitled Note'}]]** (${contextStr}${peopleStr}${labelsStr})${
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
  privacyReport?: AiPrivacyReport;
}> {
  return withAiActivity('AI: Synthesizing daily briefing…', config, async () => {
    const localResult = buildDeterministicDailyBriefing(data, directory);
    if (
      config.provider === 'local' ||
      !config.apiKey.trim() ||
      data.sourceNotes.length === 0
    ) {
      return localResult;
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

      const systemPrompt = `You are an executive Chief-of-Staff AI synthesizing a crisp, high-signal Daily Briefing for ${formatHumanDate(
        data.todayDate
      )} (${data.todayDate}).
Write in clean Markdown using these sections:
### Executive Pulse — ${formatHumanDate(data.todayDate)}
(2-3 high-signal bullet points summarizing today's focus, key client/internal momentum, and urgent risks)
### Top Priorities for Today
(Prioritized action items focusing on overdue, due today, high-priority, and in-progress tasks with @[Full Name] owners and due dates)
### Pending Decisions & Blockers to Unblock
(Proposed decisions needing sign-off and waiting/blocked items)

IMPORTANT RULES:
- Cite source notes inline using [[Exact Note Title]].
- Mention people using @[Full Name] and topics using #label.
- Do NOT use raw "- [ ]" or "- [D:...]" checkbox syntax; instead use bold status tags like "- **[DUE TODAY · !HIGH]**" or "- **[PROPOSED]**" so items are formatted as an executive briefing.`;

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
      const cleanedOverview = sanitizeRollupMarkdown(unwrapOuterMarkdownFence(llmRes.text));
      if (!cleanedOverview) return { ...localResult, privacyReport: llmRes.privacyReport };

      const providerLabel = formatAiEngineLabel(config);
      const fullNoteMarkdown = composeFullDailyNoteMarkdown(
        cleanedOverview,
        data,
        directory
      );

      return {
        overviewMarkdown: cleanedOverview,
        fullNoteMarkdown,
        usedProvider: providerLabel,
        privacyReport: llmRes.privacyReport,
      };
    } catch {
      return {
        ...localResult,
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
