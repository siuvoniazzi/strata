import type {
  Client,
  DecisionStatus,
  Note,
  NoteScope,
  ParsedDecision,
  ParsedTask,
  Person,
  Project,
  TaskPriority,
  TaskStatus,
  WorkspaceDirectory,
} from '../types';

export function slugify(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'untitled';
}

export function folderSegment(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '')
    .replace(/\s+/g, '-');
  return cleaned || 'General';
}

export function normalizeLabel(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extracts inline #labels from markdown text while ignoring headings (# Heading) and URLs.
 */
export function extractInlineLabels(text: string): string[] {
  const found = new Set<string>();
  const regex = /(?:^|[\s(])#([\p{L}][\p{L}\p{N}_-]{1,38})/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const normalized = normalizeLabel(match[1]);
    if (normalized) found.add(normalized);
  }
  return Array.from(found);
}

/**
 * Extracts @[Full Name] and @SingleName mentions from text.
 */
export function extractInlineMentions(text: string, knownPeople: Person[] = []): string[] {
  const found = new Set<string>();
  // 1. Bracketed @[Full Name]
  const bracketRegex = /@\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = bracketRegex.exec(text)) !== null) {
    const name = m[1].trim();
    if (name) found.add(resolveKnownPersonName(name, knownPeople));
  }

  // 2. Unbracketed @First Last (if matching a known person) or @SingleWord
  const stripped = text.replace(/@\[[^\]]+\]/g, ' ');
  for (const person of knownPeople) {
    const escaped = person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const personAtRegex = new RegExp(`(?:^|\\s)@${escaped}(?=$|[\\s,.;:!?)] )`, 'iu');
    if (personAtRegex.test(stripped)) {
      found.add(person.name);
    }
  }

  const singleAtRegex = /(?:^|[\s(])@([\p{L}][\p{L}\p{N}._-]{1,30})/gu;
  while ((m = singleAtRegex.exec(stripped)) !== null) {
    const token = m[1];
    const resolved = resolveKnownPersonName(token, knownPeople);
    // Avoid duplicating first-name token if full name already matched
    const alreadyCovered = Array.from(found).some(
      (existing) => existing.toLowerCase() === resolved.toLowerCase() || existing.toLowerCase().startsWith(token.toLowerCase() + ' ')
    );
    if (!alreadyCovered) {
      found.add(resolved);
    }
  }

  return Array.from(found);
}

export function resolveKnownPersonName(input: string, knownPeople: Person[]): string {
  const lower = input.trim().toLowerCase();
  const exact = knownPeople.find((p) => p.name.toLowerCase() === lower);
  if (exact) return exact.name;
  const firstMatch = knownPeople.find((p) => p.name.toLowerCase().split(/\s+/)[0] === lower);
  if (firstMatch) return firstMatch.name;
  return input.trim();
}

/**
 * Detects known people mentioned in plain prose WITHOUT @ so the UI can offer 1-click linking/recognition.
 */
export function detectUnlinkedPeopleInText(body: string, knownPeople: Person[]): Person[] {
  const withoutBracketMentions = body.replace(/@\[[^\]]+\]/g, ' ');
  const detected: Person[] = [];
  for (const person of knownPeople) {
    if (person.name.length < 3) continue;
    const escaped = person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match plain occurrence not preceded by @
    const plainRegex = new RegExp(`(?<!@)\\b${escaped}\\b`, 'iu');
    if (plainRegex.test(withoutBracketMentions)) {
      detected.push(person);
    }
  }
  return detected;
}

export function getAllNoteLabels(note: Note): string[] {
  const set = new Set<string>(note.labels.map(normalizeLabel).filter(Boolean));
  for (const lbl of extractInlineLabels(note.body)) {
    set.add(lbl);
  }
  return Array.from(set);
}

const STATUS_CHAR_TO_TASK: Record<string, TaskStatus> = {
  ' ': 'todo',
  '/': 'doing',
  '?': 'waiting',
  x: 'done',
  X: 'done',
};

const TASK_TO_STATUS_CHAR: Record<TaskStatus, string> = {
  todo: ' ',
  doing: '/',
  waiting: '?',
  done: 'x',
};

/**
 * Parses inline Tasks and Decisions from a Note's Markdown body.
 */
export function parseNoteItems(
  note: Note,
  knownPeople: Person[] = []
): { tasks: ParsedTask[]; decisions: ParsedDecision[] } {
  const lines = note.body.split('\n');
  const tasks: ParsedTask[] = [];
  const decisions: ParsedDecision[] = [];
  const noteLevelLabels = note.labels.map(normalizeLabel).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1. Check Decision syntax: - [D] or - [D:agreed] / - [D:proposed] / - [D:superseded]
    const decMatch = line.match(/^\s*[-*]\s*\[D(?::(agreed|proposed|superseded))?\]\s+(.+)$/i);
    if (decMatch) {
      const status = ((decMatch[1] || 'agreed').toLowerCase() as DecisionStatus);
      const rawContent = decMatch[2].trim();
      const inlineLabels = extractInlineLabels(rawContent);
      const stakeholders = extractInlineMentions(rawContent, knownPeople);

      const cleanText = rawContent
        .replace(/(?:^|\s)#[\p{L}][\p{L}\p{N}_-]{1,38}/gu, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

      let rationale: string | null = null;
      let rationaleLineIndex: number | null = null;
      if (i + 1 < lines.length) {
        const nextMatch = lines[i + 1].match(/^\s*>\s*(?:Rationale:\s*)?(.+)$/i);
        if (nextMatch) {
          rationale = nextMatch[1].trim();
          rationaleLineIndex = i + 1;
        }
      }

      decisions.push({
        id: `${note.id}:D${i}`,
        noteId: note.id,
        noteTitle: note.title || 'Untitled Note',
        noteDate: note.date,
        clientId: note.clientId,
        projectId: note.projectId,
        lineIndex: i,
        rationaleLineIndex,
        rawLine: line,
        status,
        text: cleanText || rawContent,
        rationale,
        stakeholders,
        labels: Array.from(new Set([...noteLevelLabels, ...inlineLabels])),
      });
      continue;
    }

    // 2. Check Task syntax: - [ ] / - [/] / - [?] / - [x]
    const taskMatch = line.match(/^\s*[-*]\s*\[([ /?xX])\]\s+(.+)$/);
    if (taskMatch) {
      const status = STATUS_CHAR_TO_TASK[taskMatch[1]] || 'todo';
      const rawContent = taskMatch[2].trim();
      const inlineLabels = extractInlineLabels(rawContent);
      const mentions = extractInlineMentions(rawContent, knownPeople);
      const owner = mentions[0] || null;

      const dueMatch = rawContent.match(/\bdue:(\d{4}-\d{2}-\d{2})\b/i);
      const dueDate = dueMatch ? dueMatch[1] : null;

      const prioMatch = rawContent.match(/(?:^|\s)!(high|medium|med|low)\b/i);
      let priority: TaskPriority | null = null;
      if (prioMatch) {
        const p = prioMatch[1].toLowerCase();
        priority = p === 'med' ? 'medium' : (p as TaskPriority);
      }

      const cleanText = rawContent
        .replace(/\bdue:\d{4}-\d{2}-\d{2}\b/gi, '')
        .replace(/(?:^|\s)!(?:high|medium|med|low)\b/gi, '')
        .replace(/(?:^|\s)#[\p{L}][\p{L}\p{N}_-]{1,38}/gu, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

      tasks.push({
        id: `${note.id}:T${i}`,
        noteId: note.id,
        noteTitle: note.title || 'Untitled Note',
        noteDate: note.date,
        clientId: note.clientId,
        projectId: note.projectId,
        lineIndex: i,
        rawLine: line,
        status,
        text: cleanText || rawContent,
        owner,
        dueDate,
        priority,
        labels: Array.from(new Set([...noteLevelLabels, ...inlineLabels])),
      });
    }
  }

  return { tasks, decisions };
}

export function formatPersonMention(name: string): string {
  return /\s/.test(name.trim()) ? `@[${name.trim()}]` : `@${name.trim()}`;
}

export function serializeTaskLine(params: {
  status: TaskStatus;
  text: string;
  owner?: string | null;
  dueDate?: string | null;
  priority?: TaskPriority | null;
  labels?: string[];
}): string {
  const char = TASK_TO_STATUS_CHAR[params.status];
  let body = params.text.trim();
  if (params.owner && !body.includes(`@[${params.owner}]`) && !body.includes(`@${params.owner}`)) {
    body += ` ${formatPersonMention(params.owner)}`;
  }
  if (params.dueDate) {
    body = body.replace(/\bdue:\d{4}-\d{2}-\d{2}\b/gi, '').trim() + ` due:${params.dueDate}`;
  }
  if (params.priority) {
    body = body.replace(/(?:^|\s)!(?:high|medium|med|low)\b/gi, '').trim() + ` !${params.priority}`;
  }
  if (params.labels && params.labels.length > 0) {
    for (const lbl of params.labels) {
      const n = normalizeLabel(lbl);
      if (n && !new RegExp(`#${n}\\b`, 'i').test(body)) {
        body += ` #${n}`;
      }
    }
  }
  return `- [${char}] ${body.replace(/\s{2,}/g, ' ').trim()}`;
}

/**
 * Two-way sync mutator: updates a specific Task line directly inside a note's Markdown body.
 */
export function updateTaskInBody(
  body: string,
  lineIndex: number,
  updates: Partial<{ status: TaskStatus; owner: string | null; dueDate: string | null; priority: TaskPriority | null }>
): string {
  const lines = body.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return body;
  const line = lines[lineIndex];
  const m = line.match(/^(\s*[-*]\s*\[)([ /?xX])(\]\s+)(.+)$/);
  if (!m) return body;

  const prefixIndent = m[1];
  const currentStatus = STATUS_CHAR_TO_TASK[m[2]] || 'todo';
  const nextStatus = updates.status ?? currentStatus;
  let content = m[4];

  if (updates.dueDate !== undefined) {
    content = content.replace(/\s*\bdue:\d{4}-\d{2}-\d{2}\b/gi, '');
    if (updates.dueDate) content += ` due:${updates.dueDate}`;
  }

  if (updates.priority !== undefined) {
    content = content.replace(/\s*!(?:high|medium|med|low)\b/gi, '');
    if (updates.priority) content += ` !${updates.priority}`;
  }

  if (updates.owner !== undefined) {
    content = content.replace(/\s*@\[[^\]]+\]/g, '').replace(/(?:^|\s)@[\p{L}][\p{L}\p{N}._-]{1,30}/gu, '');
    if (updates.owner) content = `${content.trim()} ${formatPersonMention(updates.owner)}`;
  }

  lines[lineIndex] = `${prefixIndent}${TASK_TO_STATUS_CHAR[nextStatus]}] ${content.replace(/\s{2,}/g, ' ').trim()}`;
  return lines.join('\n');
}

/**
 * Two-way sync mutator: updates a specific Decision's status or rationale directly inside a note's Markdown body.
 */
export function updateDecisionInBody(
  body: string,
  lineIndex: number,
  updates: Partial<{ status: DecisionStatus; rationale: string | null }>
): string {
  const lines = body.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return body;
  const line = lines[lineIndex];
  const m = line.match(/^(\s*[-*]\s*\[D)(?::(agreed|proposed|superseded))?(\]\s+.+)$/i);
  if (!m) return body;

  const currentStatus = ((m[2] || 'agreed').toLowerCase() as DecisionStatus);
  const nextStatus = updates.status ?? currentStatus;
  lines[lineIndex] = `${m[1]}:${nextStatus}${m[3]}`;

  if (updates.rationale !== undefined) {
    const hasExistingRationale =
      lineIndex + 1 < lines.length && /^\s*>\s*(?:Rationale:\s*)?(.+)$/i.test(lines[lineIndex + 1]);
    if (updates.rationale && updates.rationale.trim()) {
      const ratLine = `  > Rationale: ${updates.rationale.trim()}`;
      if (hasExistingRationale) {
        lines[lineIndex + 1] = ratLine;
      } else {
        lines.splice(lineIndex + 1, 0, ratLine);
      }
    } else if (hasExistingRationale) {
      lines.splice(lineIndex + 1, 1);
    }
  }

  return lines.join('\n');
}

/**
 * Deletes a Task line from a note's Markdown body.
 */
export function deleteTaskFromBody(body: string, lineIndex: number): string {
  const lines = body.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return body;
  lines.splice(lineIndex, 1);
  return lines.join('\n');
}

/**
 * Deletes a Decision line (and its indented Rationale sub-line if present) from a note's Markdown body.
 */
export function deleteDecisionFromBody(body: string, lineIndex: number): string {
  const lines = body.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return body;
  const hasRationale =
    lineIndex + 1 < lines.length && /^\s*>\s*(?:Rationale:\s*)?(.+)$/i.test(lines[lineIndex + 1]);
  lines.splice(lineIndex, hasRationale ? 2 : 1);
  return lines.join('\n');
}

/**
 * Removes a #label from both a note's frontmatter labels array and inline #label tokens in the body.
 */
export function removeLabelFromNote(note: Note, targetLabel: string): Note {
  const norm = normalizeLabel(targetLabel);
  if (!norm) return note;
  const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nextBody = note.body
    .replace(new RegExp(`(^|[\\s(])#${escaped}(?=$|[\\s,.;:!?)])`, 'giu'), '$1')
    .replace(/ {2,}/g, ' ');
  const nextLabels = note.labels.filter((l) => normalizeLabel(l) !== norm);
  if (nextBody === note.body && nextLabels.length === note.labels.length) return note;
  return {
    ...note,
    labels: nextLabels,
    body: nextBody,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Computes canonical relative .md path for local/OneDrive folder sync:
 * Inbox/ | Internal/<Project>/ | Clients/<Client>/<Project>/
 */
export function computeNoteFilePath(note: Note, directory: WorkspaceDirectory): string {
  const fileSlug = `${note.date || 'undated'}-${slugify(note.title || 'untitled')}.md`;
  if (note.scope === 'inbox') {
    return `Inbox/${fileSlug}`;
  }
  if (note.scope === 'internal') {
    const proj = directory.projects.find((p) => p.id === note.projectId);
    const projFolder = proj ? folderSegment(proj.name) : 'General';
    return `Internal/${projFolder}/${fileSlug}`;
  }
  const client = directory.clients.find((c) => c.id === note.clientId);
  const clientFolder = client ? folderSegment(client.name) : 'Unassigned-Client';
  const proj = directory.projects.find((p) => p.id === note.projectId);
  const projFolder = proj ? folderSegment(proj.name) : 'General';
  return `Clients/${clientFolder}/${projFolder}/${fileSlug}`;
}

function escapeYaml(val: string): string {
  return JSON.stringify(val);
}

/**
 * Serializes a Note into clean human-readable Markdown with YAML frontmatter.
 */
export function serializeNoteToMarkdown(note: Note, directory: WorkspaceDirectory): string {
  const clientName = directory.clients.find((c) => c.id === note.clientId)?.name || '';
  const projectName = directory.projects.find((p) => p.id === note.projectId)?.name || '';
  const allLabels = getAllNoteLabels(note);

  const lines: string[] = [
    '---',
    `id: ${note.id}`,
    `title: ${escapeYaml(note.title || 'Untitled Note')}`,
    `date: ${note.date}`,
    `scope: ${note.scope}`,
  ];

  if (clientName) lines.push(`client: ${escapeYaml(clientName)}`);
  if (projectName) lines.push(`project: ${escapeYaml(projectName)}`);

  if (note.participants.length > 0) {
    lines.push('participants:');
    for (const p of note.participants) {
      lines.push(`  - ${escapeYaml(p)}`);
    }
  } else {
    lines.push('participants: []');
  }

  if (allLabels.length > 0) {
    lines.push('labels:');
    for (const l of allLabels) {
      lines.push(`  - ${l}`);
    }
  } else {
    lines.push('labels: []');
  }

  lines.push(`createdAt: ${note.createdAt}`);
  lines.push(`updatedAt: ${note.updatedAt}`);
  lines.push('---', '');

  return lines.join('\n') + note.body;
}

function unquoteYaml(val: string): string {
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      if (trimmed.startsWith('"')) return JSON.parse(trimmed);
    } catch {
      // Fallback
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parses a Markdown file with YAML frontmatter back into a Note and reconciles Client/Project entities.
 */
export function parseMarkdownToNote(
  rawMarkdown: string,
  fallbackPath: string,
  directory: WorkspaceDirectory
): { note: Note; newClients: Client[]; newProjects: Project[]; newPeople: Person[] } {
  const newClients: Client[] = [];
  const newProjects: Project[] = [];
  const newPeople: Person[] = [];

  let frontmatterBlock = '';
  let body = rawMarkdown;

  if (rawMarkdown.startsWith('---\n') || rawMarkdown.startsWith('---\r\n')) {
    const endIdx = rawMarkdown.indexOf('\n---', 3);
    if (endIdx !== -1) {
      frontmatterBlock = rawMarkdown.slice(4, endIdx);
      body = rawMarkdown.slice(endIdx + 4).replace(/^\r?\n/, '');
    }
  }

  const meta: Record<string, string | string[]> = {};
  let activeListKey: string | null = null;

  for (const rawLine of frontmatterBlock.split(/\r?\n/)) {
    const listItemMatch = rawLine.match(/^\s*-\s+(.+)$/);
    if (listItemMatch && activeListKey) {
      const arr = (meta[activeListKey] as string[]) || [];
      arr.push(unquoteYaml(listItemMatch[1]));
      meta[activeListKey] = arr;
      continue;
    }
    const kvMatch = rawLine.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '') {
        activeListKey = key;
        meta[key] = [];
      } else if (val === '[]') {
        activeListKey = null;
        meta[key] = [];
      } else {
        activeListKey = null;
        meta[key] = unquoteYaml(val);
      }
    }
  }

  const fileBase = fallbackPath.split('/').pop()?.replace(/\.md$/i, '') || 'Untitled';
  const title = (typeof meta.title === 'string' && meta.title) || fileBase.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const dateMatch = fileBase.match(/^(\d{4}-\d{2}-\d{2})/);
  const date =
    (typeof meta.date === 'string' && meta.date) ||
    (dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10));

  let scope: NoteScope = 'inbox';
  if (meta.scope === 'client' || meta.scope === 'internal' || meta.scope === 'inbox') {
    scope = meta.scope;
  } else if (fallbackPath.startsWith('Clients/')) {
    scope = 'client';
  } else if (fallbackPath.startsWith('Internal/')) {
    scope = 'internal';
  }

  const clientName = typeof meta.client === 'string' ? meta.client : '';
  const projectName = typeof meta.project === 'string' ? meta.project : '';

  let clientId: string | null = null;
  if (clientName) {
    const existing =
      directory.clients.find((c) => c.name.toLowerCase() === clientName.toLowerCase()) ||
      newClients.find((c) => c.name.toLowerCase() === clientName.toLowerCase());
    if (existing) {
      clientId = existing.id;
    } else {
      const created: Client = {
        id: `client-${slugify(clientName)}`,
        name: clientName,
        color: '#0284c7',
      };
      newClients.push(created);
      clientId = created.id;
    }
    scope = 'client';
  }

  let projectId: string | null = null;
  if (projectName) {
    const existing =
      directory.projects.find(
        (p) => p.name.toLowerCase() === projectName.toLowerCase() && p.clientId === clientId
      ) ||
      newProjects.find((p) => p.name.toLowerCase() === projectName.toLowerCase() && p.clientId === clientId);
    if (existing) {
      projectId = existing.id;
    } else {
      const created: Project = {
        id: `proj-${slugify(projectName)}-${Date.now().toString(36).slice(-4)}`,
        name: projectName,
        scope: clientId ? 'client' : 'internal',
        clientId,
        status: 'active',
      };
      newProjects.push(created);
      projectId = created.id;
    }
  }

  const participants = Array.isArray(meta.participants) ? meta.participants.filter(Boolean) : [];
  for (const pName of participants) {
    const exists =
      directory.people.some((p) => p.name.toLowerCase() === pName.toLowerCase()) ||
      newPeople.some((p) => p.name.toLowerCase() === pName.toLowerCase());
    if (!exists) {
      newPeople.push({
        id: `person-${slugify(pName)}`,
        name: pName,
        clientId,
      });
    }
  }

  const labels = Array.isArray(meta.labels) ? meta.labels.map(normalizeLabel).filter(Boolean) : [];
  const nowIso = new Date().toISOString();

  const note: Note = {
    id: (typeof meta.id === 'string' && meta.id) || `note-${slugify(fallbackPath)}-${Date.now().toString(36)}`,
    title,
    date,
    scope,
    clientId,
    projectId,
    participants,
    labels,
    body,
    createdAt: (typeof meta.createdAt === 'string' && meta.createdAt) || nowIso,
    updatedAt: (typeof meta.updatedAt === 'string' && meta.updatedAt) || nowIso,
    filePath: fallbackPath,
  };

  return { note, newClients, newProjects, newPeople };
}

/**
 * Parses pasted Outlook / Microsoft Teams calendar headers or attendee lists.
 */
export function parseMeetingInviteText(
  inviteText: string,
  directory: WorkspaceDirectory
): {
  title?: string;
  date?: string;
  participants: string[];
  inferredClientId: string | null;
  newPeople: Person[];
} {
  const lines = inviteText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let title: string | undefined;
  let date: string | undefined;
  const attendeeChunks: string[] = [];

  for (const line of lines) {
    const subj = line.match(/^(?:Subject|Title|Meeting|Topic)\s*:\s*(.+)$/i);
    if (subj) {
      title = subj[1].trim();
      continue;
    }
    const when = line.match(/^(?:Date|When|Start|Time)\s*:\s*(.+)$/i);
    if (when) {
      const parsed = new Date(when[1]);
      if (!Number.isNaN(parsed.getTime())) {
        date = parsed.toISOString().slice(0, 10);
      } else {
        const isoMatch = when[1].match(/\b(\d{4}-\d{2}-\d{2})\b/);
        if (isoMatch) date = isoMatch[1];
      }
      continue;
    }
    const att = line.match(/^(?:Required|Optional|Attendees|To|Participants|Who)\s*:\s*(.+)$/i);
    if (att) {
      attendeeChunks.push(att[1]);
      continue;
    }
    if (line.includes('@') || line.includes(';')) {
      attendeeChunks.push(line);
    } else if (!title && lines.indexOf(line) === 0 && line.length < 110) {
      title = line;
    }
  }

  const participants: string[] = [];
  const newPeople: Person[] = [];
  let inferredClientId: string | null = null;

  const rawTokens = attendeeChunks
    .join(';')
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const tok of rawTokens) {
    const emailMatch = tok.match(/<([^>]+@[^>]+)>|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const email = emailMatch ? (emailMatch[1] || emailMatch[2]).toLowerCase() : undefined;
    let rawName = tok
      .replace(/<[^>]+>/g, '')
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '')
      .replace(/\([^)]*\)/g, '')
      .trim();

    if (!rawName && email) {
      rawName = email
        .split('@')[0]
        .split(/[._-]/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
    }
    if (!rawName || rawName.length < 2) continue;

    const existing = directory.people.find(
      (p) => p.name.toLowerCase() === rawName.toLowerCase() || (email && p.email?.toLowerCase() === email)
    );

    if (existing) {
      if (!participants.includes(existing.name)) participants.push(existing.name);
      if (!inferredClientId && existing.clientId) inferredClientId = existing.clientId;
    } else {
      let personClientId: string | null = null;
      if (email) {
        const domain = email.split('@')[1];
        const matchedClient = directory.clients.find(
          (c) =>
            (c.domain && domain.includes(c.domain.toLowerCase())) ||
            domain.includes(slugify(c.name).replace(/-/g, ''))
        );
        if (matchedClient) {
          personClientId = matchedClient.id;
          if (!inferredClientId) inferredClientId = matchedClient.id;
        }
      }
      if (!participants.includes(rawName)) participants.push(rawName);
      newPeople.push({
        id: `person-${slugify(rawName)}-${Date.now().toString(36).slice(-3)}`,
        name: rawName,
        email,
        clientId: personClientId,
      });
    }
  }

  if (!inferredClientId && title) {
    const lowerTitle = title.toLowerCase();
    const matchedClient = directory.clients.find((c) => lowerTitle.includes(c.name.toLowerCase()));
    if (matchedClient) inferredClientId = matchedClient.id;
  }

  return { title, date, participants, inferredClientId, newPeople };
}
