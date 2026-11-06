import type { DecisionStatus, Person, TaskStatus } from '../types';
import { formatPersonMention, resolveKnownPersonName } from './markdown';

const STATUS_CHAR_TO_TASK: Record<string, TaskStatus> = {
  ' ': 'todo',
  '/': 'doing',
  '?': 'waiting',
  x: 'done',
  X: 'done',
};

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

/**
 * Converts inline Markdown (bold, italic, strike, code, @[Person], #label, [[Note]], due:, !prio)
 * into clean semantic HTML spans for the continuous Word-like document surface.
 */
export function inlineMarkdownToHtml(text: string, knownPeople: Person[] = []): string {
  if (!text) return '';

  // Build dynamic alternation for unbracketed multi-word known people (@Jane Doe)
  const sortedPeople = [...knownPeople]
    .filter((p) => p.name.trim().includes(' '))
    .sort((a, b) => b.name.length - a.name.length);

  const multiWordPersonAlternation = sortedPeople
    .map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  const patternParts = [
    '`([^`]+)`', // 1: inline code
    '\\[\\[([^\\]]+)\\]\\]', // 2: [[Note Link]]
    '@\\[([^\\]]+)\\]', // 3: @[Full Name]
    ...(multiWordPersonAlternation
      ? [`(?<=^|[\\s(])@(${multiWordPersonAlternation})(?=$|[\\s,.;:!?)])`] // 4: @Known Multiword
      : []),
    '(?<=^|[\\s(])@([\\p{L}][\\p{L}\\p{N}._-]{0,30})', // 4 or 5: @SingleWord
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
    } else if (raw.startsWith('[[') && raw.endsWith(']]')) {
      const title = raw.slice(2, -2).trim();
      out.push(
        `<span class="doc-token doc-link" data-link="${escAttr(title)}">${escHtml(title)}</span>`
      );
    } else if (raw.startsWith('@[')) {
      const rawName = raw.slice(2, -1).trim();
      const resolved = resolveKnownPersonName(rawName, knownPeople);
      out.push(
        `<span class="doc-token doc-person" data-person="${escAttr(resolved)}">@${escHtml(resolved)}</span>`
      );
    } else if (raw.startsWith('@')) {
      const rawName = raw.slice(1).trim();
      const resolved = resolveKnownPersonName(rawName, knownPeople);
      out.push(
        `<span class="doc-token doc-person" data-person="${escAttr(resolved)}">@${escHtml(resolved)}</span>`
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

/**
 * Hydrates a Markdown note body into clean semantic block HTML for the continuous Word-like page.
 */
export function markdownToHtml(markdown: string, knownPeople: Person[] = []): string {
  if (!markdown) {
    return '<p><br></p>';
  }

  const lines = markdown.split('\n');
  const htmlBlocks: string[] = [];
  let i = 0;

  const isBulletLine = (line: string) =>
    /^\s*[-*•]\s+(.*)$/.test(line) &&
    !/^\s*[-*]\s*\[(?:[ /?xX]|D(?::[a-z]+)?)\](?:\s|$)/i.test(line);

  const isOrderedLine = (line: string) => /^\s*\d+\.\s+(.*)$/.test(line);

  while (i < lines.length) {
    const line = lines[i];

    // 1. Decision block (+ optional indented Rationale sub-line)
    const decMatch = line.match(/^\s*[-*]\s*\[D(?::(agreed|proposed|superseded))?\](?:\s+(.*))?$/i);
    if (decMatch) {
      const status = ((decMatch[1] || 'agreed').toLowerCase() as DecisionStatus);
      const inner = inlineMarkdownToHtml(decMatch[2] || '', knownPeople);
      htmlBlocks.push(`<p class="doc-decision" data-status="${status}">${inner || '<br>'}</p>`);

      if (i + 1 < lines.length) {
        const ratMatch = lines[i + 1].match(/^\s*>\s*(?:Rationale:\s*)?(.*)$/i);
        if (ratMatch) {
          const ratInner = inlineMarkdownToHtml(ratMatch[1] || '', knownPeople);
          htmlBlocks.push(`<blockquote class="doc-rationale">${ratInner || '<br>'}</blockquote>`);
          i += 2;
          continue;
        }
      }
      i++;
      continue;
    }

    // 2. Task block (- [ ] / - [/] / - [?] / - [x])
    const taskMatch = line.match(/^\s*[-*]\s*\[([ /?xX])\](?:\s+(.*))?$/);
    if (taskMatch) {
      const status = STATUS_CHAR_TO_TASK[taskMatch[1]] || 'todo';
      const inner = inlineMarkdownToHtml(taskMatch[2] || '', knownPeople);
      htmlBlocks.push(`<p class="doc-task" data-status="${status}">${inner || '<br>'}</p>`);
      i++;
      continue;
    }

    // 3. Consecutive Unordered Bullet List
    if (isBulletLine(line)) {
      const items: string[] = [];
      while (i < lines.length && isBulletLine(lines[i])) {
        const m = lines[i].match(/^\s*[-*•]\s+(.*)$/);
        const itemHtml = inlineMarkdownToHtml(m ? m[1] : '', knownPeople);
        items.push(`<li>${itemHtml || '<br>'}</li>`);
        i++;
      }
      htmlBlocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // 4. Consecutive Numbered List
    if (isOrderedLine(line)) {
      const items: string[] = [];
      while (i < lines.length && isOrderedLine(lines[i])) {
        const m = lines[i].match(/^\s*\d+\.\s+(.*)$/);
        const itemHtml = inlineMarkdownToHtml(m ? m[1] : '', knownPeople);
        items.push(`<li>${itemHtml || '<br>'}</li>`);
        i++;
      }
      htmlBlocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // 5. Headings
    const h3Match = line.match(/^###\s+(.*)$/);
    if (h3Match) {
      const inner = inlineMarkdownToHtml(h3Match[1], knownPeople);
      htmlBlocks.push(`<h3>${inner || '<br>'}</h3>`);
      i++;
      continue;
    }

    const h2Match = line.match(/^##\s+(.*)$/);
    if (h2Match) {
      const inner = inlineMarkdownToHtml(h2Match[1], knownPeople);
      htmlBlocks.push(`<h2>${inner || '<br>'}</h2>`);
      i++;
      continue;
    }

    const h1Match = line.match(/^#\s+(.*)$/);
    if (h1Match) {
      const inner = inlineMarkdownToHtml(h1Match[1], knownPeople);
      htmlBlocks.push(`<h1>${inner || '<br>'}</h1>`);
      i++;
      continue;
    }

    // 6. Horizontal Rule
    if (/^\s*---+\s*$/.test(line)) {
      htmlBlocks.push('<hr>');
      i++;
      continue;
    }

    // 7. Blockquote
    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      const inner = inlineMarkdownToHtml(quoteMatch[1], knownPeople);
      htmlBlocks.push(`<blockquote>${inner || '<br>'}</blockquote>`);
      i++;
      continue;
    }

    // 8. Blank line or normal paragraph
    if (!line.trim()) {
      htmlBlocks.push('<p><br></p>');
    } else {
      htmlBlocks.push(`<p>${inlineMarkdownToHtml(line, knownPeople)}</p>`);
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

  if (tag === 'SPAN') {
    if (el.classList.contains('doc-person')) {
      const txt = (el.textContent || '').replace(/\u00A0/g, ' ').trim();
      if (!txt) return '';
      if (txt.startsWith('@')) {
        const name = txt.slice(1).trim();
        return name ? formatPersonMention(name) : '@';
      }
      return txt;
    }
    if (el.classList.contains('doc-link')) {
      const txt = (el.textContent || '').replace(/\u00A0/g, ' ').trim();
      return txt ? `[[${txt}]]` : '';
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

  const walkContainer = (container: HTMLElement) => {
    let inlineBuffer = '';
    const flushInlineBuffer = () => {
      if (inlineBuffer) {
        lines.push(inlineBuffer);
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

      if (tag === 'UL') {
        Array.from(el.children).forEach((child) => {
          if (child.tagName.toUpperCase() === 'LI') {
            lines.push(`- ${serializeInlineChildren(child)}`);
          }
        });
        return;
      }

      if (tag === 'OL') {
        let num = 1;
        Array.from(el.children).forEach((child) => {
          if (child.tagName.toUpperCase() === 'LI') {
            lines.push(`${num++}. ${serializeInlineChildren(child)}`);
          }
        });
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
        lines.push(`- [${char}] ${serializeInlineChildren(el)}`);
        return;
      }

      if (el.classList.contains('doc-decision')) {
        const status = el.getAttribute('data-status') || 'agreed';
        lines.push(`- [D:${status}] ${serializeInlineChildren(el)}`);
        return;
      }

      if ((tag === 'DIV' || tag === 'P') && hasNestedBlockElements(el)) {
        walkContainer(el);
        return;
      }

      lines.push(serializeInlineChildren(el));
    });

    flushInlineBuffer();
  };

  walkContainer(root);

  if (lines.length === 1 && lines[0] === '') {
    return '';
  }
  return lines.join('\n');
}

/**
 * Sanitizes pasted rich HTML (e.g., from Word, Outlook, Teams, or Docs) into clean Strata HTML
 * without inline font/background styles.
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

    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'META') return '';
    if (tag === 'BR') return '<br>';

    if (el.classList.contains('doc-token')) {
      return el.outerHTML;
    }

    let inner = '';
    el.childNodes.forEach((c) => {
      inner += cleanInline(c);
    });

    if (tag === 'STRONG' || tag === 'B') return `<strong>${inner}</strong>`;
    if (tag === 'EM' || tag === 'I') return `<em>${inner}</em>`;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') return `<s>${inner}</s>`;
    if (tag === 'CODE') return `<code>${inner}</code>`;
    return inner;
  };

  const outBlocks: string[] = [];

  const cleanBlocks = (container: Node) => {
    container.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const txt = (node.nodeValue || '').trim();
        if (txt) outBlocks.push(`<p>${inlineMarkdownToHtml(txt, knownPeople)}</p>`);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      const tag = el.tagName.toUpperCase();

      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'META') return;

      if (tag === 'UL' || tag === 'OL') {
        const listTag = tag.toLowerCase();
        const items: string[] = [];
        Array.from(el.children).forEach((li) => {
          if (li.tagName.toUpperCase() === 'LI') {
            items.push(`<li>${cleanInline(li) || '<br>'}</li>`);
          }
        });
        if (items.length) outBlocks.push(`<${listTag}>${items.join('')}</${listTag}>`);
        return;
      }

      if (tag === 'H1' || tag === 'H2' || tag === 'H3') {
        const hTag = tag.toLowerCase();
        outBlocks.push(`<${hTag}>${cleanInline(el) || '<br>'}</${hTag}>`);
        return;
      }

      if (tag === 'BLOCKQUOTE') {
        const cls = el.classList.contains('doc-rationale') ? ' class="doc-rationale"' : '';
        outBlocks.push(`<blockquote${cls}>${cleanInline(el) || '<br>'}</blockquote>`);
        return;
      }

      if (el.classList.contains('doc-task')) {
        const st = escAttr(el.getAttribute('data-status') || 'todo');
        outBlocks.push(`<p class="doc-task" data-status="${st}">${cleanInline(el) || '<br>'}</p>`);
        return;
      }

      if (el.classList.contains('doc-decision')) {
        const st = escAttr(el.getAttribute('data-status') || 'agreed');
        outBlocks.push(`<p class="doc-decision" data-status="${st}">${cleanInline(el) || '<br>'}</p>`);
        return;
      }

      if (tag === 'P' || tag === 'DIV' || tag === 'LI') {
        if (hasNestedBlockElements(el)) {
          cleanBlocks(el);
        } else {
          const inner = cleanInline(el);
          if (inner || tag === 'P') {
            outBlocks.push(`<p>${inner || '<br>'}</p>`);
          }
        }
        return;
      }

      const fallback = cleanInline(el);
      if (fallback) outBlocks.push(`<p>${fallback}</p>`);
    });
  };

  cleanBlocks(doc.body);
  return outBlocks.join('');
}
