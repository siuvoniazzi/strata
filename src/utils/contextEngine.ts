import type {
  Note,
  ParsedDecision,
  ParsedTask,
  RelatedNoteMatch,
  WorkspaceDirectory,
} from '../types';
import {
  extractInlineLabels,
  extractInlineMentions,
  extractWikiLinkTitles,
  getAllNoteLabels,
  isDailyBriefingNote,
  parseNoteItems,
  resolveKnownPersonName,
} from './markdown';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'are',
  'was', 'were', 'been', 'into', 'about', 'they', 'them', 'their', 'our', 'your',
  'note', 'notes', 'meeting', 'sync', 'call', 'today', 'need', 'needs', 'also',
  'can', 'should', 'would', 'could', 'what', 'when', 'where', 'which', 'while',
]);

export function tokenizeUnicode(text: string): string[] {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt: string) => alt.split('|')[0] || ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((tok) => tok.length >= 3 && !STOP_WORDS.has(tok));
}

function buildSnippetAroundTerms(body: string, queryTerms: string[]): string {
  const cleanLines = body
    .split('\n')
    .filter((l) => !/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(l))
    .map((l) =>
      l
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt: string) => {
          const cleanAlt = (alt || '').split('|')[0].trim();
          return cleanAlt ? `[Image: ${cleanAlt}]` : '[Image]';
        })
        .replace(/^\s*[-*+•]\s*\[(?:[ /?xX]|D(?::[a-z]+)?)\]\s*/i, '')
        .replace(/^\s*(?:[-*+•#>]+|\d+[.)])\s*/, '')
        .trim()
    )
    .filter((l) => l.length > 6);

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

function collectNotePeople(note: Note, knownPeople: WorkspaceDirectory['people']): string[] {
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

function collectNoteLabels(note: Note): string[] {
  return Array.from(new Set([...getAllNoteLabels(note), ...extractInlineLabels(note.title)]));
}

function stripPulledProvenanceCitations(body: string): string {
  return body
    .replace(/\(from\s+\[\[[^\]\n]+\]\]\)/gi, ' ')
    .replace(/^>\s*(?:Prior Decision|From\s+\[\[)[^\n]*$/gim, ' ');
}

/**
 * Computes live Context Radar items for the active note:
 * 1. Related notes requiring an explicit connection: shared #labels, shared people (participants/@mentions),
 *    or direct [[Note Title]] wiki-links — using lexical overlap strictly to rank already-matched notes
 * 2. Open carry-forward Tasks that themselves match the active note's #labels, people, or direct [[note link]]
 * 3. Prior Decisions that themselves match the active note's #labels, people, or direct [[note link]]
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
  const activeLabels = new Set(collectNoteLabels(activeNote));
  const activePeopleList = collectNotePeople(activeNote, directory.people);
  const activePeople = new Set(activePeopleList.map((p) => p.toLowerCase()));
  const activeTitleNorm = activeNote.title.trim().toLowerCase();
  const activeOutgoingLinks = new Set(
    extractWikiLinkTitles(`${activeNote.title}\n${activeNote.body}`)
  );
  const activeNonCitationLinks = new Set(
    extractWikiLinkTitles(
      `${activeNote.title}\n${stripPulledProvenanceCitations(activeNote.body)}`
    )
  );
  const activeTokens = Array.from(new Set(tokenizeUnicode(`${activeNote.title} ${activeNote.body}`)));

  const otherNotes = allNotes.filter((n) => n.id !== activeNote.id && !isDailyBriefingNote(n));

  // Document frequency for IDF tie-breaker ranking among explicitly matched notes
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

    const candTitleNorm = candidate.title.trim().toLowerCase();
    const candOutgoingLinks = new Set(
      extractWikiLinkTitles(`${candidate.title}\n${candidate.body}`)
    );
    const activeLinksToCandidate = Boolean(
      candTitleNorm && activeOutgoingLinks.has(candTitleNorm)
    );
    const activeExplicitlyLinksToCandidate = Boolean(
      candTitleNorm && activeNonCitationLinks.has(candTitleNorm)
    );
    const candidateLinksToActive = Boolean(
      activeTitleNorm && candOutgoingLinks.has(activeTitleNorm)
    );
    const hasDirectLink = activeLinksToCandidate || candidateLinksToActive;

    if (hasDirectLink) {
      score += activeLinksToCandidate && candidateLinksToActive ? 50 : 42;
      reasons.push(
        activeLinksToCandidate && candidateLinksToActive
          ? 'Linked ↔'
          : activeLinksToCandidate
            ? 'Linked in note'
            : 'Links here'
      );
    }

    const candPeople = collectNotePeople(candidate, directory.people);
    const sharedPeople = candPeople.filter((p) => activePeople.has(p.toLowerCase()));
    if (sharedPeople.length > 0) {
      score += Math.min(36, sharedPeople.length * 16);
      reasons.push(`People: ${sharedPeople.slice(0, 2).join(', ')}`);
    }

    const candLabels = collectNoteLabels(candidate);
    const sharedLabels = candLabels.filter((l) => activeLabels.has(l));
    if (sharedLabels.length > 0) {
      score += Math.min(36, sharedLabels.length * 16);
      reasons.push(`#${sharedLabels.slice(0, 2).join(', #')}`);
    }

    const hasExplicitMatch =
      hasDirectLink || sharedPeople.length > 0 || sharedLabels.length > 0;
    if (!hasExplicitMatch) {
      continue;
    }

    // Lexical TF-IDF overlap used strictly as a ranking boost among already-qualified notes
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
      score += Math.min(20, Math.round(lexicalScore));
    }

    const parsed = parseNoteItems(candidate, directory.people);
    const allCandPeopleInActive =
      candPeople.length > 0 && candPeople.every((p) => activePeople.has(p.toLowerCase()));

    for (const t of parsed.tasks) {
      if (t.status === 'done') continue;
      const taskPeople = extractInlineMentions(t.rawLine, directory.people).map((p) =>
        resolveKnownPersonName(p, directory.people).toLowerCase()
      );
      const matchesLabel = t.labels.some((lbl) => activeLabels.has(lbl));
      const matchesPeople =
        taskPeople.length > 0
          ? taskPeople.some((p) => activePeople.has(p))
          : allCandPeopleInActive;
      const matchesDirectLink =
        candidateLinksToActive ||
        (activeExplicitlyLinksToCandidate &&
          (taskPeople.length === 0 || activePeople.size === 0)) ||
        Boolean(activeTitleNorm && extractWikiLinkTitles(t.rawLine).includes(activeTitleNorm));

      if (matchesLabel || matchesPeople || matchesDirectLink) {
        carryForwardTasks.push(t);
      }
    }

    for (const d of parsed.decisions) {
      if (d.status === 'superseded') continue;
      const decisionRaw = d.rationale ? `${d.rawLine}\n${d.rationale}` : d.rawLine;
      const decisionLabels = d.rationale
        ? Array.from(new Set([...d.labels, ...extractInlineLabels(d.rationale)]))
        : d.labels;
      const decisionPeople = extractInlineMentions(decisionRaw, directory.people).map((p) =>
        resolveKnownPersonName(p, directory.people).toLowerCase()
      );
      const matchesLabel = decisionLabels.some((lbl) => activeLabels.has(lbl));
      const matchesPeople =
        decisionPeople.length > 0
          ? decisionPeople.some((p) => activePeople.has(p))
          : allCandPeopleInActive;
      const matchesDirectLink =
        candidateLinksToActive ||
        (activeExplicitlyLinksToCandidate &&
          (decisionPeople.length === 0 || activePeople.size === 0)) ||
        Boolean(activeTitleNorm && extractWikiLinkTitles(decisionRaw).includes(activeTitleNorm));

      if (matchesLabel || matchesPeople || matchesDirectLink) {
        priorDecisions.push(d);
      }
    }

    const snippetQueryTerms = [
      ...(candidateLinksToActive && activeTitleNorm ? [activeTitleNorm] : []),
      ...sharedLabels,
      ...sharedPeople.map((p) => p.toLowerCase()),
      ...matchedTerms,
    ];

    relatedNotes.push({
      note: candidate,
      score,
      reasons,
      snippet: buildSnippetAroundTerms(candidate.body, snippetQueryTerms),
    });
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
  const sourceNotes = allNotes.filter((n) => !isDailyBriefingNote(n));

  const scored = sourceNotes
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
