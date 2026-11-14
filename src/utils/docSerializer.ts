import type { Person, TaskStatus } from '../types';
import { registerDataUrlAssetSync, resolveImageSrc } from './imageStore';
import {
  formatPersonMention,
  matchDecisionLine,
  matchRationaleLine,
  matchTaskLine,
  normalizeDecisionStatus,
  resolveKnownPersonName,
} from './markdown';

const TASK_TO_STATUS_CHAR: Record<string, string> = {
  todo: ' ',
  doing: '/',
  waiting: '?',
  done: 'x',
};

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escAttr(str: string): string {
  return escHtml(str).replace(/"/g, '&quot;');
}

export function normalizeImageWidth(raw?: string | null): string {
  if (!raw) return '';
  const trimmed = raw.trim().toLowerCase();
  const pctMatch = trimmed.match(/^(\d{1,3})%$/);
  if (pctMatch) {
    const val = Math.max(10, Math.min(100, Number(pctMatch[1])));
    return `${val}%`;
  }
  const pxMatch = trimmed.match(/^(\d{2,4})(?:px)?$/);
  if (pxMatch) {
    const val = Math.max(80, Math.min(2400, Number(pxMatch[1])));
    return String(val);
  }
  return '';
}

export function parseAltAndWidth(rawAlt: string): { alt: string; width: string } {
  const pipeMatch = rawAlt.match(/^(.*?)\|(\d{1,4}(?:px|%)?)$/i);
  if (pipeMatch) {
    return {
      alt: pipeMatch[1].trim(),
      width: normalizeImageWidth(pipeMatch[2]),
    };
  }
  return { alt: rawAlt.trim(), width: '' };
}

function attachmentExtBadge(name: string): string {
  const ext = (name.split('.').pop() || '').toUpperCase();
  if (ext === 'PDF') return 'PDF';
  if (ext && ext.length <= 4) return ext;
  return 'FILE';
}

export function buildAttachmentChipHtml(name: string, src: string): string {
  const cleanName = (name || src.split('/').pop() || 'attachment').replace(/[[\]]/g, '').trim();
  const cleanSrc = src.trim();
  const badge = attachmentExtBadge(cleanName);
  return (
    `<span class="doc-token doc-attachment" contenteditable="false" data-attachment-src="${escAttr(cleanSrc)}" data-attachment-name="${escAttr(cleanName)}" title="Open ${escAttr(cleanName)}">` +
    `<span class="doc-attachment-badge">${escHtml(badge)}</span>` +
    `<span class="doc-attachment-name">${escHtml(cleanName)}</span>` +
    `</span>`
  );
}

export function createAttachmentChipElement(name: string, src: string): HTMLElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = buildAttachmentChipHtml(name, src);
  return tpl.content.firstElementChild as HTMLElement;
}

export function buildImageBlockHtml(params: {
  src: string;
  alt?: string;
  width?: string | null;
  noteId?: string;
}): string {
  const cleanSrc = params.src.startsWith('data:image/')
    ? registerDataUrlAssetSync(params.src, undefined, params.noteId)
    : params.src.trim();
  const resolvedSrc = resolveImageSrc(cleanSrc, params.noteId);
  const alt = (params.alt ?? 'Pasted image').replace(/[[\]|]/g, '').trim();
  const width = normalizeImageWidth(params.width);
  const cssWidth = width ? (width.endsWith('%') ? width : `${width}px`) : '';
  const badgeLabel = width ? (width.endsWith('%') ? width : `${width}px`) : 'Auto';
  const presets = ['25%', '50%', '75%', '100%'];

  const presetBtns = presets
    .map(
      (p) =>
        `<button type="button" class="doc-image-preset${width === p ? ' active' : ''}" data-img-action="preset" data-preset="${p}" title="Resize to ${p} width">${p}</button>`
    )
    .join('');

  return (
    `<figure class="doc-image-block" contenteditable="false" data-src="${escAttr(cleanSrc)}" data-alt="${escAttr(alt)}"` +
    `${width ? ` data-width="${escAttr(width)}"` : ''}` +
    `${cssWidth ? ` style="width: ${escAttr(cssWidth)};"` : ''}>` +
    `<div class="doc-image-frame">` +
    `<img src="${escAttr(resolvedSrc)}" alt="${escAttr(alt || 'Pasted image')}" draggable="false" />` +
    `<span class="doc-image-handle doc-image-handle-w" data-resize-dir="w" title="Drag edge to resize"></span>` +
    `<span class="doc-image-handle doc-image-handle-e" data-resize-dir="e" title="Drag edge to resize"></span>` +
    `<span class="doc-image-handle doc-image-handle-se" data-resize-dir="se" title="Drag corner to resize"></span>` +
    `<div class="doc-image-toolbar no-print">` +
    presetBtns +
    `<span class="doc-image-toolbar-sep"></span>` +
    `<button type="button" class="doc-image-preset" data-img-action="zoom" title="Open large view (Click image)">⤢</button>` +
    `<button type="button" class="doc-image-preset danger" data-img-action="delete" title="Remove image">✕</button>` +
    `</div>` +
    `<span class="doc-image-size-pill no-print">${escHtml(badgeLabel)}</span>` +
    `</div>` +
    `</figure>`
  );
}

export function createImageBlockElement(params: {
  src: string;
  alt?: string;
  width?: string | null;
  noteId?: string;
}): HTMLElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = buildImageBlockHtml(params);
  return tpl.content.firstElementChild as HTMLElement;
}

/**
 * Converts inline Markdown (bold, italic, strike, code, @[Person], #label, [[Note]], [file](assets/...), due:, !prio)
 * into clean semantic HTML spans for the continuous Word-like document surface.
 */
export function inlineMarkdownToHtml(
  text: string,
  knownPeople: Person[] = [],
  noteId?: string
): string {
  if (!text) return '';

  // Build dynamic alternation for unbracketed multi-word known people (@Jane Doe)
  const sortedPeople = [...knownPeople]
    .filter((p) => p.name.trim().includes(' '))
    .sort((a, b) => b.name.length - a.name.length);

  const multiWordPersonAlternation = sortedPeople
    .map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  const patternParts = [
    '`([^`]+)`', // inline code
    '!\\[([^\\]]*)\\]\\(([^)\\n]+)\\)', // inline image ![alt|width](src)
    '\\[([^\\]]+)\\]\\(((?:\\./|\\.\\./)*assets/[^)\\n]+)\\)', // local attachment [name](assets/...)
    '\\[\\[([^\\]]+)\\]\\]', // [[Note Link]]
    '@\\[([^\\]]+)\\]', // @[Full Name]
    ...(multiWordPersonAlternation
      ? [`(?<=^|[\\s(])@(${multiWordPersonAlternation})(?=$|[\\s,.;:!?)])`] // @Known Multiword
      : []),
    '(?<=^|[\\s(])@([\\p{L}][\\p{L}\\p{N}._-]{0,30})', // @SingleWord
    '(?<=^|[\\s(])#([\\p{L}][\\p{L}\\p{N}_-]{1,38})', // #label
    '\\bdue:(\\d{4}-\\d{2}-\\d{2})\\b', // due:YYYY-MM-DD
    '(?<=^|\\s)!(high|medium|med|low)\\b', // !priority
    '\\*\\*\\*(.+?)\\*\\*\\*', // ***bold italic***
    '\\*\\*(.+?)\\*\\*', // **bold**
    '(?<!\\*)\\*(?!\\s)(.+?)(?<!\\s)\\*(?!\\*)', // *italic*
    '~~(.+?)~~', // ~~strikethrough~~
  ];

  const masterRegex = new RegExp(patternParts.join('|'), 'giu');
  const out: string[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = masterRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      out.push(escHtml(text.slice(lastIdx, match.index)));
    }

    const raw = match[0];

    if (raw.startsWith('`') && raw.endsWith('`')) {
      out.push(`<code>${escHtml(raw.slice(1, -1))}</code>`);
    } else if (raw.startsWith('![') && raw.endsWith(')')) {
      const imgMatch = raw.match(/^!\[([^\]]*)\]\(([^)\n]+)\)$/);
      if (imgMatch) {
        const { alt, width } = parseAltAndWidth(imgMatch[1]);
        const cleanSrc = imgMatch[2].trim().startsWith('data:image/')
          ? registerDataUrlAssetSync(imgMatch[2].trim(), undefined, noteId)
          : imgMatch[2].trim();
        const resolved = resolveImageSrc(cleanSrc, noteId);
        const cssWidth = width ? (width.endsWith('%') ? width : `${width}px`) : '';
        out.push(
          `<img class="doc-inline-image" src="${escAttr(resolved)}" data-src="${escAttr(cleanSrc)}" alt="${escAttr(alt || 'Image')}"` +
            `${width ? ` data-width="${escAttr(width)}"` : ''}` +
            `${cssWidth ? ` style="width: ${escAttr(cssWidth)};"` : ''} />`
        );
      } else {
        out.push(escHtml(raw));
      }
    } else if (raw.startsWith('[') && !raw.startsWith('[[') && raw.endsWith(')')) {
      const attMatch = raw.match(/^\[([^\]]+)\]\(([^)\n]+)\)$/);
      if (attMatch) {
        out.push(buildAttachmentChipHtml(attMatch[1], attMatch[2]));
      } else {
        out.push(escHtml(raw));
      }
    } else if (raw.startsWith('[[') && raw.endsWith(']]')) {
      const title = raw.slice(2, -2).trim();
      out.push(
        `<span class="doc-token doc-link" data-link="${escAttr(title)}">${escHtml(title)}</span>`
      );
    } else if (raw.startsWith('@[')) {
      const rawName = raw.slice(2, -1).trim();
      const resolved = resolveKnownPersonName(rawName, knownPeople);
      out.push(
        `<span class="doc-token doc-person" data-person="${escAttr(resolved)}" data-mention-text="${escAttr(resolved)}">@${escHtml(resolved)}</span>`
      );
    } else if (raw.startsWith('@')) {
      const rawName = raw.slice(1).trim();
      const exact = knownPeople.find((p) => p.name.toLowerCase() === rawName.toLowerCase());
      const display = exact ? exact.name : rawName;
      const resolved = resolveKnownPersonName(rawName, knownPeople);
      out.push(
        `<span class="doc-token doc-person" data-person="${escAttr(resolved)}" data-mention-text="${escAttr(display)}">@${escHtml(display)}</span>`
      );
    } else if (raw.startsWith('#')) {
      const lbl = raw.slice(1).toLowerCase();
      out.push(
        `<span class="doc-token doc-label" data-label="${escAttr(lbl)}">#${escHtml(lbl)}</span>`
      );
    } else if (/^due:\d{4}-\d{2}-\d{2}$/i.test(raw)) {
      out.push(`<span class="doc-token doc-due">${escHtml(raw)}</span>`);
    } else if (/^!(?:high|medium|med|low)$/i.test(raw)) {
      const norm = raw.slice(1).toLowerCase() === 'med' ? 'medium' : raw.slice(1).toLowerCase();
      out.push(`<span class="doc-token doc-prio doc-prio-${norm}">${escHtml(raw)}</span>`);
    } else if (raw.startsWith('***') && raw.endsWith('***')) {
      out.push(`<strong><em>${inlineMarkdownToHtml(raw.slice(3, -3), knownPeople)}</em></strong>`);
    } else if (raw.startsWith('**') && raw.endsWith('**')) {
      out.push(`<strong>${inlineMarkdownToHtml(raw.slice(2, -2), knownPeople)}</strong>`);
    } else if (raw.startsWith('~~') && raw.endsWith('~~')) {
      out.push(`<s>${inlineMarkdownToHtml(raw.slice(2, -2), knownPeople)}</s>`);
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      out.push(`<em>${inlineMarkdownToHtml(raw.slice(1, -1), knownPeople)}</em>`);
    } else {
      out.push(escHtml(raw));
    }

    lastIdx = match.index + raw.length;
  }

  if (lastIdx < text.length) {
    out.push(escHtml(text.slice(lastIdx)));
  }

  return out.join('');
}

const MAX_LIST_INDENT = 6;

function getIndentLevelFromWhitespace(rawIndent?: string | null): number {
  if (!rawIndent) return 0;
  const spaces = rawIndent.replace(/\t/g, '  ').length;
  return Math.min(MAX_LIST_INDENT, Math.ceil(spaces / 2));
}

function renderBlockInlineHtml(text: string, knownPeople: Person[], noteId?: string): string {
  const html = inlineMarkdownToHtml(text, knownPeople, noteId);
  if (!html) return '';
  return html.endsWith(' ') ? `${html.slice(0, -1)}&nbsp;` : html;
}

/**
 * Hydrates a Markdown note body into clean semantic block HTML for the continuous Word-like page.
 */
export function markdownToHtml(
  markdown: string,
  knownPeople: Person[] = [],
  noteId?: string
): string {
  if (!markdown) {
    return '<p><br></p>';
  }

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const htmlBlocks: string[] = [];
  let i = 0;

  const isHorizontalRule = (line: string) =>
    /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line);

  const isBulletLine = (line: string) =>
    !isHorizontalRule(line) &&
    /^[ \t]*[-*+•](?:\s+(.*)|\s*)$/.test(line) &&
    !matchDecisionLine(line) &&
    !matchTaskLine(line);

  const isOrderedLine = (line: string) =>
    /^[ \t]*\d+[.)](?:\s+(.*)|\s*)$/.test(line) &&
    !matchDecisionLine(line) &&
    !matchTaskLine(line);

  while (i < lines.length) {
    const line = lines[i];

    // 0. Standalone Resizable Image Block: ![alt|width](src)
    const imgBlockMatch = line.match(/^\s*!\[([^\]]*)\]\(([^)\n]+)\)\s*$/);
    if (imgBlockMatch) {
      const { alt, width } = parseAltAndWidth(imgBlockMatch[1]);
      htmlBlocks.push(
        buildImageBlockHtml({
          src: imgBlockMatch[2].trim(),
          alt,
          width,
          noteId,
        })
      );
      i++;
      continue;
    }

    // 1. Decision block (+ optional indented Rationale sub-line)
    const decMatch = matchDecisionLine(line);
    if (decMatch) {
      const status = decMatch.status;
      const indent = getIndentLevelFromWhitespace(decMatch.indent);
      const indentAttr = indent > 0 ? ` data-indent="${indent}"` : '';
      const inner = renderBlockInlineHtml(decMatch.text || '', knownPeople, noteId);
      htmlBlocks.push(
        `<p class="doc-decision" data-status="${status}"${indentAttr}>${inner || '<br>'}</p>`
      );

      if (i + 1 < lines.length) {
        const ratText = matchRationaleLine(lines[i + 1]);
        if (ratText !== null) {
          const ratInner = renderBlockInlineHtml(ratText, knownPeople, noteId);
          htmlBlocks.push(`<blockquote class="doc-rationale">${ratInner || '<br>'}</blockquote>`);
          i += 2;
          continue;
        }
      }
      i++;
      continue;
    }

    // 2. Task block (- [ ] / - [/] / - [?] / - [x], including double-bulleted variants)
    const taskMatch = matchTaskLine(line);
    if (taskMatch) {
      const status = taskMatch.status;
      const indent = getIndentLevelFromWhitespace(taskMatch.indent);
      const indentAttr = indent > 0 ? ` data-indent="${indent}"` : '';
      const inner = renderBlockInlineHtml(taskMatch.text || '', knownPeople, noteId);
      htmlBlocks.push(
        `<p class="doc-task" data-status="${status}"${indentAttr}>${inner || '<br>'}</p>`
      );
      i++;
      continue;
    }

    // 3. Consecutive Unordered Bullet List
    if (isBulletLine(line)) {
      const items: string[] = [];
      while (i < lines.length && isBulletLine(lines[i])) {
        const m = lines[i].match(/^([ \t]*)[-*+•](?:\s+(.*)|\s*)$/);
        const indent = m ? getIndentLevelFromWhitespace(m[1]) : 0;
        const indentAttr = indent > 0 ? ` data-indent="${indent}"` : '';
        const itemHtml = renderBlockInlineHtml(m && m[2] ? m[2] : '', knownPeople, noteId);
        items.push(`<li${indentAttr}>${itemHtml || '<br>'}</li>`);
        i++;
      }
      htmlBlocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // 4. Consecutive Numbered List
    if (isOrderedLine(line)) {
      const items: string[] = [];
      while (i < lines.length && isOrderedLine(lines[i])) {
        const m = lines[i].match(/^([ \t]*)\d+[.)](?:\s+(.*)|\s*)$/);
        const indent = m ? getIndentLevelFromWhitespace(m[1]) : 0;
        const indentAttr = indent > 0 ? ` data-indent="${indent}"` : '';
        const itemHtml = renderBlockInlineHtml(m && m[2] ? m[2] : '', knownPeople, noteId);
        items.push(`<li${indentAttr}>${itemHtml || '<br>'}</li>`);
        i++;
      }
      htmlBlocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // 5. Headings
    const h3Match = line.match(/^\s*#{3,6}\s+(.*)$/);
    if (h3Match) {
      const inner = renderBlockInlineHtml(h3Match[1], knownPeople, noteId);
      htmlBlocks.push(`<h3>${inner || '<br>'}</h3>`);
      i++;
      continue;
    }

    const h2Match = line.match(/^\s*##\s+(.*)$/);
    if (h2Match) {
      const inner = renderBlockInlineHtml(h2Match[1], knownPeople, noteId);
      htmlBlocks.push(`<h2>${inner || '<br>'}</h2>`);
      i++;
      continue;
    }

    const h1Match = line.match(/^\s*#\s+(.*)$/);
    if (h1Match) {
      const inner = renderBlockInlineHtml(h1Match[1], knownPeople, noteId);
      htmlBlocks.push(`<h1>${inner || '<br>'}</h1>`);
      i++;
      continue;
    }

    // 6. Horizontal Rule
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      htmlBlocks.push('<hr>');
      i++;
      continue;
    }

    // 7. Blockquote
    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      const inner = renderBlockInlineHtml(quoteMatch[1], knownPeople, noteId);
      htmlBlocks.push(`<blockquote>${inner || '<br>'}</blockquote>`);
      i++;
      continue;
    }

    // 8. Blank line or normal paragraph
    if (!line.trim()) {
      htmlBlocks.push('<p><br></p>');
    } else {
      htmlBlocks.push(`<p>${renderBlockInlineHtml(line, knownPeople, noteId)}</p>`);
    }
    i++;
  }

  return htmlBlocks.length > 0 ? htmlBlocks.join('') : '<p><br></p>';
}

function wrapMarkdownMark(rawInner: string, marker: string): string {
  if (!rawInner) return '';
  const lead = rawInner.match(/^\s*/)?.[0] || '';
  const trail = rawInner.match(/\s*$/)?.[0] || '';
  const core = rawInner.slice(lead.length, rawInner.length - trail.length);
  if (!core) return rawInner;
  return `${lead}${marker}${core}${marker}${trail}`;
}

function serializeInlineNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.nodeValue || '').replace(/\u00A0/g, ' ');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const el = node as HTMLElement;
  const tag = el.tagName.toUpperCase();

  if (tag === 'BR') {
    // Ignore trailing placeholder <br> inside blocks; preserve mid-paragraph Shift+Enter <br>
    return el.nextSibling ? '\n' : '';
  }

  if (tag === 'IMG') {
    const rawSrc = el.getAttribute('data-src') || el.getAttribute('src') || '';
    if (!rawSrc) return '';
    const src = rawSrc.startsWith('data:image/') ? registerDataUrlAssetSync(rawSrc) : rawSrc;
    const alt = (el.getAttribute('alt') || 'Image').replace(/[[\]|]/g, '').trim();
    const width = normalizeImageWidth(el.getAttribute('data-width') || el.getAttribute('width') || '');
    return `![${alt}${width ? `|${width}` : ''}](${src})`;
  }

  if (tag === 'SPAN') {
    if (el.classList.contains('doc-person')) {
      const rawTxt = (el.textContent || '').replace(/\u00A0/g, ' ');
      const lead = rawTxt.match(/^\s*/)?.[0] || '';
      const rest = rawTxt.slice(lead.length);
      if (!rest) return lead;
      if (rest.startsWith('@')) {
        const afterAt = rest.slice(1);
        const expected = (el.getAttribute('data-mention-text') || el.getAttribute('data-person') || '').trim();
        if (
          expected.includes(' ') &&
          afterAt.toLowerCase().startsWith(expected.toLowerCase()) &&
          (afterAt.length === expected.length || /^[ \t\n,.;:!?)[\]]/.test(afterAt.slice(expected.length)))
        ) {
          const namePart = afterAt.slice(0, expected.length);
          const tail = afterAt.slice(expected.length);
          return `${lead}${formatPersonMention(namePart)}${tail}`;
        }
        const bIdx = afterAt.search(/[ \t\n,.;:!?)[\]]/);
        if (bIdx === -1) {
          return afterAt ? `${lead}${formatPersonMention(afterAt)}` : `${lead}@`;
        }
        const namePart = afterAt.slice(0, bIdx);
        const tail = afterAt.slice(bIdx);
        return namePart ? `${lead}${formatPersonMention(namePart)}${tail}` : `${lead}@${tail}`;
      }
      return rawTxt;
    }
    if (el.classList.contains('doc-link')) {
      const rawTxt = (el.textContent || '').replace(/\u00A0/g, ' ');
      const lead = rawTxt.match(/^\s*/)?.[0] || '';
      const trail = rawTxt.match(/\s*$/)?.[0] || '';
      const core = rawTxt.trim();
      return core ? `${lead}[[${core}]]${trail}` : rawTxt;
    }
    if (el.classList.contains('doc-attachment')) {
      const src = (el.getAttribute('data-attachment-src') || '').trim();
      const name = (el.getAttribute('data-attachment-name') || src.split('/').pop() || 'attachment').trim();
      return src ? `[${name}](${src})` : '';
    }
    if (el.classList.contains('doc-label')) {
      return (el.textContent || '').replace(/\u00A0/g, ' ');
    }
  }

  const childrenText = serializeInlineChildren(el);

  if (tag === 'STRONG' || tag === 'B') {
    return wrapMarkdownMark(childrenText, '**');
  }
  if (tag === 'EM' || tag === 'I') {
    return wrapMarkdownMark(childrenText, '*');
  }
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') {
    return wrapMarkdownMark(childrenText, '~~');
  }
  if (tag === 'CODE') {
    return childrenText ? `\`${childrenText}\`` : '';
  }

  return childrenText;
}

export function serializeInlineChildren(container: Node): string {
  let out = '';
  container.childNodes.forEach((child) => {
    out += serializeInlineNode(child);
  });
  return out;
}

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'HR',
  'PRE',
]);

function hasNestedBlockElements(el: HTMLElement): boolean {
  for (let i = 0; i < el.children.length; i++) {
    if (BLOCK_TAGS.has(el.children[i].tagName.toUpperCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Serializes the live contentEditable DOM back to canonical Strata Markdown.
 */
export function domToMarkdown(root: HTMLElement): string {
  const lines: string[] = [];

  const serializeListItemOrParagraph = (
    raw: string,
    listPrefix?: string,
    indentPrefix = ''
  ): string => {
    const dec = matchDecisionLine(raw);
    if (dec && dec.text) {
      return `${indentPrefix || dec.indent}- [D:${dec.status}] ${dec.text}`;
    }
    const task = matchTaskLine(raw);
    if (task && task.text) {
      return `${indentPrefix || task.indent}- [${task.statusChar}] ${task.text}`;
    }
    return listPrefix ? `${listPrefix}${raw}` : `${indentPrefix}${raw}`;
  };

  const serializeListElement = (listEl: HTMLElement, baseDepth: number) => {
    const isOrdered = listEl.tagName.toUpperCase() === 'OL';
    const numByDepth: Record<number, number> = {};

    Array.from(listEl.children).forEach((child) => {
      const childEl = child as HTMLElement;
      const childTag = childEl.tagName.toUpperCase();
      if (childTag === 'UL' || childTag === 'OL') {
        serializeListElement(childEl, baseDepth + 1);
        return;
      }
      if (childTag !== 'LI') return;

      const attrIndent = parseInt(childEl.getAttribute('data-indent') || '0', 10);
      const depth = Math.min(
        MAX_LIST_INDENT,
        baseDepth + (Number.isFinite(attrIndent) && attrIndent > 0 ? attrIndent : 0)
      );
      const indentPrefix = '  '.repeat(depth);

      const nestedLists: HTMLElement[] = [];
      let inlineText = '';
      childEl.childNodes.forEach((n) => {
        if (n.nodeType === Node.ELEMENT_NODE) {
          const t = (n as HTMLElement).tagName.toUpperCase();
          if (t === 'UL' || t === 'OL') {
            nestedLists.push(n as HTMLElement);
            return;
          }
        }
        inlineText += serializeInlineNode(n);
      });

      if (inlineText || nestedLists.length === 0) {
        if (isOrdered) {
          numByDepth[depth] = (numByDepth[depth] || 0) + 1;
          Object.keys(numByDepth).forEach((k) => {
            if (Number(k) > depth) delete numByDepth[Number(k)];
          });
          lines.push(
            serializeListItemOrParagraph(
              inlineText,
              `${indentPrefix}${numByDepth[depth]}. `,
              indentPrefix
            )
          );
        } else {
          lines.push(serializeListItemOrParagraph(inlineText, `${indentPrefix}- `, indentPrefix));
        }
      }

      nestedLists.forEach((nl) => serializeListElement(nl, depth + 1));
    });
  };

  const walkContainer = (container: HTMLElement) => {
    let inlineBuffer = '';
    const flushInlineBuffer = () => {
      if (inlineBuffer) {
        lines.push(serializeListItemOrParagraph(inlineBuffer));
        inlineBuffer = '';
      }
    };

    container.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const val = (node.nodeValue || '').replace(/\u00A0/g, ' ');
        if (val) inlineBuffer += val;
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      const tag = el.tagName.toUpperCase();

      if (!BLOCK_TAGS.has(tag)) {
        inlineBuffer += serializeInlineNode(el);
        return;
      }

      flushInlineBuffer();

      if (tag === 'FIGURE' && el.classList.contains('doc-image-block')) {
        const rawSrc = el.getAttribute('data-src') || el.querySelector('img')?.getAttribute('src') || '';
        if (rawSrc) {
          const src = rawSrc.startsWith('data:image/') ? registerDataUrlAssetSync(rawSrc) : rawSrc;
          const alt = (el.getAttribute('data-alt') ?? el.querySelector('img')?.getAttribute('alt') ?? 'Pasted image')
            .replace(/[[\]|]/g, '')
            .trim();
          const width = normalizeImageWidth(el.getAttribute('data-width') || '');
          lines.push(`![${alt}${width ? `|${width}` : ''}](${src})`);
        }
        return;
      }

      if (tag === 'UL' || tag === 'OL') {
        serializeListElement(el, 0);
        return;
      }

      if (tag === 'H1') {
        lines.push(`# ${serializeInlineChildren(el)}`);
        return;
      }

      if (tag === 'H2') {
        lines.push(`## ${serializeInlineChildren(el)}`);
        return;
      }

      if (tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') {
        lines.push(`### ${serializeInlineChildren(el)}`);
        return;
      }

      if (tag === 'HR') {
        lines.push('---');
        return;
      }

      if (tag === 'BLOCKQUOTE') {
        const raw = serializeInlineChildren(el);
        if (el.classList.contains('doc-rationale')) {
          const cleaned = raw.replace(/^Rationale:\s*/i, '');
          lines.push(`  > Rationale: ${cleaned}`);
        } else {
          raw.split('\n').forEach((sub) => lines.push(`> ${sub}`));
        }
        return;
      }

      if (el.classList.contains('doc-task')) {
        const status = el.getAttribute('data-status') || 'todo';
        const char = TASK_TO_STATUS_CHAR[status] || ' ';
        const attrIndent = parseInt(el.getAttribute('data-indent') || '0', 10);
        const indentPrefix =
          Number.isFinite(attrIndent) && attrIndent > 0
            ? '  '.repeat(Math.min(MAX_LIST_INDENT, attrIndent))
            : '';
        const inner = serializeInlineChildren(el);
        const stripped = matchTaskLine(inner);
        lines.push(
          `${indentPrefix}- [${char}] ${stripped && stripped.text ? stripped.text : inner}`
        );
        return;
      }

      if (el.classList.contains('doc-decision')) {
        const status = normalizeDecisionStatus(el.getAttribute('data-status'));
        const attrIndent = parseInt(el.getAttribute('data-indent') || '0', 10);
        const indentPrefix =
          Number.isFinite(attrIndent) && attrIndent > 0
            ? '  '.repeat(Math.min(MAX_LIST_INDENT, attrIndent))
            : '';
        const inner = serializeInlineChildren(el);
        const stripped = matchDecisionLine(inner);
        lines.push(
          `${indentPrefix}- [D:${status}] ${stripped && stripped.text ? stripped.text : inner}`
        );
        return;
      }

      if ((tag === 'DIV' || tag === 'P') && hasNestedBlockElements(el)) {
        walkContainer(el);
        return;
      }

      lines.push(serializeListItemOrParagraph(serializeInlineChildren(el)));
    });

    flushInlineBuffer();
  };

  walkContainer(root);

  if (lines.length === 1 && lines[0] === '') {
    return '';
  }
  return lines.join('\n');
}

function isSafePastedImageSrc(src: string): boolean {
  const s = src.trim().toLowerCase();
  if (!s) return false;
  if (s.startsWith('file:') || s.startsWith('webkit-fake-url:') || s.startsWith('javascript:')) {
    return false;
  }
  return (
    s.startsWith('data:image/') ||
    s.startsWith('https://') ||
    s.startsWith('http://') ||
    s.startsWith('blob:') ||
    s.startsWith('assets/')
  );
}

/**
 * Sanitizes pasted rich HTML (e.g., from Word, Outlook, Teams, Copilot, ChatGPT, or Docs) into clean Strata HTML
 * without inline font/background styles, promoting any task/decision list items or paragraphs into rich blocks.
 */
export function sanitizePastedHtml(rawHtml: string, knownPeople: Person[] = []): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');

  const cleanInline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return inlineMarkdownToHtml(node.nodeValue || '', knownPeople);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();

    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'META' || tag === 'INPUT') return '';
    if (tag === 'BR') return '<br>';
    if (tag === 'IMG') return '';

    if (el.classList.contains('doc-token')) {
      return el.outerHTML;
    }

    let inner = '';
    el.childNodes.forEach((c) => {
      inner += cleanInline(c);
    });

    if (tag === 'STRONG' || tag === 'B') return inner ? `<strong>${inner}</strong>` : '';
    if (tag === 'EM' || tag === 'I') return inner ? `<em>${inner}</em>` : '';
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') return inner ? `<s>${inner}</s>` : '';
    if (tag === 'CODE') return inner ? `<code>${inner}</code>` : '';
    return inner;
  };

  const stripLeadingMarkerFromClone = (
    sourceEl: HTMLElement,
    kind: 'decision' | 'task' | 'rationale'
  ): HTMLElement => {
    const clone = sourceEl.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input[type="checkbox"]').forEach((inp) => inp.remove());
    const fullText = (clone.textContent || '').replace(/\u00A0/g, ' ');
    const prefixRegex =
      kind === 'decision'
        ? /^\s*(?:(?:[-*+•]|\d+[.)])\s*)*(?:\[[ /?xX]?\]\s*)?[*_`]{0,2}\[D(?::[a-zA-ZäöüÄÖÜß_-]+)?\][*_`]{0,2}\s*/i
        : kind === 'task'
        ? /^\s*(?:(?:[-*+•]|\d+[.)])\s*)*[*_`]{0,2}\[[ /?xX]?\][*_`]{0,2}\s*/
        : /^\s*(?:[-*+•]\s*)?>\s*(?:(?:Rationale|Begründung|Reason)\s*:\s*)?/i;
    const m = fullText.match(prefixRegex);
    if (m && m[0].length > 0) {
      let toStrip = m[0].length;
      const walker = doc.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      const textNodes: Text[] = [];
      let curr: Node | null;
      while ((curr = walker.nextNode())) {
        textNodes.push(curr as Text);
      }
      for (const tn of textNodes) {
        if (toStrip <= 0) break;
        const val = (tn.nodeValue || '').replace(/\u00A0/g, ' ');
        if (val.length <= toStrip) {
          toStrip -= val.length;
          tn.nodeValue = '';
        } else {
          tn.nodeValue = val.slice(toStrip);
          toStrip = 0;
        }
      }
    }
    return clone;
  };

  const outBlocks: string[] = [];

  const emitImgElement = (imgEl: Element) => {
    const rawSrc = imgEl.getAttribute('data-src') || imgEl.getAttribute('src') || '';
    if (!isSafePastedImageSrc(rawSrc)) return;
    const alt = imgEl.getAttribute('alt') || 'Pasted image';
    const width = imgEl.getAttribute('data-width') || imgEl.getAttribute('width') || '';
    outBlocks.push(buildImageBlockHtml({ src: rawSrc, alt, width }));
  };

  const tryBuildSpecialBlockFromElement = (el: HTMLElement, extraIndent = 0): string | null => {
    const rawText = (el.textContent || '').replace(/\u00A0/g, ' ').trim();
    const checkbox = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    const attrIndent = parseInt(el.getAttribute('data-indent') || '0', 10);
    const totalIndent = Math.min(
      MAX_LIST_INDENT,
      extraIndent + (Number.isFinite(attrIndent) && attrIndent > 0 ? attrIndent : 0)
    );
    const indentAttr = totalIndent > 0 ? ` data-indent="${totalIndent}"` : '';

    const decMatch = matchDecisionLine(rawText);
    if (decMatch) {
      const strippedClone = stripLeadingMarkerFromClone(el, 'decision');
      const inner = cleanInline(strippedClone).trim();
      return `<p class="doc-decision" data-status="${escAttr(decMatch.status)}"${indentAttr}>${inner || '<br>'}</p>`;
    }

    const taskMatch = matchTaskLine(rawText);
    if (taskMatch || checkbox) {
      const status: TaskStatus = taskMatch
        ? taskMatch.status
        : checkbox?.checked || checkbox?.hasAttribute('checked')
        ? 'done'
        : 'todo';
      const strippedClone = stripLeadingMarkerFromClone(el, 'task');
      const inner = cleanInline(strippedClone).trim();
      return `<p class="doc-task" data-status="${escAttr(status)}"${indentAttr}>${inner || '<br>'}</p>`;
    }

    const prevBlock = outBlocks[outBlocks.length - 1] || '';
    if (prevBlock.startsWith('<p class="doc-decision"')) {
      const ratMatch = matchRationaleLine(rawText);
      if (ratMatch !== null) {
        const strippedClone = stripLeadingMarkerFromClone(el, 'rationale');
        const inner = cleanInline(strippedClone).trim();
        return `<blockquote class="doc-rationale">${inner || '<br>'}</blockquote>`;
      }
    }

    return null;
  };

  const cleanBlocks = (container: Node, listDepth = 0) => {
    container.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const txt = (node.nodeValue || '').trim();
        if (!txt) return;
        const decMatch = matchDecisionLine(txt);
        if (decMatch) {
          outBlocks.push(
            `<p class="doc-decision" data-status="${escAttr(decMatch.status)}">${
              renderBlockInlineHtml(decMatch.text, knownPeople) || '<br>'
            }</p>`
          );
          return;
        }
        const taskMatch = matchTaskLine(txt);
        if (taskMatch) {
          outBlocks.push(
            `<p class="doc-task" data-status="${escAttr(taskMatch.status)}">${
              renderBlockInlineHtml(taskMatch.text, knownPeople) || '<br>'
            }</p>`
          );
          return;
        }
        outBlocks.push(`<p>${inlineMarkdownToHtml(txt, knownPeople)}</p>`);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      const tag = el.tagName.toUpperCase();

      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'META') return;

      if (tag === 'IMG') {
        emitImgElement(el);
        return;
      }

      if (tag === 'FIGURE') {
        if (el.classList.contains('doc-image-block')) {
          const src = el.getAttribute('data-src') || el.querySelector('img')?.getAttribute('src') || '';
          if (isSafePastedImageSrc(src)) {
            outBlocks.push(
              buildImageBlockHtml({
                src,
                alt: el.getAttribute('data-alt') || 'Pasted image',
                width: el.getAttribute('data-width') || '',
              })
            );
          }
          return;
        }
        const figImg = el.querySelector('img');
        if (figImg) {
          emitImgElement(figImg);
          return;
        }
      }

      if (tag === 'UL' || tag === 'OL') {
        const listTag = tag.toLowerCase();
        const items: string[] = [];
        const flushListItems = () => {
          if (items.length > 0) {
            outBlocks.push(`<${listTag}>${items.join('')}</${listTag}>`);
            items.length = 0;
          }
        };

        const collectListChildren = (listNode: HTMLElement, depth: number) => {
          Array.from(listNode.children).forEach((child) => {
            const childEl = child as HTMLElement;
            const childTag = childEl.tagName.toUpperCase();
            if (childTag === 'UL' || childTag === 'OL') {
              collectListChildren(childEl, depth + 1);
              return;
            }
            if (childTag !== 'LI') return;
            const li = childEl;
            const attrIndent = parseInt(li.getAttribute('data-indent') || '0', 10);
            const itemDepth = Math.min(
              MAX_LIST_INDENT,
              depth + (Number.isFinite(attrIndent) && attrIndent > 0 ? attrIndent : 0)
            );
            const indentAttr = itemDepth > 0 ? ` data-indent="${itemDepth}"` : '';

            // Extract any nested <ul>/<ol> inside <li> so we can process the <li>'s own line and nested lists cleanly
            const nestedLists = Array.from(li.children).filter((c) => {
              const t = c.tagName.toUpperCase();
              return t === 'UL' || t === 'OL';
            }) as HTMLElement[];

            const ownLiClone = li.cloneNode(true) as HTMLElement;
            Array.from(ownLiClone.children).forEach((c) => {
              const t = c.tagName.toUpperCase();
              if (t === 'UL' || t === 'OL') c.remove();
            });

            const specialBlock = tryBuildSpecialBlockFromElement(ownLiClone, depth);
            if (specialBlock) {
              flushListItems();
              outBlocks.push(specialBlock);
            } else {
              const inlineHtml = cleanInline(ownLiClone).trim();
              if (inlineHtml || nestedLists.length === 0) {
                items.push(`<li${indentAttr}>${inlineHtml || '<br>'}</li>`);
              }
            }

            nestedLists.forEach((nl) => collectListChildren(nl, itemDepth + 1));
          });
        };

        collectListChildren(el, listDepth);
        flushListItems();
        return;
      }

      if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') {
        const hTag = tag === 'H1' || tag === 'H2' ? tag.toLowerCase() : 'h3';
        outBlocks.push(`<${hTag}>${cleanInline(el) || '<br>'}</${hTag}>`);
        return;
      }

      if (tag === 'BLOCKQUOTE') {
        const rawText = (el.textContent || '').replace(/\u00A0/g, ' ').trim();
        const prevBlock = outBlocks[outBlocks.length - 1] || '';
        const isRat =
          el.classList.contains('doc-rationale') ||
          (prevBlock.startsWith('<p class="doc-decision"') &&
            /^(?:Rationale|Begründung|Reason)\s*:/i.test(rawText));
        if (isRat) {
          const stripped = stripLeadingMarkerFromClone(el, 'rationale');
          outBlocks.push(`<blockquote class="doc-rationale">${cleanInline(stripped) || '<br>'}</blockquote>`);
        } else {
          outBlocks.push(`<blockquote>${cleanInline(el) || '<br>'}</blockquote>`);
        }
        return;
      }

      if (el.classList.contains('doc-task')) {
        const st = escAttr(el.getAttribute('data-status') || 'todo');
        const attrIndent = parseInt(el.getAttribute('data-indent') || '0', 10);
        const indentAttr =
          Number.isFinite(attrIndent) && attrIndent > 0
            ? ` data-indent="${Math.min(MAX_LIST_INDENT, attrIndent)}"`
            : '';
        const stripped = stripLeadingMarkerFromClone(el, 'task');
        outBlocks.push(`<p class="doc-task" data-status="${st}"${indentAttr}>${cleanInline(stripped) || '<br>'}</p>`);
        return;
      }

      if (el.classList.contains('doc-decision')) {
        const st = escAttr(normalizeDecisionStatus(el.getAttribute('data-status')));
        const attrIndent = parseInt(el.getAttribute('data-indent') || '0', 10);
        const indentAttr =
          Number.isFinite(attrIndent) && attrIndent > 0
            ? ` data-indent="${Math.min(MAX_LIST_INDENT, attrIndent)}"`
            : '';
        const stripped = stripLeadingMarkerFromClone(el, 'decision');
        outBlocks.push(`<p class="doc-decision" data-status="${st}"${indentAttr}>${cleanInline(stripped) || '<br>'}</p>`);
        return;
      }

      if (tag === 'P' || tag === 'DIV' || tag === 'LI') {
        if (hasNestedBlockElements(el)) {
          cleanBlocks(el, listDepth);
        } else {
          const specialBlock = tryBuildSpecialBlockFromElement(el, listDepth);
          if (specialBlock) {
            outBlocks.push(specialBlock);
          } else {
            const inner = cleanInline(el);
            if (inner || (tag === 'P' && !el.querySelector('img'))) {
              outBlocks.push(`<p>${inner || '<br>'}</p>`);
            }
          }
          el.querySelectorAll('img').forEach(emitImgElement);
        }
        return;
      }

      const specialFallback = tryBuildSpecialBlockFromElement(el, listDepth);
      if (specialFallback) {
        outBlocks.push(specialFallback);
      } else {
        const fallback = cleanInline(el);
        if (fallback) outBlocks.push(`<p>${fallback}</p>`);
      }
      el.querySelectorAll('img').forEach(emitImgElement);
    });
  };

  cleanBlocks(doc.body);
  return outBlocks.join('');
}
