import type { Note, NoteScope, WorkspaceDirectory } from '../types';
import { getAllNoteLabels, normalizeLabel, slugify } from './markdown';

const SHARE_METADATA_PREF_KEY = 'strata.shareIncludeMetadata';

// Safe cross-platform URL thresholds so OS/browser protocol handlers never silently drop links
const MAX_MAILTO_URL_LENGTH = 1950;
const MAX_WHATSAPP_URL_LENGTH = 4000;

export interface ShareSerializeOptions {
  includeMetadata?: boolean;
}

export interface ParsedSharedNote {
  kind: 'frontmatter' | 'readable-header' | 'markdown-heading';
  title?: string;
  date?: string;
  scope?: NoteScope;
  clientName?: string;
  projectName?: string;
  participants: string[];
  labels: string[];
  body: string;
}

export function loadShareIncludeMetadataPreference(): boolean {
  try {
    const saved = localStorage.getItem(SHARE_METADATA_PREF_KEY);
    if (saved === 'false') return false;
    if (saved === 'true') return true;
  } catch {
    // Ignore storage access errors in restricted sandboxes
  }
  return true;
}

export function saveShareIncludeMetadataPreference(includeMetadata: boolean): void {
  try {
    localStorage.setItem(SHARE_METADATA_PREF_KEY, includeMetadata ? 'true' : 'false');
  } catch {
    // Ignore storage access errors in restricted sandboxes
  }
}

function escapeYamlScalar(val: string): string {
  return JSON.stringify(val);
}

function unquoteYamlScalar(raw: string): string {
  const normalizedQuotes = raw
    .trim()
    .replace(/^[\u201C\u201D]/, '"')
    .replace(/[\u201C\u201D]$/, '"')
    .replace(/^[\u2018\u2019]/, "'")
    .replace(/[\u2018\u2019]$/, "'");

  if (
    (normalizedQuotes.startsWith('"') && normalizedQuotes.endsWith('"')) ||
    (normalizedQuotes.startsWith("'") && normalizedQuotes.endsWith("'"))
  ) {
    if (normalizedQuotes.startsWith('"')) {
      try {
        return JSON.parse(normalizedQuotes) as string;
      } catch {
        // Fall through to slice
      }
    }
    return normalizedQuotes.slice(1, -1);
  }
  return normalizedQuotes;
}

/**
 * Serializes a Note into portable Markdown suitable for sharing via Email, WhatsApp, or Clipboard
 * and copying cleanly into another Strata client/account.
 */
export function serializeNoteForShare(
  note: Note,
  directory: WorkspaceDirectory,
  options?: ShareSerializeOptions
): string {
  const includeMetadata = options?.includeMetadata ?? true;
  const title = note.title.trim() || 'Untitled Note';
  const clientName = note.clientId
    ? directory.clients.find((c) => c.id === note.clientId)?.name || ''
    : '';
  const projectName = note.projectId
    ? directory.projects.find((p) => p.id === note.projectId)?.name || ''
    : '';
  const allLabels = getAllNoteLabels(note);
  const cleanBody = note.body.replace(/\r\n?/g, '\n').trimEnd();

  if (includeMetadata) {
    const lines: string[] = [
      '---',
      `title: ${escapeYamlScalar(title)}`,
      `date: ${note.date}`,
      `scope: ${note.scope}`,
    ];

    if (clientName) {
      lines.push(`client: ${escapeYamlScalar(clientName)}`);
    }
    if (projectName) {
      lines.push(`project: ${escapeYamlScalar(projectName)}`);
    }
    if (note.participants.length > 0) {
      lines.push('participants:');
      for (const personName of note.participants) {
        lines.push(`  - ${escapeYamlScalar(personName)}`);
      }
    }
    if (allLabels.length > 0) {
      lines.push('labels:');
      for (const lbl of allLabels) {
        lines.push(`  - ${lbl}`);
      }
    }

    lines.push('---');
    return cleanBody ? `${lines.join('\n')}\n\n${cleanBody}` : lines.join('\n');
  }

  // Human-readable Markdown header mode (still round-trip parseable by Strata!)
  const headerLines: string[] = [`# ${title}`];
  let spaceSummary = 'Inbox';
  if (note.scope === 'client' && clientName) {
    spaceSummary = projectName
      ? `Client: ${clientName} / ${projectName}`
      : `Client: ${clientName}`;
  } else if (note.scope === 'internal') {
    spaceSummary = projectName ? `Internal / ${projectName}` : 'Internal';
  }
  headerLines.push(`Date: ${note.date} · Space: ${spaceSummary}`);

  if (note.participants.length > 0) {
    headerLines.push(`Participants: ${note.participants.map((p) => `@${p}`).join(', ')}`);
  }
  if (allLabels.length > 0) {
    headerLines.push(`Labels: ${allLabels.map((l) => `#${l}`).join(' ')}`);
  }

  if (!cleanBody) {
    return headerLines.join('\n');
  }

  return `${headerLines.join('\n')}\n\n---\n\n${cleanBody}`;
}

/**
 * Copies text to the clipboard with a fallback for restricted iframe/non-HTTPS contexts.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback
    }
  }

  if (typeof document === 'undefined') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function truncateForEncodedBudget(
  fullText: string,
  maxEncodedChars: number,
  suffixNotice: string,
  lineEnding: '\n' | '\r\n'
): { text: string; truncated: boolean } {
  const normalized = fullText.replace(/\r?\n/g, lineEnding);
  if (encodeURIComponent(normalized).length <= maxEncodedChars) {
    return { text: normalized, truncated: false };
  }

  const normalizedSuffix = suffixNotice.replace(/\r?\n/g, lineEnding);
  const suffixBudget = encodeURIComponent(normalizedSuffix).length;
  const availableBudget = Math.max(120, maxEncodedChars - suffixBudget);

  // Binary search the longest prefix whose URI-encoded form fits within availableBudget
  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encodeURIComponent(normalized.slice(0, mid)).length <= availableBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  let sliced = normalized.slice(0, low);
  const lastNewline = sliced.lastIndexOf('\n');
  if (lastNewline > sliced.length * 0.65) {
    sliced = sliced.slice(0, lastNewline).trimEnd();
  } else {
    const lastSpace = sliced.lastIndexOf(' ');
    if (lastSpace > sliced.length * 0.75) {
      sliced = sliced.slice(0, lastSpace).trimEnd();
    }
  }

  return {
    text: `${sliced}${normalizedSuffix}`,
    truncated: true,
  };
}

/**
 * Opens the user's default email client with the note formatted as Markdown
 * and copies the full Markdown to clipboard so nothing is ever lost on long notes.
 */
export async function shareNoteViaEmail(
  note: Note,
  directory: WorkspaceDirectory,
  options?: ShareSerializeOptions
): Promise<{ copiedBackup: boolean; truncated: boolean }> {
  const markdown = serializeNoteForShare(note, directory, options);
  const copiedBackup = await copyTextToClipboard(markdown);

  const title = note.title.trim() || 'Untitled Note';
  const subject = note.date ? `${title} (${note.date})` : title;
  const prefix = `mailto:?subject=${encodeURIComponent(subject)}&body=`;
  const bodyBudget = Math.max(300, MAX_MAILTO_URL_LENGTH - prefix.length);

  const { text: bodyForMail, truncated } = truncateForEncodedBudget(
    markdown,
    bodyBudget,
    '\r\n\r\n[… Note truncated due to email link size limit — the complete Markdown has been copied to your clipboard, press Ctrl+V / Cmd+V to paste]',
    '\r\n'
  );

  const mailtoUrl = `${prefix}${encodeURIComponent(bodyForMail)}`;

  if (typeof document !== 'undefined') {
    const link = document.createElement('a');
    link.href = mailtoUrl;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  return { copiedBackup, truncated };
}

/**
 * Opens WhatsApp (Mobile app or WhatsApp Web/Desktop) with the note pre-filled as Markdown
 * and copies the full Markdown to clipboard as backup.
 */
export async function shareNoteViaWhatsApp(
  note: Note,
  directory: WorkspaceDirectory,
  options?: ShareSerializeOptions
): Promise<{ copiedBackup: boolean; truncated: boolean }> {
  const markdown = serializeNoteForShare(note, directory, options);
  const copiedBackup = await copyTextToClipboard(markdown);

  const prefix = 'https://wa.me/?text=';
  const textBudget = Math.max(500, MAX_WHATSAPP_URL_LENGTH - prefix.length);

  const { text: waText, truncated } = truncateForEncodedBudget(
    markdown,
    textBudget,
    '\n\n[… Note truncated due to link size limit — full Markdown is copied to your clipboard, paste to send complete note]',
    '\n'
  );

  const waUrl = `${prefix}${encodeURIComponent(waText)}`;
  if (typeof window !== 'undefined') {
    window.open(waUrl, '_blank', 'noopener,noreferrer');
  }

  return { copiedBackup, truncated };
}

/**
 * Downloads the note as a standalone `.md` file that can be imported into another Strata workspace.
 */
export function downloadNoteMarkdownFile(
  note: Note,
  directory: WorkspaceDirectory,
  options?: ShareSerializeOptions
): string {
  const markdown = serializeNoteForShare(note, directory, options);
  const filename = `${note.date || 'undated'}-${slugify(note.title || 'untitled')}.md`;

  if (typeof document !== 'undefined') {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return filename;
}

export function canUseNativeShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export async function shareNoteViaSystemSheet(
  note: Note,
  directory: WorkspaceDirectory,
  options?: ShareSerializeOptions
): Promise<boolean> {
  if (!canUseNativeShare()) return false;
  const markdown = serializeNoteForShare(note, directory, options);
  const title = note.title.trim() || 'Untitled Note';
  try {
    await navigator.share({
      title,
      text: markdown,
    });
    return true;
  } catch {
    return false;
  }
}

function unwrapOptionalMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:markdown|md|yaml)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  return fenceMatch ? fenceMatch[1] : raw;
}

const KNOWN_FRONTMATTER_KEYS = new Set([
  'id',
  'title',
  'date',
  'scope',
  'client',
  'project',
  'participants',
  'labels',
  'createdat',
  'updatedat',
]);

/**
 * Parses a shared Strata Markdown note (either YAML frontmatter or readable header format)
 * so pasting into another Strata client/account restores title, space, client, project, people, labels & body.
 */
export function parseSharedMarkdownNote(
  rawText: string,
  options?: { allowHeadingFallback?: boolean }
): ParsedSharedNote | null {
  if (!rawText || !rawText.trim()) return null;

  const unwrapped = unwrapOptionalMarkdownFence(rawText).replace(/^\uFEFF/, '');
  const trimmedStart = unwrapped.replace(/^(?:[ \t]*\r?\n)+/, '');

  // 1. Check YAML Frontmatter: --- ... ---
  const fmMatch = trimmedStart.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (fmMatch) {
    const fmBlock = fmMatch[1];
    const meta: Record<string, string | string[]> = {};
    let activeListKey: string | null = null;
    let recognizedKeyCount = 0;

    for (const rawLine of fmBlock.split(/\r?\n/)) {
      const listMatch = rawLine.match(/^\s*-\s+(.+)$/);
      if (listMatch && activeListKey) {
        const arr = (meta[activeListKey] as string[]) || [];
        arr.push(unquoteYamlScalar(listMatch[1]));
        meta[activeListKey] = arr;
        continue;
      }
      const kvMatch = rawLine.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].toLowerCase();
        if (KNOWN_FRONTMATTER_KEYS.has(key)) {
          recognizedKeyCount++;
        }
        const val = kvMatch[2].trim();
        if (val === '') {
          activeListKey = key;
          meta[key] = [];
        } else if (val === '[]') {
          activeListKey = null;
          meta[key] = [];
        } else {
          activeListKey = null;
          meta[key] = unquoteYamlScalar(val);
        }
      }
    }

    if (recognizedKeyCount > 0) {
      const afterFm = trimmedStart.slice(fmMatch[0].length).replace(/^\r?\n/, '');
      const rawScope = typeof meta.scope === 'string' ? meta.scope.toLowerCase() : '';
      let scope: NoteScope | undefined;
      if (rawScope === 'client' || rawScope === 'internal' || rawScope === 'inbox') {
        scope = rawScope;
      }

      const clientName =
        typeof meta.client === 'string' && meta.client.trim() ? meta.client.trim() : undefined;
      const projectName =
        typeof meta.project === 'string' && meta.project.trim() ? meta.project.trim() : undefined;
      if (clientName && !scope) {
        scope = 'client';
      }

      const participants = Array.isArray(meta.participants)
        ? meta.participants.map((p) => p.trim().replace(/^@+/, '')).filter(Boolean)
        : [];
      const labels = Array.isArray(meta.labels)
        ? meta.labels.map(normalizeLabel).filter(Boolean)
        : [];

      const rawDate = typeof meta.date === 'string' ? meta.date.trim() : '';
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined;
      const rawTitle = typeof meta.title === 'string' ? meta.title.trim() : undefined;

      return {
        kind: 'frontmatter',
        title: rawTitle,
        date: validDate,
        scope,
        clientName,
        projectName,
        participants,
        labels,
        body: afterFm.replace(/\r\n?/g, '\n').trimEnd(),
      };
    }
  }

  // 2. Check Readable Share Header:
  // # Title
  // Date: YYYY-MM-DD · Space: ...
  const lines = trimmedStart.replace(/\r\n?/g, '\n').split('\n');
  const h1Match = lines[0]?.match(/^#\s+(.+)$/);
  const dateSpaceMatch = lines[1]?.match(/^Date:\s*(\d{4}-\d{2}-\d{2})(?:\s*·\s*Space:\s*(.+))?$/i);
  if (h1Match && dateSpaceMatch) {
    const title = h1Match[1].trim();
    const date = dateSpaceMatch[1];
    const spaceRaw = (dateSpaceMatch[2] || '').trim();

    let scope: NoteScope = 'inbox';
    let clientName: string | undefined;
    let projectName: string | undefined;

    if (/^client:\s*/i.test(spaceRaw)) {
      scope = 'client';
      const rest = spaceRaw.replace(/^client:\s*/i, '').trim();
      const slashIdx = rest.indexOf(' / ');
      if (slashIdx !== -1) {
        clientName = rest.slice(0, slashIdx).trim() || undefined;
        projectName = rest.slice(slashIdx + 3).trim() || undefined;
      } else {
        clientName = rest || undefined;
      }
    } else if (/^internal/i.test(spaceRaw)) {
      scope = 'internal';
      const slashIdx = spaceRaw.indexOf(' / ');
      if (slashIdx !== -1) {
        projectName = spaceRaw.slice(slashIdx + 3).trim() || undefined;
      }
    }

    const participants: string[] = [];
    const labels: string[] = [];
    let cursor = 2;

    while (cursor < lines.length && lines[cursor].trim() !== '') {
      const partMatch = lines[cursor].match(/^Participants:\s*(.+)$/i);
      if (partMatch) {
        for (const token of partMatch[1].split(',')) {
          const cleaned = token
            .trim()
            .replace(/^@\[([^\]]+)\]$/, '$1')
            .replace(/^@+/, '')
            .trim();
          if (cleaned) participants.push(cleaned);
        }
        cursor++;
        continue;
      }
      const lblMatch = lines[cursor].match(/^Labels:\s*(.+)$/i);
      if (lblMatch) {
        for (const token of lblMatch[1].split(/[\s,]+/)) {
          const norm = normalizeLabel(token);
          if (norm) labels.push(norm);
        }
        cursor++;
        continue;
      }
      break;
    }

    while (cursor < lines.length && lines[cursor].trim() === '') cursor++;
    if (cursor < lines.length && /^---+\s*$/.test(lines[cursor])) {
      cursor++;
      while (cursor < lines.length && lines[cursor].trim() === '') cursor++;
    }

    return {
      kind: 'readable-header',
      title,
      date,
      scope,
      clientName,
      projectName,
      participants,
      labels,
      body: lines.slice(cursor).join('\n').trimEnd(),
    };
  }

  // 3. Optional fallback when pasting multi-line `# Heading\n...` into a blank note's title or import modal
  if (options?.allowHeadingFallback && h1Match && lines.length >= 2) {
    let cursor = 1;
    while (cursor < lines.length && lines[cursor].trim() === '') cursor++;
    return {
      kind: 'markdown-heading',
      title: h1Match[1].trim(),
      participants: [],
      labels: [],
      body: lines.slice(cursor).join('\n').trimEnd(),
    };
  }

  return null;
}
