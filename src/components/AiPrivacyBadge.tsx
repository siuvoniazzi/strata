import React, { useState } from 'react';
import { Check, Copy, Eye, EyeOff, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { AiPrivacyCategory, AiPrivacyReport } from '../types';

const CATEGORY_LABELS: Record<AiPrivacyCategory, string> = {
  PERSON: 'People',
  ORG: 'Companies',
  PROJECT: 'Projects',
  TERM: 'Protected Terms',
  NOTE: 'Note Titles',
  EMAIL: 'Emails',
  PHONE: 'Phones',
  IBAN: 'IBANs',
  URL: 'URLs/Domains',
};

function formatCategorySummary(report: AiPrivacyReport): string {
  const parts: string[] = [];
  for (const [cat, count] of Object.entries(report.countsByCategory) as Array<
    [AiPrivacyCategory, number]
  >) {
    if (count && count > 0) {
      parts.push(`${count} ${CATEGORY_LABELS[cat] || cat}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : 'No sensitive entities detected in prompt';
}

export const AiPrivacyInlineControls: React.FC<{
  report?: AiPrivacyReport;
  isOpen: boolean;
  onToggleOpen: () => void;
  compact?: boolean;
}> = ({ report, isOpen, onToggleOpen, compact = false }) => {
  if (!report) return null;

  const summaryTooltip = report.enabled
    ? `Client-side pseudonymization active (${report.totalReplacements} total replacement${
        report.totalReplacements === 1 ? '' : 's'
      }): ${formatCategorySummary(report)}`
    : 'AI pseudonymization was disabled in Settings for this request.';

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
      <span
        title={summaryTooltip}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: compact ? '1.5px 6px' : '2px 8px',
          borderRadius: 999,
          fontSize: compact ? 10.5 : 11.5,
          fontWeight: 600,
          background: report.enabled ? 'var(--decision-agreed-bg)' : 'var(--status-waiting-bg)',
          color: report.enabled ? 'var(--decision-agreed-text)' : 'var(--status-waiting-text)',
        }}
      >
        {report.enabled ? <ShieldCheck size={11} /> : <ShieldAlert size={11} />}
        <span>
          {report.enabled
            ? report.maskedCount > 0
              ? `Shielded · ${report.maskedCount} masked`
              : 'Shielded · 0 PII'
            : 'Unshielded'}
        </span>
      </span>

      <button
        type="button"
        className={`btn btn-xs ${isOpen ? 'btn-soft' : 'btn-ghost'}`}
        onClick={onToggleOpen}
        style={compact ? { padding: '2px 6px', fontSize: 11 } : undefined}
        title="Inspect the exact sanitized prompt sent to the external AI provider"
      >
        {isOpen ? <EyeOff size={11} /> : <Eye size={11} />}
        <span>{isOpen ? 'Hide Prompt' : compact ? 'Inspect Prompt' : 'Inspect Scrubbed Prompt'}</span>
      </button>
    </span>
  );
};

export const AiPrivacyPromptDrawer: React.FC<{
  report?: AiPrivacyReport;
  isOpen: boolean;
}> = ({ report, isOpen }) => {
  const [copied, setCopied] = useState(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);

  if (!report || !isOpen) return null;

  const combinedText = showSystemPrompt
    ? `=== SYSTEM PROMPT ===\n${report.scrubbedSystemPrompt}\n\n=== USER PROMPT ===\n${report.scrubbedUserPrompt}`
    : report.scrubbedUserPrompt;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(combinedText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const categoryEntries = (
    Object.entries(report.countsByCategory) as Array<[AiPrivacyCategory, number]>
  ).filter(([, count]) => Boolean(count && count > 0));

  return (
    <div
      className="no-print"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-surface-subtle)',
        border: '1px solid var(--border-default)',
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 11.5, color: 'var(--text-primary)' }}>
            {report.enabled ? 'Outbound Sanitized Payload' : 'Outbound Raw Payload (Unshielded)'}
          </strong>
          {report.enabled && categoryEntries.length > 0 && (
            <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
              {categoryEntries.map(([cat, count]) => (
                <span key={cat} className="due-chip" style={{ fontSize: 10.5 }}>
                  {cat}: {count}
                </span>
              ))}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className={`btn btn-xs ${showSystemPrompt ? 'btn-soft' : 'btn-ghost'}`}
            onClick={() => setShowSystemPrompt((v) => !v)}
          >
            {showSystemPrompt ? 'Hide System Rules' : 'Show System Rules'}
          </button>
          <button type="button" className="btn btn-xs" onClick={() => void handleCopy()}>
            {copied ? <Check size={11} /> : <Copy size={11} />}
            <span>{copied ? 'Copied' : 'Copy Scrubbed'}</span>
          </button>
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
        {report.enabled
          ? 'Exact payload transmitted to the AI provider. Real names and PII were replaced locally in RAM and restored after the response arrived.'
          : 'Pseudonymization was turned off in Settings when this request ran.'}
      </div>

      <pre
        className="diff-pane"
        style={{
          margin: 0,
          maxHeight: 220,
          overflowY: 'auto',
          fontSize: 11.5,
          lineHeight: 1.5,
          fontFamily: 'var(--font-mono)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {combinedText}
      </pre>
    </div>
  );
};
