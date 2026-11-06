import type {
  Note,
  ParsedDecision,
  ParsedTask,
  RelatedNoteMatch,
  WorkspaceDirectory,
} from '../types';
import { extractInlineMentions, getAllNoteLabels, parseNoteItems } from './markdown';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'are',
  'was', 'were', 'been', 'into', 'about', 'they', 'them', 'their', 'our', 'your',
  'note', 'notes', 'meeting', 'sync', 'call', 'today', 'need', 'needs', 'also',
  'can', 'should', 'would', 'could', 'what', 'when', 'where', 'which', 'while',
]);

export function tokenizeUnicode(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((tok) => tok.length >= 3 && !STOP_WORDS.has(tok));
}

function buildSnippetAroundTerms(body: string, queryTerms: string[]): string {
  const cleanLines = body
    .split('\n')
    .map((l) => l.replace(/^\s*[-*#>\s]+/, '').trim())
    .filter((l) => l.length > 10);

  if (cleanLines.length === 0) return 'No body content yet.';

  if (queryTerms.length > 0) {
    let bestLine = cleanLines[0];
    let bestHits = -1;
    for (const line of cleanLines) {
      const lower = line.toLowerCase();
      let hits = 0;
      for (const t of queryTerms) {
        if (lower.includes(t)) hits++;
      }
      if (hits > bestHits) {
        bestHits = hits;
        bestLine = line;
      }
    }
    return bestLine.length > 165 ? bestLine.slice(0, 162) + '…' : bestLine;
  }

  const joined = cleanLines.slice(0, 2).join(' — ');
  return joined.length > 165 ? joined.slice(0, 162) + '…' : joined;
}

/**
 * Computes live Context Radar items for the active note:
 * 1. Related notes scored by Project, Client, shared Participants/@mentions, shared #labels, and lexical BM25-lite overlap
 * 2. Open carry-forward Tasks relevant to the active Client/Project/Participants
 * 3. Prior Decisions relevant to the active Client/Project/Labels
 */
export function computeContextRadar(
  activeNote: Note,
  allNotes: Note[],
  directory: WorkspaceDirectory
): {
  relatedNotes: RelatedNoteMatch[];
  carryForwardTasks: ParsedTask[];
  priorDecisions: ParsedDecision[];
} {
  const activeLabels = new Set(getAllNoteLabels(activeNote));
  const activePeople = new Set([
    ...activeNote.participants.map((p) => p.toLowerCase()),
    ...extractInlineMentions(activeNote.body, directory.people).map((p) => p.toLowerCase()),
  ]);
  const activeTokens = Array.from(new Set(tokenizeUnicode(`${activeNote.title} ${activeNote.body}`)));

  const otherNotes = allNotes.filter((n) => n.id !== activeNote.id);

  // Document frequency for IDF weighting
  const docFreq = new Map<string, number>();
  for (const n of otherNotes) {
    const uniq = new Set(tokenizeUnicode(`${n.title} ${n.body}`));
    for (const tok of uniq) {
      docFreq.set(tok, (docFreq.get(tok) || 0) + 1);
    }
  }

  const relatedNotes: RelatedNoteMatch[] = [];
  const carryForwardTasks: ParsedTask[] = [];
  const priorDecisions: ParsedDecision[] = [];

  for (const candidate of otherNotes) {
    let score = 0;
    const reasons: string[] = [];

    if (activeNote.projectId && candidate.projectId === activeNote.projectId) {
      const projName = directory.projects.find((p) => p.id === candidate.projectId)?.name || 'Same project';
      score += 36;
      reasons.push(`Project: ${projName}`);
    } else if (activeNote.clientId && candidate.clientId === activeNote.clientId) {
      const clientName = directory.clients.find((c) => c.id === candidate.clientId)?.name || 'Same client';
      score += 22;
      reasons.push(`Client: ${clientName}`);
    }

    const candPeople = [
      ...candidate.participants,
      ...extractInlineMentions(candidate.body, directory.people),
    ];
    const sharedPeople = Array.from(
      new Set(candPeople.filter((p) => activePeople.has(p.toLowerCase())))
    );
    if (sharedPeople.length > 0) {
      score += Math.min(32, sharedPeople.length * 14);
      reasons.push(`People: ${sharedPeople.slice(0, 2).join(', ')}`);
    }

    const candLabels = getAllNoteLabels(candidate);
    const sharedLabels = candLabels.filter((l) => activeLabels.has(l));
    if (sharedLabels.length > 0) {
      score += Math.min(30, sharedLabels.length * 13);
      reasons.push(`#${sharedLabels.slice(0, 2).join(', #')}`);
    }

    // Lexical TF-IDF overlap
    const candTokens = new Set(tokenizeUnicode(`${candidate.title} ${candidate.body}`));
    let lexicalScore = 0;
    const matchedTerms: string[] = [];
    for (const tok of activeTokens) {
      if (candTokens.has(tok)) {
        const df = docFreq.get(tok) || 1;
        const idf = Math.log(1 + (otherNotes.length + 1) / df);
        lexicalScore += idf * 4.2;
        matchedTerms.push(tok);
      }
    }
    if (lexicalScore >= 5) {
      score += Math.min(34, Math.round(lexicalScore));
      if (reasons.length === 0 && matchedTerms.length > 0) {
        reasons.push(`Topic match: ${matchedTerms.slice(0, 3).join(', ')}`);
      }
    }

    const parsed = parseNoteItems(candidate, directory.people);

    // Collect carry-forward open tasks when contextually linked
    const isSameScope =
      (activeNote.projectId && candidate.projectId === activeNote.projectId) ||
      (activeNote.clientId && candidate.clientId === activeNote.clientId) ||
      sharedPeople.length > 0 ||
      sharedLabels.length > 0;

    if (isSameScope || score >= 18) {
      for (const t of parsed.tasks) {
        if (t.status !== 'done') {
          carryForwardTasks.push(t);
        }
      }
      for (const d of parsed.decisions) {
        if (d.status !== 'superseded') {
          priorDecisions.push(d);
        }
      }
    }

    if (score >= 12) {
      relatedNotes.push({
        note: candidate,
        score,
        reasons,
        snippet: buildSnippetAroundTerms(candidate.body, matchedTerms),
      });
    }
  }

  relatedNotes.sort((a, b) => b.score - a.score || b.note.date.localeCompare(a.note.date));
  carryForwardTasks.sort((a, b) => {
    const prioRank = { high: 0, medium: 1, low: 2 };
    const pa = a.priority ? prioRank[a.priority] : 3;
    const pb = b.priority ? prioRank[b.priority] : 3;
    return pa - pb || (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
  });
  priorDecisions.sort((a, b) => b.noteDate.localeCompare(a.noteDate));

  return {
    relatedNotes: relatedNotes.slice(0, 8),
    carryForwardTasks: carryForwardTasks.slice(0, 12),
    priorDecisions: priorDecisions.slice(0, 10),
  };
}

/**
 * Local deterministic /ask answer synthesizer grounded strictly in matching notes, tasks, and decisions.
 */
export function localAskWorkspace(
  question: string,
  allNotes: Note[],
  directory: WorkspaceDirectory
): { answerMarkdown: string; citedNotes: Note[] } {
  const qTokens = tokenizeUnicode(question);
  const qLower = question.toLowerCase();

  const scored = allNotes
    .map((note) => {
      const fullText = `${note.title} ${note.participants.join(' ')} ${getAllNoteLabels(note).join(' ')} ${note.body}`.toLowerCase();
      let score = 0;
      for (const tok of qTokens) {
        if (fullText.includes(tok)) score += 10;
        if (note.title.toLowerCase().includes(tok)) score += 8;
      }
      for (const c of directory.clients) {
        if (qLower.includes(c.name.toLowerCase()) && note.clientId === c.id) score += 25;
      }
      for (const p of directory.people) {
        if (qLower.includes(p.name.toLowerCase().split(' ')[0]) && fullText.includes(p.name.toLowerCase())) {
          score += 18;
        }
      }
      return { note, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.note.date.localeCompare(a.note.date))
    .slice(0, 5);

  if (scored.length === 0) {
    return {
      answerMarkdown: `No matching notes found for **"${question}"**. Try mentioning a client, @person, #label, or topic keyword.`,
      citedNotes: [],
    };
  }

  const matchingDecisions: ParsedDecision[] = [];
  const matchingTasks: ParsedTask[] = [];
  const excerpts: string[] = [];

  for (const { note } of scored) {
    const items = parseNoteItems(note, directory.people);
    for (const d of items.decisions) {
      if (qTokens.length === 0 || qTokens.some((t) => d.text.toLowerCase().includes(t) || d.labels.includes(t)) || scored.length <= 2) {
        matchingDecisions.push(d);
      }
    }
    for (const t of items.tasks) {
      if (qTokens.length === 0 || qTokens.some((tok) => t.text.toLowerCase().includes(tok) || (t.owner || '').toLowerCase().includes(tok)) || scored.length <= 2) {
        matchingTasks.push(t);
      }
    }
    const snippet = buildSnippetAroundTerms(note.body, qTokens);
    excerpts.push(`- **[[${note.title}]]** (${note.date}): ${snippet}`);
  }

  const out: string[] = [`### Context Summary: ${question}`];

  if (matchingDecisions.length > 0) {
    out.push('\n**Relevant Decisions:**');
    for (const d of matchingDecisions.slice(0, 4)) {
      out.push(`- **[${d.status.toUpperCase()}]** ${d.text} — *from [[${d.noteTitle}]] (${d.noteDate})*`);
    }
  }

  if (matchingTasks.length > 0) {
    out.push('\n**Related Tasks:**');
    for (const t of matchingTasks.slice(0, 5)) {
      const ownerStr = t.owner ? ` (@${t.owner})` : '';
      const dueStr = t.dueDate ? ` · due ${t.dueDate}` : '';
      out.push(`- **[${t.status.toUpperCase()}]** ${t.text}${ownerStr}${dueStr} — *[[${t.noteTitle}]]*`);
    }
  }

  out.push('\n**Source Excerpts:**');
  out.push(...excerpts);

  return {
    answerMarkdown: out.join('\n'),
    citedNotes: scored.map((s) => s.note),
  };
}

/**
 * Generates a structured Executive Narrative Brief from filtered report items (works offline with zero API key).
 */
export function buildDeterministicExecutiveBrief(params: {
  heading: string;
  notes: Note[];
  tasks: ParsedTask[];
  decisions: ParsedDecision[];
}): string {
  const { heading, notes, tasks, decisions } = params;
  const openTasks = tasks.filter((t) => t.status !== 'done');
  const doneTasks = tasks.filter((t) => t.status === 'done');
  const agreed = decisions.filter((d) => d.status === 'agreed');
  const proposed = decisions.filter((d) => d.status === 'proposed');

  const lines: string[] = [
    `# ${heading}`,
    `Generated: ${new Date().toISOString().slice(0, 10)} · Coverage: ${notes.length} note(s), ${decisions.length} decision(s), ${tasks.length} task(s)`,
    '',
    '## Executive Highlights',
    `- **Decisions:** ${agreed.length} agreed, ${proposed.length} proposed across recent sessions.`,
    `- **Action Execution:** ${openTasks.length} open task(s) (${openTasks.filter((t) => t.priority === 'high').length} high priority) and ${doneTasks.length} completed.`,
  ];

  if (decisions.length > 0) {
    lines.push('', '## Key Decisions');
    for (const d of decisions.slice(0, 8)) {
      const rationaleStr = d.rationale ? ` — *Rationale: ${d.rationale}*` : '';
      lines.push(`- **[${d.status.toUpperCase()}]** ${d.text}${rationaleStr} (Source: [[${d.noteTitle}]], ${d.noteDate})`);
    }
  }

  if (openTasks.length > 0) {
    lines.push('', '## Open Action Items & Next Steps');
    for (const t of openTasks.slice(0, 10)) {
      const metaParts = [
        t.owner ? `Owner: @${t.owner}` : null,
        t.dueDate ? `Due: ${t.dueDate}` : null,
        t.priority ? `Priority: ${t.priority.toUpperCase()}` : null,
      ].filter(Boolean);
      lines.push(
        `- [${t.status.toUpperCase()}] ${t.text}${metaParts.length ? ` (${metaParts.join(' · ')})` : ''} — [[${t.noteTitle}]]`
      );
    }
  }

  if (notes.length > 0) {
    lines.push('', '## Source Notes Timeline');
    for (const n of notes.slice(0, 8)) {
      const peopleStr = n.participants.length > 0 ? ` · Participants: ${n.participants.join(', ')}` : '';
      lines.push(`- **${n.date} — [[${n.title}]]**${peopleStr}`);
    }
  }

  return lines.join('\n');
}
