import React from 'react';
import { Gavel } from 'lucide-react';
import type { Client, DecisionStatus, Note, Person, TaskStatus } from '../types';
import { parseAltAndWidth } from '../utils/docSerializer';
import { resolveImageSrc } from '../utils/imageStore';
import { matchDecisionLine, matchRationaleLine, matchTaskLine } from '../utils/markdown';
import { RichInlineText } from './RichInlineText';

export interface RichMarkdownProps {
  markdown: string;
  people: Person[];
  clients: Client[];
  notes: Note[];
  compact?: boolean;
  className?: string;
  onClickPerson?: (personName: string) => void;
  onClickLabel?: (label: string) => void;
  onClickNoteLink?: (noteTitle: string) => void;
}

interface ParsedListItem {
  indent: number;
  ordered: boolean;
  orderNum?: number;
  content: string;
  taskStatus?: TaskStatus;
  decisionStatus?: DecisionStatus;
  rationale?: string;
}

function isHorizontalRule(line: string): boolean {
  return /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})\s*$/.test(line);
}

function isTableSeparatorLine(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, '');
  return trimmed.split('|').map((c) => c.trim());
}

function parseListLine(line: string): ParsedListItem | null {
  if (isHorizontalRule(line)) return null;

  const decMatch = matchDecisionLine(line);
  if (decMatch && decMatch.text) {
    return {
      indent: decMatch.indent.replace(/\t/g, '  ').length,
      ordered: false,
      content: decMatch.text,
      decisionStatus: decMatch.status,
    };
  }

  const taskMatch = matchTaskLine(line);
  if (taskMatch && taskMatch.text) {
    return {
      indent: taskMatch.indent.replace(/\t/g, '  ').length,
      ordered: false,
      content: taskMatch.text,
      taskStatus: taskMatch.status,
    };
  }

  const ulMatch = line.match(/^([ \t]*)[-*+•]\s+(.+)$/);
  if (ulMatch) {
    return {
      indent: ulMatch[1].replace(/\t/g, '  ').length,
      ordered: false,
      content: ulMatch[2].trim(),
    };
  }

  const olMatch = line.match(/^([ \t]*)(\d+)[.)]\s+(.+)$/);
  if (olMatch) {
    return {
      indent: olMatch[1].replace(/\t/g, '  ').length,
      ordered: true,
      orderNum: Number(olMatch[2]),
      content: olMatch[3].trim(),
    };
  }

  return null;
}

function unwrapOuterMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return match ? match[1].trim() : trimmed;
}

export const RichMarkdown: React.FC<RichMarkdownProps> = ({
  markdown,
  people,
  clients,
  notes,
  compact = false,
  className = '',
  onClickPerson,
  onClickLabel,
  onClickNoteLink,
}) => {
  const normalized = unwrapOuterMarkdownFence(markdown || '').replace(/\r\n/g, '\n');
  if (!normalized) return null;

  const renderInline = (text: string) => (
    <RichInlineText
      text={text}
      people={people}
      clients={clients}
      notes={notes}
      onClickPerson={onClickPerson}
      onClickLabel={onClickLabel}
      onClickNoteLink={onClickNoteLink}
    />
  );

  const renderListItemBody = (item: ParsedListItem) => {
    if (item.decisionStatus) {
      return (
        <div className="rich-md-decision-item">
          <div className="rich-md-decision-row">
            <span
              className={`status-badge decision-badge-${item.decisionStatus}`}
              style={{ cursor: 'default' }}
            >
              <Gavel size={10} /> {item.decisionStatus}
            </span>
            <span className="rich-md-decision-text">{renderInline(item.content)}</span>
          </div>
          {item.rationale && (
            <div className="rich-md-rationale">
              <strong>Rationale:</strong> {renderInline(item.rationale)}
            </div>
          )}
        </div>
      );
    }

    if (item.taskStatus) {
      const symbol =
        item.taskStatus === 'done'
          ? '✓'
          : item.taskStatus === 'doing'
          ? '◐'
          : item.taskStatus === 'waiting'
          ? '◷'
          : '';
      return (
        <div className={`rich-md-task-item ${item.taskStatus === 'done' ? 'is-done' : ''}`}>
          <span className={`rich-md-checkbox status-${item.taskStatus}`} aria-hidden="true">
            {symbol}
          </span>
          <span className="rich-md-task-text">{renderInline(item.content)}</span>
        </div>
      );
    }

    return renderInline(item.content);
  };

  const buildListTree = (
    items: ParsedListItem[],
    startIdx: number,
    keyPrefix: string
  ): { element: React.ReactNode; nextIdx: number } => {
    const first = items[startIdx];
    const baseIndent = first.indent;
    const isOrdered = first.ordered;
    const liNodes: React.ReactNode[] = [];
    let idx = startIdx;

    while (idx < items.length) {
      const curr = items[idx];
      if (curr.indent < baseIndent) break;
      if (curr.indent === baseIndent && curr.ordered !== isOrdered && liNodes.length > 0) {
        break;
      }

      const itemIndex = idx;
      idx++;

      const nestedLists: React.ReactNode[] = [];
      while (idx < items.length && items[idx].indent > curr.indent) {
        const sub = buildListTree(items, idx, `${keyPrefix}-${itemIndex}`);
        nestedLists.push(sub.element);
        idx = sub.nextIdx;
      }

      const isSpecialBlockItem = Boolean(curr.taskStatus || curr.decisionStatus);
      liNodes.push(
        <li
          key={`${keyPrefix}-li-${itemIndex}`}
          className={isSpecialBlockItem ? 'rich-md-li-special' : 'rich-md-li'}
        >
          {renderListItemBody(curr)}
          {nestedLists}
        </li>
      );
    }

    if (isOrdered) {
      return {
        element: (
          <ol
            key={`${keyPrefix}-ol-${startIdx}`}
            start={first.orderNum && first.orderNum !== 1 ? first.orderNum : undefined}
            className="rich-md-ol"
          >
            {liNodes}
          </ol>
        ),
        nextIdx: idx,
      };
    }

    return {
      element: (
        <ul key={`${keyPrefix}-ul-${startIdx}`} className="rich-md-ul">
          {liNodes}
        </ul>
      ),
      nextIdx: idx,
    };
  };

  const lines = normalized.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Skip blank lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // 2. Fenced code block (```lang ... ```)
    const fenceMatch = line.match(/^\s*```([\w+-]*)\s*$/);
    if (fenceMatch) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      blocks.push(
        <pre key={`code-${i}`} className="rich-md-pre">
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // 3. Horizontal rule (---, ***, ___)
    if (isHorizontalRule(line)) {
      blocks.push(<hr key={`hr-${i}`} className="rich-md-hr" />);
      i++;
      continue;
    }

    // 4. Headings (# .. ######)
    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInline(headingMatch[2]);
      if (level === 1) {
        blocks.push(
          <h1 key={`h1-${i}`} className="rich-md-h1">
            {content}
          </h1>
        );
      } else if (level === 2) {
        blocks.push(
          <h2 key={`h2-${i}`} className="rich-md-h2">
            {content}
          </h2>
        );
      } else if (level === 3) {
        blocks.push(
          <h3 key={`h3-${i}`} className="rich-md-h3">
            {content}
          </h3>
        );
      } else {
        blocks.push(
          <h4 key={`h4-${i}`} className="rich-md-h4">
            {content}
          </h4>
        );
      }
      i++;
      continue;
    }

    // 5. Standalone image block ![alt|width](src)
    const imgBlockMatch = line.match(/^\s*!\[([^\]]*)\]\(([^)\n]+)\)\s*$/);
    if (imgBlockMatch) {
      const { alt, width } = parseAltAndWidth(imgBlockMatch[1]);
      const resolved = resolveImageSrc(imgBlockMatch[2].trim());
      const cssWidth = width ? (width.endsWith('%') ? width : `${width}px`) : undefined;
      blocks.push(
        <figure
          key={`img-${i}`}
          className="rich-md-figure"
          style={cssWidth ? { width: cssWidth } : undefined}
        >
          <img src={resolved} alt={alt || 'Note image'} className="rich-md-img" />
        </figure>
      );
      i++;
      continue;
    }

    // 6. Markdown pipe table
    if (line.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      const headerCells = splitTableCells(line);
      const alignSpecs = splitTableCells(lines[i + 1]).map((spec) => {
        if (spec.startsWith(':') && spec.endsWith(':')) return 'center' as const;
        if (spec.endsWith(':')) return 'right' as const;
        return 'left' as const;
      });
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        bodyRows.push(splitTableCells(lines[i]));
        i++;
      }
      blocks.push(
        <div key={`tbl-${i}`} className="rich-md-table-wrap">
          <table className="rich-md-table">
            <thead>
              <tr>
                {headerCells.map((cell, cIdx) => (
                  <th key={cIdx} style={{ textAlign: alignSpecs[cIdx] || 'left' }}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {headerCells.map((_, cIdx) => (
                    <td key={cIdx} style={{ textAlign: alignSpecs[cIdx] || 'left' }}>
                      {renderInline(row[cIdx] || '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // 7. Lists (Unordered, Ordered, Tasks, Decisions — with arbitrary nested indentation)
    const firstListItem = parseListLine(line);
    if (firstListItem) {
      const listStartIdx = i;
      const collected: ParsedListItem[] = [];

      while (i < lines.length) {
        const currLine = lines[i];

        if (!currLine.trim()) {
          // Peek at next non-empty line to support loose lists (blank line between bullets)
          let peek = i + 1;
          while (peek < lines.length && !lines[peek].trim()) peek++;
          if (peek < lines.length && parseListLine(lines[peek])) {
            i = peek;
            continue;
          }
          break;
        }

        const parsedItem = parseListLine(currLine);
        if (parsedItem) {
          // Capture optional indented `> Rationale: ...` line directly beneath a Decision item
          if (parsedItem.decisionStatus && i + 1 < lines.length) {
            const ratText = matchRationaleLine(lines[i + 1]);
            if (ratText !== null && ratText) {
              parsedItem.rationale = ratText;
              collected.push(parsedItem);
              i += 2;
              continue;
            }
          }
          collected.push(parsedItem);
          i++;
          continue;
        }

        // Indented continuation line inside the current list item
        if (
          collected.length > 0 &&
          /^[ \t]{2,}\S/.test(currLine) &&
          !isHorizontalRule(currLine) &&
          !/^\s*#{1,6}\s+/.test(currLine) &&
          !/^\s*```/.test(currLine)
        ) {
          collected[collected.length - 1].content += ` ${currLine.trim()}`;
          i++;
          continue;
        }

        break;
      }

      let groupCursor = 0;
      while (groupCursor < collected.length) {
        const built = buildListTree(collected, groupCursor, `list-${listStartIdx}`);
        blocks.push(built.element);
        groupCursor = built.nextIdx;
      }
      continue;
    }

    // 8. Blockquotes (> ...)
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={`q-${i}`} className="rich-md-quote">
          {quoteLines.map((ql, qIdx) => (
            <React.Fragment key={qIdx}>
              {qIdx > 0 && <br />}
              {renderInline(ql)}
            </React.Fragment>
          ))}
        </blockquote>
      );
      continue;
    }

    // 9. Standard paragraph (join consecutive soft-wrapped prose lines)
    const paraLines: string[] = [line.trim()];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isHorizontalRule(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*#{1,6}\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*!\[[^\]]*\]\([^)\n]+\)\s*$/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) &&
      !parseListLine(lines[i])
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }

    blocks.push(
      <p key={`p-${i}`} className="rich-md-p">
        {paraLines.map((pl, pIdx) => (
          <React.Fragment key={pIdx}>
            {pIdx > 0 && <br />}
            {renderInline(pl)}
          </React.Fragment>
        ))}
      </p>
    );
  }

  return (
    <div className={['rich-markdown', compact ? 'compact' : '', className].filter(Boolean).join(' ')}>
      {blocks}
    </div>
  );
};
