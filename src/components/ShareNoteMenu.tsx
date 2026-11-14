import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Download, Mail, MessageCircle, Share2 } from 'lucide-react';
import type { Note, WorkspaceDirectory } from '../types';
import {
  canUseNativeShare,
  copyTextToClipboard,
  downloadNoteMarkdownFile,
  loadShareIncludeMetadataPreference,
  saveShareIncludeMetadataPreference,
  serializeNoteForShare,
  shareNoteViaEmail,
  shareNoteViaSystemSheet,
  shareNoteViaWhatsApp,
} from '../utils/noteShare';

interface ShareNoteMenuProps {
  note: Note;
  directory: WorkspaceDirectory;
  onNotify?: (message: string) => void;
  buttonId?: string;
  buttonClassName?: string;
}

export const ShareNoteMenu: React.FC<ShareNoteMenuProps> = ({
  note,
  directory,
  onNotify,
  buttonId,
  buttonClassName = 'btn btn-xs btn-ghost',
}) => {
  const [open, setOpen] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const [includeMetadata, setIncludeMetadata] = useState<boolean>(() =>
    loadShareIncludeMetadataPreference()
  );
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number }>({
    top: 48,
    right: 16,
  });

  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const updatePosition = useCallback(() => {
    const btn = btnRef.current;
    if (!btn || typeof window === 'undefined') return;
    const rect = btn.getBoundingClientRect();
    const menuWidth = Math.min(284, window.innerWidth - 24);
    const desiredRight = Math.max(12, window.innerWidth - rect.right);
    const maxRight = Math.max(12, window.innerWidth - menuWidth - 12);
    setPopoverPos({
      top: Math.min(window.innerHeight - 260, rect.bottom + 6),
      right: Math.min(desiredRight, maxRight),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };

    const onViewportChange = () => updatePosition();

    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('touchstart', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);

    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('touchstart', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const flashCopied = () => {
    setJustCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setJustCopied(false);
    }, 2200);
  };

  const handleToggleMetadata = (checked: boolean) => {
    setIncludeMetadata(checked);
    saveShareIncludeMetadataPreference(checked);
  };

  const handleEmailShare = async () => {
    setOpen(false);
    const res = await shareNoteViaEmail(note, directory, { includeMetadata });
    if (res.truncated && res.copiedBackup) {
      onNotify?.(
        'Opened Email — note is long, so full Markdown was also copied to clipboard (Ctrl+V)'
      );
    } else if (res.copiedBackup) {
      onNotify?.('Opening Email with Markdown note (also copied to clipboard)');
    } else {
      onNotify?.('Opening Email with Markdown note');
    }
  };

  const handleWhatsAppShare = async () => {
    setOpen(false);
    const res = await shareNoteViaWhatsApp(note, directory, { includeMetadata });
    if (res.truncated && res.copiedBackup) {
      onNotify?.(
        'Opened WhatsApp — note is long, so full Markdown was also copied to clipboard (Ctrl+V)'
      );
    } else if (res.copiedBackup) {
      onNotify?.('Opened WhatsApp with Markdown note (also copied to clipboard)');
    } else {
      onNotify?.('Opened WhatsApp with Markdown note');
    }
  };

  const handleCopyMarkdown = async () => {
    const markdown = serializeNoteForShare(note, directory, { includeMetadata });
    const ok = await copyTextToClipboard(markdown);
    if (ok) {
      flashCopied();
      setOpen(false);
      onNotify?.(
        'Copied note Markdown — paste (Ctrl+V) into a blank note in another client/account'
      );
    } else {
      onNotify?.('Unable to access clipboard — use Download .md File instead');
    }
  };

  const handleDownloadMarkdown = () => {
    const filename = downloadNoteMarkdownFile(note, directory, { includeMetadata });
    setOpen(false);
    onNotify?.(`Downloaded ${filename}`);
  };

  const handleSystemShare = async () => {
    setOpen(false);
    await shareNoteViaSystemSheet(note, directory, { includeMetadata });
  };

  const nativeShareAvailable = canUseNativeShare();

  return (
    <>
      <button
        ref={btnRef}
        id={buttonId}
        type="button"
        className={`${buttonClassName}${open ? ' btn-soft' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Share note as Markdown via Email, WhatsApp, or Clipboard to copy into another client/account"
      >
        {justCopied ? <Check size={13} /> : <Share2 size={13} />}
        <span>{justCopied ? 'Copied!' : 'Share'}</span>
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Share Note as Markdown"
            className="doc-insert-popover share-note-popover no-print"
            style={{
              position: 'fixed',
              top: popoverPos.top,
              right: popoverPos.right,
              zIndex: 260,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="doc-insert-section-title">Share Note (Markdown)</div>

            <button
              type="button"
              role="menuitem"
              className="doc-insert-item share-menu-item"
              onClick={() => void handleEmailShare()}
            >
              <span className="share-menu-item-left">
                <Mail size={14} />
                <span>Share via Email</span>
              </span>
              <span className="share-menu-badge">.md</span>
            </button>

            <button
              type="button"
              role="menuitem"
              className="doc-insert-item share-menu-item"
              onClick={() => void handleWhatsAppShare()}
            >
              <span className="share-menu-item-left">
                <MessageCircle size={14} />
                <span>Share via WhatsApp</span>
              </span>
              <span className="share-menu-badge">.md</span>
            </button>

            <div className="doc-insert-divider" />

            <button
              type="button"
              role="menuitem"
              className="doc-insert-item share-menu-item"
              onClick={() => void handleCopyMarkdown()}
            >
              <span className="share-menu-item-left">
                {justCopied ? <Check size={14} /> : <Copy size={14} />}
                <span>{justCopied ? 'Copied Markdown!' : 'Copy Markdown'}</span>
              </span>
              <span className="share-menu-badge">Ctrl+V</span>
            </button>

            <button
              type="button"
              role="menuitem"
              className="doc-insert-item share-menu-item"
              onClick={handleDownloadMarkdown}
            >
              <span className="share-menu-item-left">
                <Download size={14} />
                <span>Download .md File</span>
              </span>
            </button>

            {nativeShareAvailable && (
              <button
                type="button"
                role="menuitem"
                className="doc-insert-item share-menu-item"
                onClick={() => void handleSystemShare()}
              >
                <span className="share-menu-item-left">
                  <Share2 size={14} />
                  <span>More Apps…</span>
                </span>
              </button>
            )}

            <div className="doc-insert-divider" />

            <label className="share-meta-toggle">
              <input
                type="checkbox"
                checked={includeMetadata}
                onChange={(e) => handleToggleMetadata(e.target.checked)}
              />
              <span className="share-meta-toggle-copy">
                <span className="share-meta-toggle-title">Include Strata metadata</span>
                <span className="share-meta-toggle-sub">
                  Frontmatter for space, client, @people &amp; #labels
                </span>
              </span>
            </label>

            <div className="share-menu-hint">
              Tip: Paste into any blank note in another client/account to restore full metadata &amp; content.
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
