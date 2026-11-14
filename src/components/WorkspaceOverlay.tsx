import React, { useEffect, useRef } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Calendar,
  CornerUpLeft,
  ExternalLink,
  FileText,
  Hash,
  Printer,
  User,
  X,
} from 'lucide-react';
import type {
  AiConfig,
  DecisionStatus,
  Note,
  ParsedDecision,
  ParsedTask,
  TaskStatus,
  WorkspaceDirectory,
} from '../types';
import { extractInlineMentions, getAllNoteLabels } from '../utils/markdown';
import { ReportsView } from './ReportsView';
import { RichMarkdown } from './RichMarkdown';
import { ShareNoteMenu } from './ShareNoteMenu';

export type OverlayEntry =
  | {
      kind: 'report';
      label?: string;
      person?: string;
      clientId?: string;
    }
  | {
      kind: 'note';
      noteId: string;
    };

export function isSameOverlayEntry(a: OverlayEntry | undefined, b: OverlayEntry): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'note' && b.kind === 'note') {
    return a.noteId === b.noteId;
  }
  if (a.kind === 'report' && b.kind === 'report') {
    return (
      (a.label || '').toLowerCase() === (b.label || '').toLowerCase() &&
      (a.person || '').toLowerCase() === (b.person || '').toLowerCase() &&
      (a.clientId || '') === (b.clientId || '')
    );
  }
  return false;
}

export interface WorkspaceOverlayProps {
  stack: OverlayEntry[];
  originNoteId: string;
  originNoteTitle: string;
  notes: Note[];
  directory: WorkspaceDirectory;
  allLabels: string[];
  aiConfig: AiConfig;
  suspendEscape?: boolean;
  onNotify?: (message: string) => void;
  onBack: () => void;
  onClose: () => void;
  onPushEntry: (entry: OverlayEntry) => void;
  onOpenNoteInEditor: (noteId: string) => void;
  onOpenOrPeekNoteByTitle: (noteTitle: string) => void;
  onOpenFullReportsView: (filter: {
    label?: string;
    person?: string;
    clientId?: string;
  }) => void;
  onUpdateTaskStatus: (task: ParsedTask, status: TaskStatus) => void;
  onDeleteTask: (task: ParsedTask) => void;
  onUpdateDecisionStatus: (decision: ParsedDecision, status: DecisionStatus) => void;
  onDeleteDecision: (decision: ParsedDecision) => void;
  onSaveBriefAsNote: (
    title: string,
    body: string,
    clientId: string | null,
    projectId: string | null
  ) => void;
}

export const WorkspaceOverlay: React.FC<WorkspaceOverlayProps> = ({
  stack,
  originNoteId,
  originNoteTitle,
  notes,
  directory,
  allLabels,
  aiConfig,
  suspendEscape = false,
  onNotify,
  onBack,
  onClose,
  onPushEntry,
  onOpenNoteInEditor,
  onOpenOrPeekNoteByTitle,
  onOpenFullReportsView,
  onUpdateTaskStatus,
  onDeleteTask,
  onUpdateDecisionStatus,
  onDeleteDecision,
  onSaveBriefAsNote,
}) => {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const currentEntry = stack[stack.length - 1];

  useEffect(() => {
    if (!currentEntry || suspendEscape) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentEntry, suspendEscape, onClose]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [stack.length, currentEntry]);

  if (!currentEntry) return null;

  const cleanOriginTitle = originNoteTitle.trim() || 'Untitled Note';
  const shortOriginTitle =
    cleanOriginTitle.length > 28
      ? `${cleanOriginTitle.slice(0, 28).trimEnd()}…`
      : cleanOriginTitle;

  const targetNote =
    currentEntry.kind === 'note'
      ? notes.find((n) => n.id === currentEntry.noteId)
      : undefined;

  const renderBadge = () => {
    if (currentEntry.kind === 'note') {
      return (
        <span className="workspace-overlay-badge">
          <FileText size={13} />
          <span>Note Preview</span>
        </span>
      );
    }
    if (currentEntry.person) {
      return (
        <span className="workspace-overlay-badge">
          <User size={13} />
          <span>
            Stakeholder Dossier &amp; Notes · <strong>@{currentEntry.person}</strong>
          </span>
        </span>
      );
    }
    if (currentEntry.label) {
      return (
        <span className="workspace-overlay-badge">
          <Hash size={13} />
          <span>
            Topic Report · <strong>#{currentEntry.label}</strong>
          </span>
        </span>
      );
    }
    if (currentEntry.clientId) {
      const cName =
        directory.clients.find((c) => c.id === currentEntry.clientId)?.name || 'Client';
      return (
        <span className="workspace-overlay-badge">
          <BarChart3 size={13} />
          <span>
            Client Report · <strong>{cName}</strong>
          </span>
        </span>
      );
    }
    return (
      <span className="workspace-overlay-badge">
        <BarChart3 size={13} />
        <span>Executive Report</span>
      </span>
    );
  };

  return (
    <div
      className="workspace-overlay-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Note Context Overlay"
      onClick={onClose}
    >
      <div
        className="workspace-overlay-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky Overlay Navigation Header */}
        <header className="workspace-overlay-header no-print">
          <div className="workspace-overlay-header-left">
            {stack.length > 1 && (
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={onBack}
                title="Go back to previous overlay view"
              >
                <ArrowLeft size={13} />
                Back
              </button>
            )}
            {renderBadge()}
          </div>

          <div className="workspace-overlay-header-right">
            {currentEntry.kind === 'note' && targetNote && (
              <>
                {targetNote.id !== originNoteId && (
                  <button
                    type="button"
                    className="btn btn-xs btn-primary"
                    onClick={() => onOpenNoteInEditor(targetNote.id)}
                    title="Switch the main editor to this note and close overlay"
                  >
                    <ExternalLink size={12} />
                    Open in Editor
                  </button>
                )}
                <ShareNoteMenu
                  note={targetNote}
                  directory={directory}
                  onNotify={onNotify}
                />
                <button
                  type="button"
                  className="btn btn-xs btn-ghost desktop-only"
                  onClick={() => window.print()}
                  title="Print or export PDF"
                >
                  <Printer size={12} />
                  Print
                </button>
              </>
            )}

            {currentEntry.kind === 'report' && (
              <button
                type="button"
                className="btn btn-xs btn-ghost desktop-only"
                onClick={() =>
                  onOpenFullReportsView({
                    label: currentEntry.label,
                    person: currentEntry.person,
                    clientId: currentEntry.clientId,
                  })
                }
                title="Leave current note and open full-page Reports Hub"
              >
                <ExternalLink size={12} />
                Full Reports Hub
              </button>
            )}

            <button
              id="btn-overlay-return-to-note"
              type="button"
              className="btn btn-xs overlay-return-btn"
              onClick={onClose}
              title={`Close overlay and return to "${cleanOriginTitle}" (Esc)`}
            >
              <CornerUpLeft size={13} />
              <span>Back to “{shortOriginTitle}”</span>
              <span className="kbd desktop-only">ESC</span>
            </button>

            <button
              type="button"
              className="btn btn-icon btn-ghost"
              onClick={onClose}
              title="Close overlay (Esc)"
              aria-label="Close overlay"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {/* Scrollable Overlay Content */}
        <div ref={bodyRef} className="workspace-overlay-body">
          {currentEntry.kind === 'report' ? (
            <ReportsView
              key={`overlay-report-${stack.length}-${currentEntry.label || ''}-${currentEntry.person || ''}-${currentEntry.clientId || ''}`}
              notes={notes}
              directory={directory}
              allLabels={allLabels}
              aiConfig={aiConfig}
              initialLabelFilter={currentEntry.label}
              initialClientFilter={currentEntry.clientId}
              initialPersonFilter={currentEntry.person}
              embeddedInOverlay
              activeEditorNoteId={originNoteId}
              onOpenNote={(noteId) => {
                if (noteId === originNoteId) {
                  onClose();
                } else {
                  onPushEntry({ kind: 'note', noteId });
                }
              }}
              onOpenNoteByTitle={onOpenOrPeekNoteByTitle}
              onUpdateTaskStatus={onUpdateTaskStatus}
              onDeleteTask={onDeleteTask}
              onUpdateDecisionStatus={onUpdateDecisionStatus}
              onDeleteDecision={onDeleteDecision}
              onSaveBriefAsNote={onSaveBriefAsNote}
            />
          ) : !targetNote ? (
            <div className="overlay-note-sheet">
              <div className="surface-panel" style={{ alignItems: 'flex-start' }}>
                <strong>Note no longer exists</strong>
                <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                  This note may have been deleted from the workspace.
                </span>
                <button type="button" className="btn btn-xs btn-soft" onClick={onClose}>
                  Return to “{shortOriginTitle}”
                </button>
              </div>
            </div>
          ) : (
            (() => {
              const noteClient = targetNote.clientId
                ? directory.clients.find((c) => c.id === targetNote.clientId)
                : undefined;
              const noteProject = targetNote.projectId
                ? directory.projects.find((p) => p.id === targetNote.projectId)
                : undefined;
              const noteLabels = getAllNoteLabels(targetNote);
              const notePeople = Array.from(
                new Set([
                  ...targetNote.participants,
                  ...extractInlineMentions(targetNote.body, directory.people),
                ])
              );

              return (
                <article className="overlay-note-sheet">
                  <div className="overlay-note-header">
                    <h1 className="overlay-note-title">
                      {targetNote.title || 'Untitled Note'}
                    </h1>

                    <div className="overlay-note-meta">
                      <span className="due-chip">
                        <Calendar size={11} /> {targetNote.date}
                      </span>

                      {noteClient ? (
                        <button
                          type="button"
                          className="context-chip"
                          onClick={() =>
                            onPushEntry({ kind: 'report', clientId: noteClient.id })
                          }
                          title={`Open ${noteClient.name} report in overlay`}
                        >
                          <span
                            className="client-dot"
                            style={{ background: noteClient.color }}
                          />
                          {noteClient.name}
                          {noteProject ? ` · ${noteProject.name}` : ''}
                        </button>
                      ) : targetNote.scope === 'internal' ? (
                        <span className="context-chip" style={{ cursor: 'default' }}>
                          Internal Workspace{noteProject ? ` · ${noteProject.name}` : ''}
                        </span>
                      ) : (
                        <span className="context-chip" style={{ cursor: 'default' }}>
                          Inbox
                        </span>
                      )}

                      {notePeople.map((pName) => (
                        <button
                          key={`np-${pName}`}
                          type="button"
                          className="pill pill-person"
                          onClick={() => onPushEntry({ kind: 'report', person: pName })}
                          title={`Open @${pName} dossier & notes in overlay`}
                        >
                          @{pName}
                        </button>
                      ))}

                      {noteLabels.map((lbl) => (
                        <button
                          key={`nl-${lbl}`}
                          type="button"
                          className="pill pill-label"
                          onClick={() => onPushEntry({ kind: 'report', label: lbl })}
                          title={`Open #${lbl} topic report in overlay`}
                        >
                          #{lbl}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="overlay-note-body">
                    {targetNote.body.trim() ? (
                      <RichMarkdown
                        markdown={targetNote.body}
                        people={directory.people}
                        clients={directory.clients}
                        notes={notes}
                        onClickPerson={(pName) =>
                          onPushEntry({ kind: 'report', person: pName })
                        }
                        onClickLabel={(lbl) =>
                          onPushEntry({ kind: 'report', label: lbl })
                        }
                        onClickNoteLink={onOpenOrPeekNoteByTitle}
                      />
                    ) : (
                      <div className="overlay-empty-note">
                        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13.5 }}>
                          This note does not have any content yet.
                        </p>
                        {targetNote.id !== originNoteId && (
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => onOpenNoteInEditor(targetNote.id)}
                          >
                            <ExternalLink size={14} />
                            Open in Editor to Start Writing
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              );
            })()
          )}
        </div>
      </div>
    </div>
  );
};
