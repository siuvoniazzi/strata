import React, { useMemo } from 'react';
import type { Client, Note, Person } from '../types';
import { parseAltAndWidth } from '../utils/docSerializer';
import { resolveImageSrc } from '../utils/imageStore';

export interface RichInlineTextProps {
  text: string;
  people: Person[];
  clients: Client[];
  notes: Note[];
  onClickPerson?: (personName: string) => void;
  onClickLabel?: (label: string) => void;
  onClickNoteLink?: (noteTitle: string) => void;
}

export const RichInlineText: React.FC<RichInlineTextProps> = ({
  text,
  people,
  clients,
  notes,
  onClickPerson,
  onClickLabel,
  onClickNoteLink,
}) => {
  const masterRegex = useMemo(() => {
    const sortedMultiWordPeople = [...people]
      .filter((p) => p.name.trim().includes(' '))
      .sort((a, b) => b.name.length - a.name.length);

    const multiWordAlternation = sortedMultiWordPeople
      .map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');

    const patternParts = [
      '`[^`\\n]+`', // `inline code`
      '!\\[[^\\]]*\\]\\([^)\\n]+\\)', // ![alt|width](src)
      '\\[\\[[^\\]]+\\]\\]', // [[Note Title]] or [[Note Title|Alias]]
      '\\[[^\\]]+\\]\\((?:https?:\\/\\/|mailto:)[^)\\s]+\\)', // [label](https://...)
      '@\\[[^\\]]+\\]', // @[Full Name]
      ...(multiWordAlternation
        ? [`(?<=^|[\\s([{"'])@(?:${multiWordAlternation})(?=$|[\\s,.;:!?)\\]}"'])`]
        : []),
      '(?<=^|[\\s([{"\'])@[\\p{L}][\\p{L}\\p{N}._-]{1,30}', // @SingleWord
      '(?<=^|[\\s([{"\'])#[\\p{L}][\\p{L}\\p{N}_-]{1,38}', // #label
      '\\bdue:\\d{4}-\\d{2}-\\d{2}\\b', // due:YYYY-MM-DD
      '(?<=^|\\s)!(?:high|medium|med|low)\\b', // !priority
      '\\*\\*\\*(?!\\s).+?(?<!\\s)\\*\\*\\*', // ***bold italic***
      '(?<=^|[\\s([{"\'])___(?!\\s).+?(?<!\\s)___(?=$|[\\s,.;:!?)\\]}"\'])', // ___bold italic___
      '\\*\\*(?!\\s).+?(?<!\\s)\\*\\*', // **bold**
      '(?<=^|[\\s([{"\'])__(?!\\s).+?(?<!\\s)__(?=$|[\\s,.;:!?)\\]}"\'])', // __bold__
      '(?<!\\*)\\*(?!\\s|\\*).+?(?<!\\s|\\*)\\*(?!\\*)', // *italic*
      '(?<=^|[\\s([{"\'])_(?!\\s|_).+?(?<!\\s|_)_(?=$|[\\s,.;:!?)\\]}"\'])', // _italic_
      '~~(?!\\s).+?(?<!\\s)~~', // ~~strikethrough~~
    ];

    return new RegExp(`(${patternParts.join('|')})`, 'giu');
  }, [people]);

  if (!text) return null;

  const renderNested = (inner: string) => (
    <RichInlineText
      text={inner}
      people={people}
      clients={clients}
      notes={notes}
      onClickPerson={onClickPerson}
      onClickLabel={onClickLabel}
      onClickNoteLink={onClickNoteLink}
    />
  );

  const renderPersonPill = (key: string, candidateName: string, allowFirstNameMatch: boolean) => {
    const lower = candidateName.toLowerCase();
    const person =
      people.find((p) => p.name.toLowerCase() === lower) ||
      (allowFirstNameMatch
        ? people.find((p) => p.name.toLowerCase().split(/\s+/)[0] === lower)
        : undefined);
    const client = person?.clientId ? clients.find((c) => c.id === person.clientId) : null;
    const tooltip = [person?.role, client?.name].filter(Boolean).join(' · ') || 'Person';
    const resolvedName = person?.name || candidateName;

    if (!onClickPerson) {
      return (
        <span
          key={key}
          className="pill pill-person"
          title={tooltip}
          style={{ cursor: 'default' }}
        >
          @{resolvedName}
        </span>
      );
    }

    return (
      <button
        key={key}
        type="button"
        className="pill pill-person"
        title={tooltip}
        onClick={(e) => {
          e.stopPropagation();
          onClickPerson(resolvedName);
        }}
      >
        @{resolvedName}
      </button>
    );
  };

  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  masterRegex.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = masterRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    const raw = match[0];
    const key = `${match.index}-${raw.slice(0, 24)}`;

    if (raw.startsWith('`') && raw.endsWith('`')) {
      parts.push(<code key={key}>{raw.slice(1, -1)}</code>);
    } else if (raw.startsWith('![') && raw.endsWith(')')) {
      const imgMatch = raw.match(/^!\[([^\]]*)\]\(([^)\n]+)\)$/);
      if (imgMatch) {
        const { alt, width } = parseAltAndWidth(imgMatch[1]);
        const resolved = resolveImageSrc(imgMatch[2].trim());
        const cssWidth = width ? (width.endsWith('%') ? width : `${width}px`) : undefined;
        parts.push(
          <img
            key={key}
            src={resolved}
            alt={alt || 'Image'}
            className="rich-md-inline-img"
            style={cssWidth ? { width: cssWidth } : undefined}
          />
        );
      } else {
        parts.push(raw);
      }
    } else if (raw.startsWith('[[') && raw.endsWith(']]')) {
      const inner = raw.slice(2, -2).trim();
      const pipeIdx = inner.indexOf('|');
      const targetTitle = (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim();
      const displayTitle =
        (pipeIdx === -1 ? inner : inner.slice(pipeIdx + 1)).trim() || targetTitle;
      const exists = notes.some((n) => n.title.toLowerCase() === targetTitle.toLowerCase());

      if (!onClickNoteLink) {
        parts.push(
          <span
            key={key}
            className="pill pill-link"
            title={targetTitle}
            style={{ cursor: 'default' }}
          >
            ↗ {displayTitle}
          </span>
        );
      } else {
        parts.push(
          <button
            key={key}
            type="button"
            className="pill pill-link"
            title={exists ? `Open note: ${targetTitle}` : `Create & open note: ${targetTitle}`}
            onClick={(e) => {
              e.stopPropagation();
              onClickNoteLink(targetTitle);
            }}
          >
            ↗ {displayTitle}
          </button>
        );
      }
    } else if (raw.startsWith('[') && raw.endsWith(')')) {
      const linkMatch = raw.match(/^\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)$/);
      if (linkMatch) {
        parts.push(
          <a
            key={key}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="rich-md-ext-link"
            onClick={(e) => e.stopPropagation()}
          >
            {renderNested(linkMatch[1])}
          </a>
        );
      } else {
        parts.push(raw);
      }
    } else if (raw.startsWith('@[') && raw.endsWith(']')) {
      const name = raw.slice(2, -1).trim();
      parts.push(renderPersonPill(key, name, false));
    } else if (raw.startsWith('@')) {
      const token = raw.slice(1).trim();
      parts.push(renderPersonPill(key, token, !token.includes(' ')));
    } else if (raw.startsWith('#')) {
      const lbl = raw.slice(1).toLowerCase();
      if (!onClickLabel) {
        parts.push(
          <span
            key={key}
            className="pill pill-label"
            style={{ cursor: 'default' }}
          >
            #{lbl}
          </span>
        );
      } else {
        parts.push(
          <button
            key={key}
            type="button"
            className="pill pill-label"
            title={`View #${lbl} topic & notes`}
            onClick={(e) => {
              e.stopPropagation();
              onClickLabel(lbl);
            }}
          >
            #{lbl}
          </button>
        );
      }
    } else if (/^due:\d{4}-\d{2}-\d{2}$/i.test(raw)) {
      parts.push(
        <span key={key} className="due-chip">
          due {raw.slice(4)}
        </span>
      );
    } else if (/^!(?:high|medium|med|low)$/i.test(raw)) {
      const norm = raw.slice(1).toLowerCase() === 'med' ? 'medium' : raw.slice(1).toLowerCase();
      parts.push(
        <span key={key} className={norm === 'high' ? 'priority-high' : 'due-chip'}>
          !{norm.toUpperCase()}
        </span>
      );
    } else if (
      (raw.startsWith('***') && raw.endsWith('***')) ||
      (raw.startsWith('___') && raw.endsWith('___'))
    ) {
      parts.push(
        <strong key={key}>
          <em>{renderNested(raw.slice(3, -3))}</em>
        </strong>
      );
    } else if (
      (raw.startsWith('**') && raw.endsWith('**')) ||
      (raw.startsWith('__') && raw.endsWith('__'))
    ) {
      parts.push(<strong key={key}>{renderNested(raw.slice(2, -2))}</strong>);
    } else if (raw.startsWith('~~') && raw.endsWith('~~')) {
      parts.push(<s key={key}>{renderNested(raw.slice(2, -2))}</s>);
    } else if (
      (raw.startsWith('*') && raw.endsWith('*')) ||
      (raw.startsWith('_') && raw.endsWith('_'))
    ) {
      parts.push(<em key={key}>{renderNested(raw.slice(1, -1))}</em>);
    } else {
      parts.push(raw);
    }

    lastIdx = match.index + raw.length;
  }

  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }

  return <>{parts}</>;
};
