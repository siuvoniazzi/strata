import React from 'react';
import type { Client, Note, Person } from '../types';

interface RichInlineTextProps {
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
  // Match @[Full Name], [[Note Title]], #label, or @SingleWord
  const tokenRegex = /(@\[[^\]]+\]|\[\[[^\]]+\]\]|(?<=^|[\s(])#[\p{L}][\p{L}\p{N}_-]{1,38}|(?<=^|[\s(])@[\p{L}][\p{L}\p{N}._-]{1,30})/gu;

  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    const raw = match[0];
    const key = `${match.index}-${raw}`;

    if (raw.startsWith('@[')) {
      const name = raw.slice(2, -1).trim();
      const person = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
      const client = person?.clientId ? clients.find((c) => c.id === person.clientId) : null;
      const tooltip = [person?.role, client?.name].filter(Boolean).join(' · ') || 'Person';
      parts.push(
        <button
          key={key}
          type="button"
          className="pill pill-person"
          title={tooltip}
          onClick={(e) => {
            e.stopPropagation();
            onClickPerson?.(person?.name || name);
          }}
        >
          @{person?.name || name}
        </button>
      );
    } else if (raw.startsWith('@')) {
      const token = raw.slice(1);
      const person =
        people.find((p) => p.name.toLowerCase() === token.toLowerCase()) ||
        people.find((p) => p.name.toLowerCase().split(/\s+/)[0] === token.toLowerCase());
      const client = person?.clientId ? clients.find((c) => c.id === person.clientId) : null;
      const tooltip = [person?.role, client?.name].filter(Boolean).join(' · ') || 'Person';
      parts.push(
        <button
          key={key}
          type="button"
          className="pill pill-person"
          title={tooltip}
          onClick={(e) => {
            e.stopPropagation();
            onClickPerson?.(person?.name || token);
          }}
        >
          @{person?.name || token}
        </button>
      );
    } else if (raw.startsWith('[[')) {
      const targetTitle = raw.slice(2, -2).trim();
      const exists = notes.some((n) => n.title.toLowerCase() === targetTitle.toLowerCase());
      parts.push(
        <button
          key={key}
          type="button"
          className="pill pill-link"
          title={exists ? `Open note: ${targetTitle}` : `Create & open note: ${targetTitle}`}
          onClick={(e) => {
            e.stopPropagation();
            onClickNoteLink?.(targetTitle);
          }}
        >
          ↗ {targetTitle}
        </button>
      );
    } else if (raw.startsWith('#')) {
      const lbl = raw.slice(1).toLowerCase();
      parts.push(
        <button
          key={key}
          type="button"
          className="pill pill-label"
          title={`View #${lbl} topic & notes`}
          onClick={(e) => {
            e.stopPropagation();
            onClickLabel?.(lbl);
          }}
        >
          #{lbl}
        </button>
      );
    }

    lastIdx = match.index + raw.length;
  }

  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }

  return <>{parts}</>;
};
