import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Calendar,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  EyeOff,
  FileText,
  FolderKanban,
  Gavel,
  ListChecks,
  MessageSquarePlus,
  Sparkles,
  Star,
  Sun,
  Sunrise,
  X,
} from 'lucide-react';
import type {
  DecisionStatus,
  Note,
  NoteScope,
  ParsedDecision,
  ParsedTask,
  RetroSignalRating,
  TaskHorizonBucket,
  TaskStatus,
  WorkspaceDirectory,
} from '../types';
import {
  addDaysIso,
  computeDailyRetroQueue,
  getDecisionRetroFeedback,
  getNoteRetroFeedback,
  getTaskRetroPlan,
  resolveEffectiveTaskHorizon,
  resolveItemProjectContext,
} from '../utils/dailyRetro';
import {
  getAllNoteLabels,
  parseNoteItems,
  stripMarkdownFormatting,
} from '../utils/markdown';
import { RichInlineText } from './RichInlineText';

type RetroStep = 'notes' | 'tasks' | 'decisions' | 'wrap';

interface DailyRetroModalProps {
  notes: Note[];
  directory: WorkspaceDirectory;
  todayDate: string;
  isRefreshingBriefing?: boolean;
  suspendKeyboard?: boolean;
  onClose: () => void;
  onPreviewNote: (noteId: string) => void;
  onPreviewNoteByTitle?: (noteTitle: string) => void;
  onPreviewProject?: (clientId: string | null, projectId: string | null) => void;
  onRateNote: (noteId: string, rating: RetroSignalRating, comment?: string) => void;
  onTriageTask: (
    task: ParsedTask,
    updates: {
      bucket?: TaskHorizonBucket;
      targetDate?: string | null;
      starred?: boolean;
      comment?: string;
      status?: TaskStatus;
    }
  ) => void;
  onReviewDecision: (
    decision: ParsedDecision,
    updates: {
      rating?: RetroSignalRating;
      comment?: string;
      status?: DecisionStatus;
    }
  ) => void;
  onSaveSteeringNote: (steeringNote: string) => void;
  onCompleteRetro: (steeringNote: string) => Promise<void> | void;
}

const NOTE_COMMENT_CHIPS = [
  'Key client context',
  'Needs follow-up tomorrow',
  'Important milestone',
  'Reference only',
];

const TASK_COMMENT_CHIPS = [
  'First thing tomorrow',
  'Waiting on reply',
  'Quick 15m win',
  'Needs deep work block',
];

const DECISION_COMMENT_CHIPS = [
  'Confirm in next sync',
  'Waiting on stakeholder sign-off',
  'High-impact shift',
];

const STEERING_CHIPS = [
  'Protect morning for deep work',
  'Prioritize client follow-ups first',
  'Surface blockers & waiting items at the top',
  'Keep tomorrow focused on top 3 items only',
];

export const DailyRetroModal: React.FC<DailyRetroModalProps> = ({
  notes,
  directory,
  todayDate,
  isRefreshingBriefing = false,
  suspendKeyboard = false,
  onClose,
  onPreviewNote,
  onPreviewNoteByTitle,
  onPreviewProject,
  onRateNote,
  onTriageTask,
  onReviewDecision,
  onSaveSteeringNote,
  onCompleteRetro,
}) => {
  const [includeRecent48h, setIncludeRecent48h] = useState(false);

  const queue = useMemo(
    () => computeDailyRetroQueue(notes, directory, todayDate, { includeRecent48h }),
    [notes, directory, todayDate, includeRecent48h]
  );

  // Freeze initial IDs per step when opening/toggling window so cards don't vanish mid-tap on a bumpy train
  const [sessionNoteIds, setSessionNoteIds] = useState<string[]>(() =>
    queue.notesQueue.map((n) => n.id)
  );
  const [sessionTaskIds, setSessionTaskIds] = useState<string[]>(() =>
    queue.tasksQueue.map((t) => t.id)
  );
  const [sessionDecisionIds, setSessionDecisionIds] = useState<string[]>(() =>
    queue.decisionsQueue.map((d) => d.id)
  );

  // Append any newly discovered items if user toggles 48h window
  useEffect(() => {
    setSessionNoteIds((prev) => {
      const next = [...prev];
      for (const n of queue.notesQueue) {
        if (!next.includes(n.id)) next.push(n.id);
      }
      return next;
    });
    setSessionTaskIds((prev) => {
      const next = [...prev];
      for (const t of queue.tasksQueue) {
        if (!next.includes(t.id)) next.push(t.id);
      }
      return next;
    });
    setSessionDecisionIds((prev) => {
      const next = [...prev];
      for (const d of queue.decisionsQueue) {
        if (!next.includes(d.id)) next.push(d.id);
      }
      return next;
    });
  }, [queue.notesQueue, queue.tasksQueue, queue.decisionsQueue]);

  // Resolve live objects from latest workspace state while preserving stable card order
  const allParsedMap = useMemo(() => {
    const taskById = new Map<string, ParsedTask>();
    const taskByNoteAndText = new Map<string, ParsedTask>();
    const decById = new Map<string, ParsedDecision>();
    const decByNoteAndText = new Map<string, ParsedDecision>();

    for (const n of notes) {
      const parsed = parseNoteItems(n, directory.people);
      for (const t of parsed.tasks) {
        taskById.set(t.id, t);
        taskByNoteAndText.set(`${t.noteId}::${t.text.toLowerCase()}`, t);
      }
      for (const d of parsed.decisions) {
        decById.set(d.id, d);
        decByNoteAndText.set(`${d.noteId}::${d.text.toLowerCase()}`, d);
      }
    }
    return { taskById, taskByNoteAndText, decById, decByNoteAndText };
  }, [notes, directory.people]);

  const deckNotes = useMemo(
    () =>
      sessionNoteIds
        .map((id) => notes.find((n) => n.id === id))
        .filter((n): n is Note => Boolean(n)),
    [sessionNoteIds, notes]
  );

  const deckTasks = useMemo(
    () =>
      sessionTaskIds
        .map((id) => allParsedMap.taskById.get(id))
        .filter((t): t is ParsedTask => Boolean(t)),
    [sessionTaskIds, allParsedMap]
  );

  const deckDecisions = useMemo(
    () =>
      sessionDecisionIds
        .map((id) => allParsedMap.decById.get(id))
        .filter((d): d is ParsedDecision => Boolean(d)),
    [sessionDecisionIds, allParsedMap]
  );

  const [step, setStep] = useState<RetroStep>(() => {
    if (queue.notesQueue.length > 0 && queue.pendingNotesCount > 0) return 'notes';
    if (queue.tasksQueue.length > 0 && queue.pendingTasksCount > 0) return 'tasks';
    if (queue.decisionsQueue.length > 0 && queue.pendingDecisionsCount > 0) return 'decisions';
    if (queue.notesQueue.length > 0) return 'notes';
    if (queue.tasksQueue.length > 0) return 'tasks';
    if (queue.decisionsQueue.length > 0) return 'decisions';
    return 'wrap';
  });

  const [noteIdx, setNoteIdx] = useState(0);
  const [taskIdx, setTaskIdx] = useState(0);
  const [decIdx, setDecIdx] = useState(0);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [showCommentBox, setShowCommentBox] = useState(false);
  const [showJumpList, setShowJumpList] = useState(false);
  const [showFullNoteBody, setShowFullNoteBody] = useState(false);
  const [steeringDraft, setSteeringDraft] = useState<string>(() => queue.steeringNote);

  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const retroStore = directory.dailyRetro;
  const activeNote = deckNotes[Math.min(noteIdx, Math.max(0, deckNotes.length - 1))];
  const activeTask = deckTasks[Math.min(taskIdx, Math.max(0, deckTasks.length - 1))];
  const activeDecision =
    deckDecisions[Math.min(decIdx, Math.max(0, deckDecisions.length - 1))];

  const activeNoteFeedback = activeNote
    ? getNoteRetroFeedback(retroStore, activeNote.id)
    : undefined;
  const activeTaskPlan = activeTask
    ? getTaskRetroPlan(retroStore, activeTask)
    : undefined;
  const activeDecisionFeedback = activeDecision
    ? getDecisionRetroFeedback(retroStore, activeDecision)
    : undefined;

  const [itemCommentDraft, setItemCommentDraft] = useState('');

  // Sync itemCommentDraft whenever active card changes
  useEffect(() => {
    setShowFullNoteBody(false);
    if (step === 'notes' && activeNote) {
      const existing = getNoteRetroFeedback(retroStore, activeNote.id)?.comment || '';
      setItemCommentDraft(existing);
      setShowCommentBox(Boolean(existing));
    } else if (step === 'tasks' && activeTask) {
      const existing = getTaskRetroPlan(retroStore, activeTask)?.comment || '';
      setItemCommentDraft(existing);
      setShowCommentBox(Boolean(existing));
    } else if (step === 'decisions' && activeDecision) {
      const existing = getDecisionRetroFeedback(retroStore, activeDecision)?.comment || '';
      setItemCommentDraft(existing);
      setShowCommentBox(Boolean(existing));
    }
    // Only reset when switching card identity or step
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, activeNote?.id, activeTask?.id, activeDecision?.id]);

  const advanceNextStepFrom = (current: RetroStep) => {
    if (current === 'notes') {
      if (deckTasks.length > 0) setStep('tasks');
      else if (deckDecisions.length > 0) setStep('decisions');
      else setStep('wrap');
      return;
    }
    if (current === 'tasks') {
      if (deckDecisions.length > 0) setStep('decisions');
      else setStep('wrap');
      return;
    }
    if (current === 'decisions') {
      setStep('wrap');
    }
  };

  const handlePrevCard = () => {
    if (step === 'notes') {
      if (noteIdx > 0) setNoteIdx((i) => i - 1);
    } else if (step === 'tasks') {
      if (taskIdx > 0) setTaskIdx((i) => i - 1);
      else if (deckNotes.length > 0) {
        setStep('notes');
        setNoteIdx(deckNotes.length - 1);
      }
    } else if (step === 'decisions') {
      if (decIdx > 0) setDecIdx((i) => i - 1);
      else if (deckTasks.length > 0) {
        setStep('tasks');
        setTaskIdx(deckTasks.length - 1);
      } else if (deckNotes.length > 0) {
        setStep('notes');
        setNoteIdx(deckNotes.length - 1);
      }
    } else if (step === 'wrap') {
      if (deckDecisions.length > 0) {
        setStep('decisions');
        setDecIdx(deckDecisions.length - 1);
      } else if (deckTasks.length > 0) {
        setStep('tasks');
        setTaskIdx(deckTasks.length - 1);
      } else if (deckNotes.length > 0) {
        setStep('notes');
        setNoteIdx(deckNotes.length - 1);
      }
    }
  };

  const handleNextCard = () => {
    if (step === 'notes') {
      if (noteIdx + 1 < deckNotes.length) setNoteIdx((i) => i + 1);
      else advanceNextStepFrom('notes');
    } else if (step === 'tasks') {
      if (taskIdx + 1 < deckTasks.length) setTaskIdx((i) => i + 1);
      else advanceNextStepFrom('tasks');
    } else if (step === 'decisions') {
      if (decIdx + 1 < deckDecisions.length) setDecIdx((i) => i + 1);
      else advanceNextStepFrom('decisions');
    }
  };

  const triggerAdvanceIfEnabled = () => {
    if (!autoAdvance) return;
    handleNextCard();
  };

  const handleSelectNoteRating = (rating: RetroSignalRating) => {
    if (!activeNote) return;
    onRateNote(activeNote.id, rating, itemCommentDraft);
    triggerAdvanceIfEnabled();
  };

  const handleSelectTaskBucket = (bucket: TaskHorizonBucket, customDate?: string | null) => {
    if (!activeTask) return;
    onTriageTask(activeTask, {
      bucket,
      targetDate: customDate,
      comment: itemCommentDraft,
    });
    triggerAdvanceIfEnabled();
  };

  const handleMarkTaskDone = () => {
    if (!activeTask) return;
    const nextStatus: TaskStatus = activeTask.status === 'done' ? 'todo' : 'done';
    onTriageTask(activeTask, {
      status: nextStatus,
      comment: itemCommentDraft,
    });
    if (nextStatus === 'done') {
      triggerAdvanceIfEnabled();
    }
  };

  const handleSelectDecisionAction = (params: {
    rating?: RetroSignalRating;
    status?: DecisionStatus;
    advance?: boolean;
  }) => {
    if (!activeDecision) return;
    onReviewDecision(activeDecision, {
      rating: params.rating,
      status: params.status,
      comment: itemCommentDraft,
    });
    if (params.advance) {
      triggerAdvanceIfEnabled();
    }
  };

  const commitActiveComment = (nextVal: string) => {
    setItemCommentDraft(nextVal);
    if (step === 'notes' && activeNote) {
      const currentRating = activeNoteFeedback?.rating || 'normal';
      onRateNote(activeNote.id, currentRating, nextVal);
    } else if (step === 'tasks' && activeTask) {
      onTriageTask(activeTask, { comment: nextVal });
    } else if (step === 'decisions' && activeDecision) {
      onReviewDecision(activeDecision, { comment: nextVal });
    }
  };

  const toggleQuickChip = (chip: string, target: 'item' | 'steering') => {
    if (target === 'steering') {
      const current = steeringDraft.trim();
      const next = current.includes(chip)
        ? current
            .replace(chip, '')
            .replace(/\s*;\s*;\s*/g, '; ')
            .replace(/^;\s*|;\s*$/g, '')
            .trim()
        : current
        ? `${current}; ${chip}`
        : chip;
      setSteeringDraft(next);
      onSaveSteeringNote(next);
      return;
    }

    setShowCommentBox(true);
    const current = itemCommentDraft.trim();
    const next = current.includes(chip)
      ? current
          .replace(chip, '')
          .replace(/\s*·\s*·\s*/g, ' · ')
          .replace(/^·\s*|\s*·$/g, '')
          .trim()
      : current
      ? `${current} · ${chip}`
      : chip;
    commitActiveComment(next);
  };

  // Desktop keyboard shortcuts for rapid triage
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (suspendKeyboard) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrevCard();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNextCard();
        return;
      }

      if (step === 'notes' && activeNote) {
        if (e.key === '1') handleSelectNoteRating('high');
        else if (e.key === '2') handleSelectNoteRating('normal');
        else if (e.key === '3') handleSelectNoteRating('low');
      } else if (step === 'tasks' && activeTask) {
        if (e.key === '1') handleSelectTaskBucket('today');
        else if (e.key === '2') handleSelectTaskBucket('tomorrow', addDaysIso(todayDate, 1));
        else if (e.key === '3') handleSelectTaskBucket('this-week');
        else if (e.key === '4') handleSelectTaskBucket('sometime');
        else if (e.key.toLowerCase() === 'x') handleMarkTaskDone();
      } else if (step === 'decisions' && activeDecision) {
        if (e.key === '1') handleSelectDecisionAction({ rating: 'high', advance: true });
        else if (e.key === '2') handleSelectDecisionAction({ rating: 'normal', advance: true });
        else if (e.key === '3') handleSelectDecisionAction({ rating: 'low', advance: true });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Overall progress calculation
  const totalDeckCount = deckNotes.length + deckTasks.length + deckDecisions.length;
  const reviewedDeckCount = useMemo(() => {
    const rNotes = deckNotes.filter(
      (n) => getNoteRetroFeedback(retroStore, n.id)?.reviewedDate === todayDate
    ).length;
    const rTasks = deckTasks.filter(
      (t) =>
        getTaskRetroPlan(retroStore, t)?.reviewedDate === todayDate || t.status === 'done'
    ).length;
    const rDecs = deckDecisions.filter(
      (d) => getDecisionRetroFeedback(retroStore, d)?.reviewedDate === todayDate
    ).length;
    return rNotes + rTasks + rDecs;
  }, [deckNotes, deckTasks, deckDecisions, retroStore, todayDate]);

  const progressPct =
    step === 'wrap'
      ? 100
      : totalDeckCount === 0
      ? 100
      : Math.min(100, Math.round((reviewedDeckCount / totalDeckCount) * 100));

  // Wrap-up horizon summary across workspace
  const wrapStats = useMemo(() => {
    let todayCount = 0;
    let tomorrowCount = 0;
    let thisWeekCount = 0;
    let sometimeCount = 0;
    let completedToday = 0;
    for (const n of notes) {
      const parsed = parseNoteItems(n, directory.people);
      for (const t of parsed.tasks) {
        if (t.status === 'done') {
          if (t.noteDate === todayDate) completedToday++;
          continue;
        }
        const h = resolveEffectiveTaskHorizon(t, retroStore, todayDate);
        if (h === 'today') todayCount++;
        else if (h === 'tomorrow') tomorrowCount++;
        else if (h === 'this-week') thisWeekCount++;
        else sometimeCount++;
      }
    }
    const highSignalToday = Object.values(retroStore?.notes || {}).filter(
      (fb) => fb.reviewedDate === todayDate && fb.rating === 'high'
    ).length;

    return {
      todayCount,
      tomorrowCount,
      thisWeekCount,
      sometimeCount,
      completedToday,
      highSignalToday,
    };
  }, [notes, directory.people, retroStore, todayDate]);

  const onTouchStartStage = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  };

  const onTouchEndStage = (e: React.TouchEvent) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.65) {
      if (dx < 0) handleNextCard();
      else handlePrevCard();
    }
  };

  const tomorrowIso = addDaysIso(todayDate, 1);

  const renderProjectBanner = (item: {
    clientId?: string | null;
    projectId?: string | null;
    scope?: NoteScope;
    noteId?: string;
  }) => {
    const ctx = resolveItemProjectContext(item, directory, notes);
    const canClick =
      Boolean(onPreviewProject) && Boolean(ctx.project || ctx.client);

    const content = (
      <>
        {ctx.color ? (
          <span className="client-dot" style={{ background: ctx.color }} />
        ) : (
          <FolderKanban size={12} style={{ flexShrink: 0 }} />
        )}
        {ctx.spacePrefix ? (
          <>
            <span className="project-stream-prefix">{ctx.spacePrefix} ›</span>
            <strong>{ctx.primaryLabel}</strong>
          </>
        ) : (
          <strong>{ctx.primaryLabel}</strong>
        )}
      </>
    );

    if (canClick) {
      return (
        <button
          type="button"
          className="project-stream-pill is-prominent is-interactive"
          onClick={() =>
            onPreviewProject?.(
              ctx.client ? ctx.client.id : ctx.scope === 'internal' ? '__internal__' : null,
              ctx.project ? ctx.project.id : null
            )
          }
          title={`Preview ${ctx.fullLabel} rollup`}
        >
          {content}
        </button>
      );
    }

    return <span className="project-stream-pill is-prominent">{content}</span>;
  };

  return (
    <div
      className="retro-backdrop no-print"
      role="dialog"
      aria-modal="true"
      aria-label="Daily Retro"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="retro-sheet">
        {/* Top Header & Step Switcher */}
        <div className="retro-header">
          <div className="retro-header-top">
            <div className="retro-title-group">
              <span className="retro-badge-icon">
                <Sparkles size={14} />
              </span>
              <div>
                <div className="retro-title">Daily Retro</div>
                <div className="retro-subtitle">
                  {totalDeckCount > 0
                    ? `${reviewedDeckCount}/${totalDeckCount} triaged · Auto-saved`
                    : 'Ready to steer your brief'}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {step !== 'wrap' && (
                <button
                  type="button"
                  className={`btn btn-xs ${showJumpList ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setShowJumpList((v) => !v)}
                  title="Jump to any item in this step"
                >
                  <ListChecks size={13} />
                  <span>Queue</span>
                </button>
              )}
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={onClose}
                aria-label="Save and close Daily Retro"
              >
                <X size={15} />
                <span>Done</span>
              </button>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="retro-progress-track" aria-hidden="true">
            <div
              className="retro-progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          {/* 4-Step Segmented Pills */}
          <div className="retro-steps" role="tablist" aria-label="Daily Retro Steps">
            <button
              type="button"
              role="tab"
              aria-selected={step === 'notes'}
              className={`retro-step-pill ${step === 'notes' ? 'active' : ''}`}
              onClick={() => {
                setStep('notes');
                setShowJumpList(false);
              }}
            >
              <span>Notes</span>
              <span className="retro-step-count">{deckNotes.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={step === 'tasks'}
              className={`retro-step-pill ${step === 'tasks' ? 'active' : ''}`}
              onClick={() => {
                setStep('tasks');
                setShowJumpList(false);
              }}
            >
              <span>Tasks</span>
              <span className="retro-step-count">{deckTasks.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={step === 'decisions'}
              className={`retro-step-pill ${step === 'decisions' ? 'active' : ''}`}
              onClick={() => {
                setStep('decisions');
                setShowJumpList(false);
              }}
            >
              <span>Decisions</span>
              <span className="retro-step-count">{deckDecisions.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={step === 'wrap'}
              className={`retro-step-pill ${step === 'wrap' ? 'active' : ''}`}
              onClick={() => {
                setStep('wrap');
                setShowJumpList(false);
              }}
            >
              <span>AI Brief</span>
            </button>
          </div>
        </div>

        {/* Optional Quick-Jump Queue Drawer */}
        {showJumpList && step !== 'wrap' && (
          <div className="retro-jump-drawer">
            {step === 'notes' &&
              (deckNotes.length === 0 ? (
                <div className="retro-jump-empty">No notes in queue.</div>
              ) : (
                deckNotes.map((n, idx) => {
                  const fb = getNoteRetroFeedback(retroStore, n.id);
                  const ctx = resolveItemProjectContext(n, directory);
                  return (
                    <button
                      key={n.id}
                      type="button"
                      className={`retro-jump-row ${idx === noteIdx ? 'active' : ''}`}
                      onClick={() => {
                        setNoteIdx(idx);
                        setShowJumpList(false);
                      }}
                    >
                      <span className="retro-jump-title">
                        <strong>[{ctx.primaryLabel}]</strong> {n.title || 'Untitled Note'}
                      </span>
                      <span className="retro-jump-tag">
                        {fb?.reviewedDate === todayDate ? fb.rating.toUpperCase() : 'Pending'}
                      </span>
                    </button>
                  );
                })
              ))}

            {step === 'tasks' &&
              (deckTasks.length === 0 ? (
                <div className="retro-jump-empty">No tasks in queue.</div>
              ) : (
                deckTasks.map((t, idx) => {
                  const plan = getTaskRetroPlan(retroStore, t);
                  const ctx = resolveItemProjectContext(t, directory, notes);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={`retro-jump-row ${idx === taskIdx ? 'active' : ''}`}
                      onClick={() => {
                        setTaskIdx(idx);
                        setShowJumpList(false);
                      }}
                    >
                      <span className="retro-jump-title">
                        <strong>[{ctx.primaryLabel}]</strong> {t.text}
                      </span>
                      <span className="retro-jump-tag">
                        {t.status === 'done'
                          ? 'DONE'
                          : plan
                          ? plan.bucket.toUpperCase()
                          : 'Untriaged'}
                      </span>
                    </button>
                  );
                })
              ))}

            {step === 'decisions' &&
              (deckDecisions.length === 0 ? (
                <div className="retro-jump-empty">No decisions in queue.</div>
              ) : (
                deckDecisions.map((d, idx) => {
                  const fb = getDecisionRetroFeedback(retroStore, d);
                  const ctx = resolveItemProjectContext(d, directory, notes);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      className={`retro-jump-row ${idx === decIdx ? 'active' : ''}`}
                      onClick={() => {
                        setDecIdx(idx);
                        setShowJumpList(false);
                      }}
                    >
                      <span className="retro-jump-title">
                        <strong>[{ctx.primaryLabel}]</strong> {d.text}
                      </span>
                      <span className="retro-jump-tag">
                        {fb ? `${d.status} · ${fb.rating}` : d.status}
                      </span>
                    </button>
                  );
                })
              ))}
          </div>
        )}

        {/* Scrollable Middle Card Stage (Swipeable on Phone) */}
        <div
          className="retro-stage"
          onTouchStart={onTouchStartStage}
          onTouchEnd={onTouchEndStage}
        >
          {/* STEP 1: NOTES */}
          {step === 'notes' && (
            <>
              {!activeNote ? (
                <div className="retro-empty-card">
                  <FileText size={24} style={{ color: 'var(--text-muted)' }} />
                  <strong>No notes captured today yet</strong>
                  <p>
                    Want to review notes from the last 48 hours instead, or jump straight to
                    triaging your open tasks?
                  </p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                    {!includeRecent48h && (
                      <button
                        type="button"
                        className="btn btn-soft"
                        onClick={() => setIncludeRecent48h(true)}
                      >
                        Include Last 48 Hours
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => advanceNextStepFrom('notes')}
                    >
                      Continue to Tasks <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="retro-focus-card">
                  <div className="retro-card-eyebrow">
                    <span>
                      Note {noteIdx + 1} of {deckNotes.length}
                      {queue.usedFallbackWindow ? ' · Last 48h' : ' · Today'}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {activeNoteFeedback?.reviewedDate === todayDate && (
                        <span className="retro-reviewed-pill">
                          <Check size={11} /> Rated: {activeNoteFeedback.rating}
                        </span>
                      )}
                      {!includeRecent48h && (
                        <button
                          type="button"
                          className="retro-link-btn"
                          onClick={() => setIncludeRecent48h(true)}
                        >
                          +48h
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Prominent Project & Space Header */}
                  <div className="retro-project-row">
                    {renderProjectBanner(activeNote)}
                    <span className="due-chip">{activeNote.date}</span>
                  </div>

                  <h2 className="retro-card-headline">
                    {activeNote.title || 'Untitled Note'}
                  </h2>

                  <div className="retro-card-meta">
                    {getAllNoteLabels(activeNote)
                      .slice(0, 3)
                      .map((lbl) => (
                        <span key={lbl} className="pill pill-label">
                          #{lbl}
                        </span>
                      ))}
                    <button
                      type="button"
                      className="pill pill-link"
                      onClick={() => onPreviewNote(activeNote.id)}
                    >
                      <FileText size={11} /> Preview Full Note
                    </button>
                  </div>

                  {(() => {
                    const clean = stripMarkdownFormatting(activeNote.body);
                    const isLong = clean.length > 280;
                    const shown =
                      showFullNoteBody || !isLong ? clean : `${clean.slice(0, 280).trimEnd()}…`;
                    const parsed = parseNoteItems(activeNote, directory.people);
                    return (
                      <>
                        <div className="retro-note-excerpt">
                          {shown || 'Empty note body.'}
                          {isLong && (
                            <button
                              type="button"
                              className="retro-link-btn"
                              style={{ marginLeft: 6 }}
                              onClick={() => setShowFullNoteBody((v) => !v)}
                            >
                              {showFullNoteBody ? 'Show less' : 'Read more'}
                            </button>
                          )}
                        </div>
                        {(parsed.tasks.length > 0 || parsed.decisions.length > 0) && (
                          <div className="retro-extracted-summary">
                            <span>{parsed.tasks.length} task(s)</span>
                            <span>·</span>
                            <span>{parsed.decisions.length} decision(s) inside</span>
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {/* Commuter Quick-Comment & AI Takeaway */}
                  <div className="retro-comment-zone">
                    <div className="retro-comment-header">
                      <button
                        type="button"
                        className="retro-comment-toggle"
                        onClick={() => setShowCommentBox((v) => !v)}
                      >
                        <MessageSquarePlus size={13} />
                        <span>
                          {itemCommentDraft
                            ? 'Takeaway for AI Brief'
                            : 'Add takeaway / comment for AI (optional)'}
                        </span>
                      </button>
                    </div>

                    <div className="retro-chip-scroll">
                      {NOTE_COMMENT_CHIPS.map((chip) => (
                        <button
                          key={chip}
                          type="button"
                          className={`retro-quick-chip ${
                            itemCommentDraft.includes(chip) ? 'selected' : ''
                          }`}
                          onClick={() => toggleQuickChip(chip, 'item')}
                        >
                          {chip}
                        </button>
                      ))}
                    </div>

                    {showCommentBox && (
                      <input
                        type="text"
                        className="form-input retro-comment-input"
                        placeholder="e.g. Client wants revised scope before Friday…"
                        value={itemCommentDraft}
                        onChange={(e) => commitActiveComment(e.target.value)}
                      />
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* STEP 2: TASKS */}
          {step === 'tasks' && (
            <>
              {!activeTask ? (
                <div className="retro-empty-card">
                  <CheckCircle2 size={24} style={{ color: 'var(--status-done-text)' }} />
                  <strong>Zero tasks waiting for triage</strong>
                  <p>Your immediate task horizon is clean.</p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => advanceNextStepFrom('tasks')}
                  >
                    Continue <ArrowRight size={14} />
                  </button>
                </div>
              ) : (
                <div className="retro-focus-card">
                  <div className="retro-card-eyebrow">
                    <span>
                      Task {taskIdx + 1} of {deckTasks.length}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {activeTask.status === 'done' ? (
                        <span className="retro-reviewed-pill">
                          <Check size={11} /> Completed
                        </span>
                      ) : activeTaskPlan ? (
                        <span className="retro-reviewed-pill">
                          <Check size={11} />{' '}
                          {activeTaskPlan.bucket === 'date' && activeTaskPlan.targetDate
                            ? activeTaskPlan.targetDate
                            : activeTaskPlan.bucket}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {/* Prominent Project & Space Header */}
                  <div className="retro-project-row">
                    {renderProjectBanner(activeTask)}
                    <button
                      type="button"
                      className="pill pill-link"
                      onClick={() => onPreviewNote(activeTask.noteId)}
                      title="Preview source note in popup / bottom sheet"
                    >
                      ↗ {activeTask.noteTitle}
                    </button>
                  </div>

                  <div className="retro-task-headline">
                    <RichInlineText
                      text={activeTask.text}
                      people={directory.people}
                      clients={directory.clients}
                      notes={notes}
                      onClickNoteLink={onPreviewNoteByTitle}
                    />
                  </div>

                  <div className="retro-card-meta">
                    {activeTask.owner && (
                      <span className="pill pill-person">@{activeTask.owner}</span>
                    )}
                    {activeTask.dueDate && (
                      <span
                        className={
                          activeTask.dueDate < todayDate && activeTask.status !== 'done'
                            ? 'priority-high'
                            : 'due-chip'
                        }
                      >
                        due {activeTask.dueDate}
                      </span>
                    )}
                    {activeTask.priority === 'high' && (
                      <span className="priority-high">!HIGH</span>
                    )}
                  </div>

                  {/* Quick Status & Star Strip */}
                  <div className="retro-inline-status-bar">
                    <button
                      type="button"
                      className={`retro-mini-toggle ${
                        activeTask.status === 'done' ? 'is-done' : ''
                      }`}
                      onClick={handleMarkTaskDone}
                    >
                      <Check size={13} />
                      <span>{activeTask.status === 'done' ? 'Done ✓' : 'Mark Done'}</span>
                    </button>

                    <button
                      type="button"
                      className={`retro-mini-toggle ${
                        activeTask.status === 'doing' ? 'is-active' : ''
                      }`}
                      onClick={() =>
                        onTriageTask(activeTask, {
                          status: activeTask.status === 'doing' ? 'todo' : 'doing',
                        })
                      }
                    >
                      <span>Doing</span>
                    </button>

                    <button
                      type="button"
                      className={`retro-mini-toggle ${
                        activeTask.status === 'waiting' ? 'is-waiting' : ''
                      }`}
                      onClick={() =>
                        onTriageTask(activeTask, {
                          status: activeTask.status === 'waiting' ? 'todo' : 'waiting',
                        })
                      }
                    >
                      <Clock size={12} />
                      <span>Waiting</span>
                    </button>

                    <button
                      type="button"
                      className={`retro-mini-toggle ${
                        activeTaskPlan?.starred ? 'is-starred' : ''
                      }`}
                      onClick={() =>
                        onTriageTask(activeTask, {
                          starred: !activeTaskPlan?.starred,
                        })
                      }
                      title="Pin to top of Focus"
                    >
                      <Star
                        size={13}
                        fill={activeTaskPlan?.starred ? 'currentColor' : 'none'}
                      />
                      <span>Top Focus</span>
                    </button>
                  </div>

                  {/* Commuter Quick-Comment */}
                  <div className="retro-comment-zone">
                    <div className="retro-comment-header">
                      <button
                        type="button"
                        className="retro-comment-toggle"
                        onClick={() => setShowCommentBox((v) => !v)}
                      >
                        <MessageSquarePlus size={13} />
                        <span>
                          {itemCommentDraft
                            ? 'Task context for AI'
                            : 'Add note for AI (optional)'}
                        </span>
                      </button>
                    </div>

                    <div className="retro-chip-scroll">
                      {TASK_COMMENT_CHIPS.map((chip) => (
                        <button
                          key={chip}
                          type="button"
                          className={`retro-quick-chip ${
                            itemCommentDraft.includes(chip) ? 'selected' : ''
                          }`}
                          onClick={() => toggleQuickChip(chip, 'item')}
                        >
                          {chip}
                        </button>
                      ))}
                    </div>

                    {showCommentBox && (
                      <input
                        type="text"
                        className="form-input retro-comment-input"
                        placeholder="e.g. Blocked until legal signs NDA…"
                        value={itemCommentDraft}
                        onChange={(e) => commitActiveComment(e.target.value)}
                      />
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* STEP 3: DECISIONS */}
          {step === 'decisions' && (
            <>
              {!activeDecision ? (
                <div className="retro-empty-card">
                  <Gavel size={24} style={{ color: 'var(--text-muted)' }} />
                  <strong>No pending or new decisions today</strong>
                  <p>Head to the final step to steer your AI Daily Brief.</p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setStep('wrap')}
                  >
                    Wrap Up &amp; Steer AI <ArrowRight size={14} />
                  </button>
                </div>
              ) : (
                <div className="retro-focus-card">
                  <div className="retro-card-eyebrow">
                    <span>
                      Decision {decIdx + 1} of {deckDecisions.length}
                    </span>
                    {activeDecisionFeedback?.reviewedDate === todayDate && (
                      <span className="retro-reviewed-pill">
                        <Check size={11} /> Reviewed
                      </span>
                    )}
                  </div>

                  {/* Prominent Project & Space Header */}
                  <div className="retro-project-row">
                    {renderProjectBanner(activeDecision)}
                    <button
                      type="button"
                      className="pill pill-link"
                      onClick={() => onPreviewNote(activeDecision.noteId)}
                      title="Preview source note in popup / bottom sheet"
                    >
                      ↗ {activeDecision.noteTitle}
                    </button>
                  </div>

                  <div className="retro-task-headline">
                    <RichInlineText
                      text={activeDecision.text}
                      people={directory.people}
                      clients={directory.clients}
                      notes={notes}
                      onClickNoteLink={onPreviewNoteByTitle}
                    />
                  </div>

                  {activeDecision.rationale && (
                    <div className="decision-rationale">
                      Rationale:{' '}
                      <RichInlineText
                        text={activeDecision.rationale}
                        people={directory.people}
                        clients={directory.clients}
                        notes={notes}
                        onClickNoteLink={onPreviewNoteByTitle}
                      />
                    </div>
                  )}

                  <div className="retro-card-meta">
                    <span className={`status-badge decision-badge-${activeDecision.status}`}>
                      <Gavel size={11} /> {activeDecision.status}
                    </span>
                    <span className="due-chip">{activeDecision.noteDate}</span>
                  </div>

                  {/* Quick Status Switcher */}
                  <div className="retro-inline-status-bar">
                    <button
                      type="button"
                      className={`retro-mini-toggle ${
                        activeDecision.status === 'agreed' ? 'is-done' : ''
                      }`}
                      onClick={() =>
                        handleSelectDecisionAction({ status: 'agreed', advance: false })
                      }
                    >
                      <Check size={13} />
                      <span>Agreed</span>
                    </button>
                    <button
                      type="button"
                      className={`retro-mini-toggle ${
                        activeDecision.status === 'proposed' ? 'is-waiting' : ''
                      }`}
                      onClick={() =>
                        handleSelectDecisionAction({ status: 'proposed', advance: false })
                      }
                    >
                      <span>Needs Sign-off</span>
                    </button>
                    <button
                      type="button"
                      className={`retro-mini-toggle ${
                        activeDecision.status === 'superseded' ? 'is-active' : ''
                      }`}
                      onClick={() =>
                        handleSelectDecisionAction({ status: 'superseded', advance: true })
                      }
                    >
                      <span>Supersede</span>
                    </button>
                  </div>

                  <div className="retro-comment-zone">
                    <div className="retro-comment-header">
                      <button
                        type="button"
                        className="retro-comment-toggle"
                        onClick={() => setShowCommentBox((v) => !v)}
                      >
                        <MessageSquarePlus size={13} />
                        <span>
                          {itemCommentDraft
                            ? 'Decision note for AI'
                            : 'Add sign-off / context note (optional)'}
                        </span>
                      </button>
                    </div>

                    <div className="retro-chip-scroll">
                      {DECISION_COMMENT_CHIPS.map((chip) => (
                        <button
                          key={chip}
                          type="button"
                          className={`retro-quick-chip ${
                            itemCommentDraft.includes(chip) ? 'selected' : ''
                          }`}
                          onClick={() => toggleQuickChip(chip, 'item')}
                        >
                          {chip}
                        </button>
                      ))}
                    </div>

                    {showCommentBox && (
                      <input
                        type="text"
                        className="form-input retro-comment-input"
                        placeholder="e.g. Ask @Sarah to sign off in tomorrow's standup…"
                        value={itemCommentDraft}
                        onChange={(e) => commitActiveComment(e.target.value)}
                      />
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* STEP 4: WRAP-UP & AI STEERING */}
          {step === 'wrap' && (
            <div className="retro-focus-card retro-wrap-card">
              <div className="retro-card-eyebrow">
                <span>Step 4 · Chief-of-Staff Steering</span>
                {queue.isCompletedToday && (
                  <span className="retro-reviewed-pill">
                    <Check size={11} /> Completed today
                  </span>
                )}
              </div>

              <h2 className="retro-card-headline">Your horizons are set</h2>

              <div className="retro-recap-grid">
                <div className="retro-recap-tile is-primary">
                  <span className="retro-recap-num">{wrapStats.todayCount}</span>
                  <span className="retro-recap-lbl">Today&apos;s Focus</span>
                </div>
                <div className="retro-recap-tile">
                  <span className="retro-recap-num">{wrapStats.tomorrowCount}</span>
                  <span className="retro-recap-lbl">Tomorrow</span>
                </div>
                <div className="retro-recap-tile">
                  <span className="retro-recap-num">{wrapStats.thisWeekCount}</span>
                  <span className="retro-recap-lbl">This Week</span>
                </div>
                <div className="retro-recap-tile">
                  <span className="retro-recap-num">{wrapStats.sometimeCount}</span>
                  <span className="retro-recap-lbl">Sometime</span>
                </div>
              </div>

              <div className="form-field" style={{ marginTop: 4 }}>
                <label className="form-label" htmlFor="retro-steering-textarea">
                  Anything your AI Chief-of-Staff should keep in mind?
                </label>
                <div className="retro-chip-scroll">
                  {STEERING_CHIPS.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      className={`retro-quick-chip ${
                        steeringDraft.includes(chip) ? 'selected' : ''
                      }`}
                      onClick={() => toggleQuickChip(chip, 'steering')}
                    >
                      {chip}
                    </button>
                  ))}
                </div>
                <textarea
                  id="retro-steering-textarea"
                  className="form-textarea retro-steering-textarea"
                  rows={3}
                  placeholder="e.g. Travelling until 10am tomorrow — surface quick replies first and hold architecture review for Thursday."
                  value={steeringDraft}
                  onChange={(e) => {
                    setSteeringDraft(e.target.value);
                    onSaveSteeringNote(e.target.value);
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Sticky Bottom Thumb Action Dock */}
        <div className="retro-thumb-dock">
          {step === 'notes' && activeNote && (
            <div className="retro-rating-grid">
              <button
                type="button"
                className={`retro-thumb-btn is-high ${
                  activeNoteFeedback?.rating === 'high' ? 'selected' : ''
                }`}
                onClick={() => handleSelectNoteRating('high')}
              >
                <Star size={16} />
                <span>High Signal</span>
                <small>Highlight in brief</small>
              </button>

              <button
                type="button"
                className={`retro-thumb-btn ${
                  activeNoteFeedback?.rating === 'normal' ? 'selected' : ''
                }`}
                onClick={() => handleSelectNoteRating('normal')}
              >
                <Check size={16} />
                <span>Standard</span>
                <small>Normal context</small>
              </button>

              <button
                type="button"
                className={`retro-thumb-btn is-muted ${
                  activeNoteFeedback?.rating === 'low' ? 'selected' : ''
                }`}
                onClick={() => handleSelectNoteRating('low')}
              >
                <EyeOff size={16} />
                <span>Low / Hide</span>
                <small>Skip in brief</small>
              </button>
            </div>
          )}

          {step === 'tasks' && activeTask && (
            <div className="retro-horizon-dock">
              <div className="retro-horizon-row-top">
                <button
                  type="button"
                  className={`retro-thumb-btn is-today ${
                    activeTaskPlan?.bucket === 'today' ? 'selected' : ''
                  }`}
                  onClick={() => handleSelectTaskBucket('today')}
                >
                  <Sun size={16} />
                  <span>Today</span>
                </button>

                <button
                  type="button"
                  className={`retro-thumb-btn is-tomorrow ${
                    activeTaskPlan?.bucket === 'tomorrow' ? 'selected' : ''
                  }`}
                  onClick={() => handleSelectTaskBucket('tomorrow', tomorrowIso)}
                >
                  <Sunrise size={16} />
                  <span>Tomorrow</span>
                </button>
              </div>

              <div className="retro-horizon-row-bottom">
                <button
                  type="button"
                  className={`retro-thumb-btn ${
                    activeTaskPlan?.bucket === 'this-week' ? 'selected' : ''
                  }`}
                  onClick={() => handleSelectTaskBucket('this-week')}
                >
                  <CalendarClock size={15} />
                  <span>This Week</span>
                </button>

                <button
                  type="button"
                  className={`retro-thumb-btn is-muted ${
                    activeTaskPlan?.bucket === 'sometime' ? 'selected' : ''
                  }`}
                  onClick={() => handleSelectTaskBucket('sometime')}
                >
                  <Archive size={15} />
                  <span>Sometime</span>
                </button>

                <label
                  className={`retro-thumb-btn retro-date-picker-btn ${
                    activeTaskPlan?.bucket === 'date' ? 'selected' : ''
                  }`}
                >
                  <Calendar size={15} />
                  <span>
                    {activeTaskPlan?.bucket === 'date' && activeTaskPlan.targetDate
                      ? activeTaskPlan.targetDate.slice(5)
                      : 'Pick Day'}
                  </span>
                  <input
                    ref={dateInputRef}
                    type="date"
                    className="retro-hidden-date-input"
                    min={todayDate}
                    value={
                      activeTask.dueDate && activeTask.dueDate >= todayDate
                        ? activeTask.dueDate
                        : tomorrowIso
                    }
                    onClick={(e) => {
                      const el = e.currentTarget as HTMLInputElement & {
                        showPicker?: () => void;
                      };
                      try {
                        el.showPicker?.();
                      } catch {
                        // Native mobile tap opens picker directly
                      }
                    }}
                    onChange={(e) => {
                      const picked = e.target.value;
                      if (picked) {
                        handleSelectTaskBucket('date', picked);
                      }
                    }}
                  />
                </label>
              </div>
            </div>
          )}

          {step === 'decisions' && activeDecision && (
            <div className="retro-rating-grid">
              <button
                type="button"
                className={`retro-thumb-btn is-high ${
                  activeDecisionFeedback?.rating === 'high' ? 'selected' : ''
                }`}
                onClick={() => handleSelectDecisionAction({ rating: 'high', advance: true })}
              >
                <Star size={16} />
                <span>Key Decision</span>
                <small>Feature in brief</small>
              </button>

              <button
                type="button"
                className={`retro-thumb-btn ${
                  activeDecisionFeedback?.rating === 'normal' ? 'selected' : ''
                }`}
                onClick={() =>
                  handleSelectDecisionAction({ rating: 'normal', advance: true })
                }
              >
                <Check size={16} />
                <span>Standard</span>
                <small>Keep in radar</small>
              </button>

              <button
                type="button"
                className={`retro-thumb-btn is-muted ${
                  activeDecisionFeedback?.rating === 'low' ? 'selected' : ''
                }`}
                onClick={() => handleSelectDecisionAction({ rating: 'low', advance: true })}
              >
                <EyeOff size={16} />
                <span>Hide</span>
                <small>Mute from brief</small>
              </button>
            </div>
          )}

          {step === 'wrap' && (
            <button
              id="btn-complete-daily-retro"
              type="button"
              className="btn btn-primary retro-finish-btn"
              disabled={isRefreshingBriefing}
              onClick={() => void onCompleteRetro(steeringDraft)}
            >
              <Sparkles size={16} />
              <span>
                {isRefreshingBriefing
                  ? 'Updating Daily Brief…'
                  : 'Complete Retro & Refresh Brief'}
              </span>
            </button>
          )}

          {/* Thumb-Friendly Bottom Nav Row */}
          <div className="retro-dock-nav">
            <button
              type="button"
              className="retro-nav-btn"
              onClick={handlePrevCard}
              disabled={step === 'notes' && noteIdx === 0}
            >
              <ArrowLeft size={14} />
              <span>Back</span>
            </button>

            {step !== 'wrap' ? (
              <label className="retro-autonext-toggle">
                <input
                  type="checkbox"
                  checked={autoAdvance}
                  onChange={(e) => setAutoAdvance(e.target.checked)}
                />
                <span>Auto-next</span>
              </label>
            ) : (
              <span className="retro-Swipe-hint">Saved locally &amp; synced</span>
            )}

            {step !== 'wrap' ? (
              <button type="button" className="retro-nav-btn" onClick={handleNextCard}>
                <span>Skip / Next</span>
                <ArrowRight size={14} />
              </button>
            ) : (
              <button type="button" className="retro-nav-btn" onClick={onClose}>
                <span>Close</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
