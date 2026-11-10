import type {
  AiConfig,
  AiStructureProposal,
  DecisionStatus,
  Note,
  NoteScope,
  ParsedDecision,
  ParsedTask,
  TaskPriority,
  WorkspaceDirectory,
} from '../types';
import { buildDeterministicExecutiveBrief, localAskWorkspace } from './contextEngine';
import {
  detectUnlinkedPeopleInText,
  extractInlineLabels,
  extractInlineMentions,
  formatPersonMention,
  matchDecisionLine,
  matchTaskLine,
  normalizeLabel,
  normalizeStructuredMarkdown,
  serializeTaskLine,
} from './markdown';

const AI_CONFIG_KEY = 'strata.aiConfig.v1';

export function loadAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(AI_CONFIG_KEY);
    if (raw) return JSON.parse(raw) as AiConfig;
  } catch {
    // Ignore storage read errors
  }
  return {
    provider: 'local',
    apiKey: '',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    azureApiVersion: '2024-10-21',
  };
}

export function saveAiConfig(config: AiConfig): void {
  try {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage write errors in sandboxed preview iframes
  }
}

export async function callConfiguredLlm(systemPrompt: string, userPrompt: string, config: AiConfig): Promise<string> {
  if (config.provider === 'local' || !config.apiKey.trim()) {
    throw new Error('Local deterministic engine active');
  }

  if (config.provider === 'openai') {
    const base = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI gateway error (${res.status})`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  if (config.provider === 'azure') {
    const endpoint = (config.baseUrl || '').replace(/\/+$/, '');
    const deployment = config.azureDeployment || config.model;
    const apiVer = config.azureApiVersion || '2024-10-21';
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVer}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': config.apiKey.trim(),
      },
      body: JSON.stringify({
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Azure OpenAI error (${res.status})`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  if (config.provider === 'gemini') {
    const model = config.model || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      config.apiKey.trim()
    )}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API error (${res.status})`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (config.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: config.model || 'claude-3-5-haiku-latest',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error (${res.status})`);
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  throw new Error('Unsupported AI provider');
}

function inferRelativeDueDate(line: string, baseDateStr: string): string | null {
  const iso = line.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const base = new Date(`${baseDateStr}T12:00:00`);
  if (Number.isNaN(base.getTime())) return null;

  const lower = line.toLowerCase();
  if (/\btomorrow\b/.test(lower)) {
    base.setDate(base.getDate() + 1);
    return base.toISOString().slice(0, 10);
  }
  if (/\bnext week\b/.test(lower)) {
    base.setDate(base.getDate() + 7);
    return base.toISOString().slice(0, 10);
  }
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let d = 0; d < dayNames.length; d++) {
    if (new RegExp(`\\bby\\s+${dayNames[d]}\\b`, 'i').test(lower)) {
      const diff = (d + 7 - base.getDay()) % 7 || 7;
      base.setDate(base.getDate() + diff);
      return base.toISOString().slice(0, 10);
    }
  }
  return null;
}

/**
 * Local Smart Deterministic Structuring & Entity Extractor (runs in <5ms with zero network calls).
 */
export function buildLocalStructureProposal(note: Note, directory: WorkspaceDirectory): AiStructureProposal {
  const fullText = `${note.title}\n${note.body}`;
  const lowerFull = fullText.toLowerCase();

  // 1. Infer People (existing @mentions + natural unlinked names)
  const mentioned = extractInlineMentions(note.body, directory.people);
  const unlinked = detectUnlinkedPeopleInText(note.body, directory.people).map((p) => p.name);
  const allDetectedPeople = Array.from(new Set([...note.participants, ...mentioned, ...unlinked]));

  // 2. Infer Client & Project
  let suggestedClientId = note.clientId;
  let suggestedScope: NoteScope = note.scope;
  if (!suggestedClientId) {
    for (const c of directory.clients) {
      if (lowerFull.includes(c.name.toLowerCase())) {
        suggestedClientId = c.id;
        suggestedScope = 'client';
        break;
      }
    }
  }
  if (!suggestedClientId) {
    for (const pName of allDetectedPeople) {
      const person = directory.people.find((x) => x.name.toLowerCase() === pName.toLowerCase());
      if (person?.clientId) {
        suggestedClientId = person.clientId;
        suggestedScope = 'client';
        break;
      }
    }
  }

  let suggestedProjectId = note.projectId;
  if (!suggestedProjectId) {
    for (const proj of directory.projects) {
      if (lowerFull.includes(proj.name.toLowerCase())) {
        suggestedProjectId = proj.id;
        suggestedScope = proj.scope;
        if (proj.clientId) suggestedClientId = proj.clientId;
        break;
      }
    }
  }

  // 3. Infer Labels from inline #tags + keyword vocabulary
  const labelHints: Record<string, string[]> = {
    security: ['sso', 'saml', 'okta', 'auth', 'security', 'encryption', 'soc2', 'audit'],
    pricing: ['budget', 'pricing', 'cost', 'quote', 'sow', 'contract', 'discount', 'invoice'],
    architecture: ['api', 'schema', 'migration', 'cloud', 'architecture', 'database', 'latency'],
    roadmap: ['roadmap', 'q1', 'q2', 'q3', 'q4', 'milestone', 'launch', 'timeline', 'cutover'],
    risk: ['blocker', 'risk', 'delay', 'escalation', 'dependency'],
  };

  const labelSet = new Set<string>([...note.labels.map(normalizeLabel), ...extractInlineLabels(note.body)]);
  for (const [label, keywords] of Object.entries(labelHints)) {
    if (keywords.some((kw) => new RegExp(`\\b${kw}\\b`, 'i').test(lowerFull))) {
      labelSet.add(label);
    }
  }

  // 4. Extract implicit Tasks and Decisions from prose lines
  const rawLines = note.body.replace(/\r\n?/g, '\n').split('\n');
  const extractedTasks: AiStructureProposal['extractedTasks'] = [];
  const extractedDecisions: AiStructureProposal['extractedDecisions'] = [];
  const discussionLines: string[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip already structured tasks/decisions when scanning for *new* implicit ones, but preserve in restructured
    if (matchTaskLine(trimmed) || matchDecisionLine(trimmed)) {
      continue;
    }

    // Preserve standalone Markdown image blocks untouched
    if (/^!\[[^\]]*\]\([^)]+\)$/.test(trimmed)) {
      discussionLines.push(trimmed);
      continue;
    }

    const strippedBullet = trimmed.replace(/^(?:[-*+•]\s+)+/, '');

    // Implicit Decision patterns (English & German)
    const decPattern =
      /^(?:decision|decided|agreed|we agreed|proposal|proposed|entscheid|entscheidung|entschieden|beschlossen|vereinbart|vorschlag|vorgeschlagen)\s*[:\-—]?\s*(.+)$/i;
    const inlineDecMatch =
      strippedBullet.match(decPattern) ||
      (/\b(?:we agreed to|decided to|approved moving to|will standardize on|kann weggelassen werden|wird weggelassen|wurde beschlossen)\b/i.test(
        strippedBullet
      )
        ? [strippedBullet, strippedBullet]
        : null);

    if (inlineDecMatch) {
      const status: DecisionStatus = /\b(?:propos|vorschlag|vorgeschlagen|kann\s+\w+\s+werden)\b/i.test(strippedBullet)
        ? 'proposed'
        : 'agreed';
      let statement = inlineDecMatch[1].trim();
      for (const p of directory.people) {
        const esc = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        statement = statement.replace(new RegExp(`(?<!@\\[?)\\b${esc}\\b`, 'gi'), formatPersonMention(p.name));
      }
      const stakeholders = extractInlineMentions(statement, directory.people);
      extractedDecisions.push({
        text: statement,
        status,
        stakeholders,
        rationale: null,
        labels: extractInlineLabels(statement),
      });
      continue;
    }

    // Implicit Task patterns (English & German)
    const taskPrefix =
      /^(?:todo|action|action item|next step|follow[- ]?up|aufgabe|pendent|pendenz)\s*[:\-—]?\s*(.+)$/i;
    const personWillPattern = directory.people.find((p) => {
      const first = p.name.split(/\s+/)[0];
      return new RegExp(`\\b(?:${p.name}|${first})\\s+(?:will|to|needs to|going to|wird|muss|soll)\\s+`, 'i').test(
        strippedBullet
      );
    });

    const prefMatch = strippedBullet.match(taskPrefix);
    if (
      prefMatch ||
      personWillPattern ||
      /\b(?:need to send|follow up with|schedule a|share revised|beschaffen|abklären|einholen)\b/i.test(strippedBullet)
    ) {
      const rawTaskText = (prefMatch ? prefMatch[1] : strippedBullet).trim();
      const mentions = extractInlineMentions(rawTaskText, directory.people);
      const owner = mentions[0] || personWillPattern?.name || null;
      const dueDate = inferRelativeDueDate(rawTaskText, note.date);
      const priority: TaskPriority | null = /\b(?:urgent|asap|critical|high priority|blocker|dringend)\b/i.test(
        rawTaskText
      )
        ? 'high'
        : null;

      extractedTasks.push({
        text: rawTaskText,
        owner,
        dueDate,
        priority,
        labels: extractInlineLabels(rawTaskText),
      });
      continue;
    }

    // Link natural person names inside discussion bullets
    let enrichedLine = strippedBullet;
    for (const p of directory.people) {
      const esc = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      enrichedLine = enrichedLine.replace(new RegExp(`(?<!@\\[?)\\b${esc}\\b`, 'g'), formatPersonMention(p.name));
    }
    const isStandaloneBoldHeading = /^\*\*[^*\n]+\*\*:?$/.test(trimmed);
    if (trimmed.startsWith('#') || isStandaloneBoldHeading) {
      discussionLines.push(enrichedLine);
    } else {
      discussionLines.push(`- ${enrichedLine}`);
    }
  }

  // 5. Infer crisp Title if blank/untitled
  let suggestedTitle = note.title.trim();
  if (!suggestedTitle || /^untitled/i.test(suggestedTitle)) {
    const clientName = directory.clients.find((c) => c.id === suggestedClientId)?.name;
    const projName = directory.projects.find((p) => p.id === suggestedProjectId)?.name;
    const firstTextLine = discussionLines.find((l) => !/^!\[[^\]]*\]\([^)]+\)$/.test(l.trim()));
    if (clientName && projName) {
      suggestedTitle = `${clientName} — ${projName} Sync`;
    } else if (clientName) {
      suggestedTitle = `${clientName} — Working Session`;
    } else if (firstTextLine) {
      suggestedTitle = firstTextLine.replace(/^[-*#\s]+/, '').slice(0, 56);
    } else {
      suggestedTitle = `Working Note (${note.date})`;
    }
  }

  // 6. Compose clean Restructured Markdown Body
  const existingTaskLines = rawLines
    .map((l) => matchTaskLine(l))
    .filter((m): m is NonNullable<typeof m> => Boolean(m && m.text))
    .map((m) => `- [${m.statusChar}] ${m.text}`);
  const existingDecisionLines = rawLines
    .map((l) => matchDecisionLine(l))
    .filter((m): m is NonNullable<typeof m> => Boolean(m && m.text))
    .map((m) => `- [D:${m.status}] ${m.text}`);

  const sections: string[] = [];
  if (discussionLines.length > 0) {
    const hasHeading = discussionLines.some((l) => l.startsWith('#') || /^\*\*[^*]+\*\*$/.test(l));
    if (!hasHeading) sections.push('## Discussion & Context');
    sections.push(...discussionLines);
  }

  const allDecLines = [
    ...existingDecisionLines,
    ...extractedDecisions.map((d) => `- [D:${d.status}] ${d.text}`),
  ];
  if (allDecLines.length > 0) {
    sections.push('', '## Decisions', ...allDecLines);
  }

  const allTaskLines = [
    ...existingTaskLines,
    ...extractedTasks.map((t) =>
      serializeTaskLine({
        status: 'todo',
        text: t.text,
        owner: t.owner,
        dueDate: t.dueDate,
        priority: t.priority,
        labels: t.labels,
      })
    ),
  ];
  if (allTaskLines.length > 0) {
    sections.push('', '## Action Items', ...allTaskLines);
  }

  return {
    suggestedTitle,
    suggestedScope,
    suggestedClientId,
    suggestedProjectId,
    suggestedParticipants: allDetectedPeople.slice(0, 8),
    suggestedLabels: Array.from(labelSet).filter(Boolean),
    extractedTasks,
    extractedDecisions,
    restructuredBody: normalizeStructuredMarkdown(sections.join('\n').trim() || note.body),
    usedProvider: 'Local Smart Engine (Zero-Network)',
  };
}

export interface AiActivitySnapshot {
  activeCount: number;
  isBusy: boolean;
  label: string | null;
  providerLabel: string | null;
}

export function formatAiEngineLabel(config: AiConfig): string {
  if (config.provider === 'local' || !config.apiKey.trim()) {
    return 'Local Smart Engine';
  }
  if (config.provider === 'azure') {
    return `AZURE (${config.azureDeployment || config.model || 'gpt-4o'})`;
  }
  return `${config.provider.toUpperCase()} (${config.model})`;
}

let nextRequestId = 1;
const activeAiRequests = new Map<number, { label: string; providerLabel: string }>();
const aiListeners = new Set<() => void>();
let currentAiSnapshot: AiActivitySnapshot = {
  activeCount: 0,
  isBusy: false,
  label: null,
  providerLabel: null,
};

function emitAiActivity(): void {
  const entries = Array.from(activeAiRequests.values());
  const latest = entries[entries.length - 1] || null;
  currentAiSnapshot = {
    activeCount: entries.length,
    isBusy: entries.length > 0,
    label: latest ? latest.label : null,
    providerLabel: latest ? latest.providerLabel : null,
  };
  for (const listener of aiListeners) {
    listener();
  }
}

export function subscribeAiActivity(listener: () => void): () => void {
  aiListeners.add(listener);
  return () => {
    aiListeners.delete(listener);
  };
}

export function getAiActivitySnapshot(): AiActivitySnapshot {
  return currentAiSnapshot;
}

export async function withAiActivity<T>(
  label: string,
  config: AiConfig,
  fn: () => Promise<T>
): Promise<T> {
  const reqId = nextRequestId++;
  const providerLabel = formatAiEngineLabel(config);
  activeAiRequests.set(reqId, { label, providerLabel });
  emitAiActivity();

  const isOfflineEngine = config.provider === 'local' || !config.apiKey.trim();
  try {
    if (isOfflineEngine) {
      await new Promise<void>((resolve) => setTimeout(resolve, 240));
    }
    return await fn();
  } finally {
    activeAiRequests.delete(reqId);
    emitAiActivity();
  }
}

export async function generateStructureProposal(
  note: Note,
  directory: WorkspaceDirectory,
  config: AiConfig
): Promise<AiStructureProposal> {
  return withAiActivity('AI: Structuring note…', config, async () => {
    const localProposal = buildLocalStructureProposal(note, directory);
    if (config.provider === 'local' || !config.apiKey.trim()) {
      return localProposal;
    }

    try {
      const systemPrompt = `You are an executive note-structuring assistant. Return STRICT JSON matching this schema:
{
  "suggestedTitle": "string",
  "clientName": "string or null",
  "projectName": "string or null",
  "suggestedParticipants": ["Full Name"],
  "suggestedLabels": ["lowercase-tag"],
  "extractedTasks": [{"text": "string", "owner": "Full Name or null", "dueDate": "YYYY-MM-DD or null", "priority": "high|medium|low|null", "labels": []}],
  "extractedDecisions": [{"text": "string", "status": "agreed|proposed|superseded", "stakeholders": ["Full Name"], "rationale": "string or null", "labels": []}],
  "restructuredBody": "Clean markdown using @[Full Name] for people, #tag for labels, '- [ ] Task @[Owner] due:YYYY-MM-DD' for tasks, and '- [D:agreed] Decision' or '- [D:proposed] Decision' for decisions. IMPORTANT: Every task and decision line MUST start at the beginning of a line with a single '- [ ] ' or '- [D:...] ' prefix (never double-bullet like '- - [ ]' or '• - [D:...]')."
}
Preserve the original language and factual precision of the note.`;

      const userPrompt = `Known Clients: ${directory.clients.map((c) => c.name).join(', ') || 'None'}
Known Projects: ${directory.projects.map((p) => p.name).join(', ') || 'None'}
Known People: ${directory.people.map((p) => `${p.name}${p.role ? ` (${p.role})` : ''}`).join(', ') || 'None'}
Note Date: ${note.date}
Current Title: ${note.title}
Current Body:
${note.body}`;

      const raw = await callConfiguredLlm(systemPrompt, userPrompt, config);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return localProposal;
      const parsed = JSON.parse(jsonMatch[0]);

      const matchedClient = parsed.clientName
        ? directory.clients.find((c) => c.name.toLowerCase() === String(parsed.clientName).toLowerCase())
        : null;
      const matchedProj = parsed.projectName
        ? directory.projects.find((p) => p.name.toLowerCase() === String(parsed.projectName).toLowerCase())
        : null;

      return {
        suggestedTitle: parsed.suggestedTitle || localProposal.suggestedTitle,
        suggestedScope: matchedClient ? 'client' : matchedProj ? matchedProj.scope : localProposal.suggestedScope,
        suggestedClientId: matchedClient?.id ?? localProposal.suggestedClientId,
        suggestedProjectId: matchedProj?.id ?? localProposal.suggestedProjectId,
        suggestedParticipants: Array.isArray(parsed.suggestedParticipants)
          ? parsed.suggestedParticipants
          : localProposal.suggestedParticipants,
        suggestedLabels: Array.isArray(parsed.suggestedLabels)
          ? parsed.suggestedLabels.map(normalizeLabel).filter(Boolean)
          : localProposal.suggestedLabels,
        extractedTasks: Array.isArray(parsed.extractedTasks) ? parsed.extractedTasks : localProposal.extractedTasks,
        extractedDecisions: Array.isArray(parsed.extractedDecisions)
          ? parsed.extractedDecisions
          : localProposal.extractedDecisions,
        restructuredBody: normalizeStructuredMarkdown(
          unwrapOuterMarkdownFence(parsed.restructuredBody || localProposal.restructuredBody)
        ),
        usedProvider: formatAiEngineLabel(config),
      };
    } catch {
      return localProposal;
    }
  });
}

export function unwrapOuterMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return match ? match[1].trim() : trimmed;
}

export async function askWorkspaceWithAiOrFallback(
  question: string,
  allNotes: Note[],
  directory: WorkspaceDirectory,
  config: AiConfig
): Promise<{ answerMarkdown: string; citedNotes: Note[]; usedProvider: string }> {
  return withAiActivity('AI: Answering query…', config, async () => {
    const localResult = localAskWorkspace(question, allNotes, directory);
    if (config.provider === 'local' || !config.apiKey.trim() || localResult.citedNotes.length === 0) {
      return { ...localResult, usedProvider: 'Local Context Index' };
    }

    try {
      const contextDump = localResult.citedNotes
        .map((n) => `--- NOTE: [[${n.title}]] (${n.date}) ---\n${n.body}`)
        .join('\n\n');

      const answer = await callConfiguredLlm(
        'Answer concisely using ONLY the provided notes. Cite source notes inline using [[Exact Note Title]]. Highlight relevant decisions and open tasks.',
        `Question: ${question}\n\nNotes:\n${contextDump}`,
        config
      );

      const cleanedAnswer = unwrapOuterMarkdownFence(answer);

      return {
        answerMarkdown: cleanedAnswer || localResult.answerMarkdown,
        citedNotes: localResult.citedNotes,
        usedProvider: formatAiEngineLabel(config),
      };
    } catch {
      return { ...localResult, usedProvider: 'Local Context Index (Fallback)' };
    }
  });
}

export async function generateExecutiveBriefWithAiOrFallback(params: {
  heading: string;
  notes: Note[];
  tasks: ParsedTask[];
  decisions: ParsedDecision[];
  config: AiConfig;
}): Promise<{ markdown: string; usedProvider: string }> {
  return withAiActivity('AI: Synthesizing brief…', params.config, async () => {
    const fallback = buildDeterministicExecutiveBrief(params);
    if (params.config.provider === 'local' || !params.config.apiKey.trim()) {
      return { markdown: fallback, usedProvider: 'Local Structured Synthesizer' };
    }

    try {
      const context = params.notes
        .slice(0, 10)
        .map((n) => `[[${n.title}]] (${n.date}):\n${n.body.slice(0, 1200)}`)
        .join('\n\n');

      const md = await callConfiguredLlm(
        'Write a crisp, high-signal executive status report in Markdown with sections for Executive Summary, Key Decisions, Open Action Items (with @owners & due dates), and Risks/Dependencies. Cite notes using [[Note Title]].',
        `Report Topic: ${params.heading}\n\nSource Notes:\n${context}`,
        params.config
      );
      const cleanedMd = unwrapOuterMarkdownFence(md);
      return {
        markdown: cleanedMd || fallback,
        usedProvider: formatAiEngineLabel(params.config),
      };
    } catch {
      return { markdown: fallback, usedProvider: 'Local Structured Synthesizer (Fallback)' };
    }
  });
}
