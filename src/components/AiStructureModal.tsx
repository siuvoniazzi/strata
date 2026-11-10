import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  KeyRound,
  Loader2,
  Maximize2,
  PanelLeft,
  Plus,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  AiConfig,
  AiProviderType,
  AiStructureProposal,
  Note,
  WorkspaceDirectory,
  WorkspacePreferences,
} from '../types';
import { normalizeSensitiveTerms } from '../utils/aiPrivacy';
import { formatAiEngineLabel, generateStructureProposal, saveAiConfig } from '../utils/aiProvider';
import { normalizeStructuredMarkdown, serializeTaskLine } from '../utils/markdown';
import { saveWorkspacePreferences } from '../utils/preferences';
import { AiLoadingState } from './AiLoadingState';
import { AiPrivacyInlineControls, AiPrivacyPromptDrawer } from './AiPrivacyBadge';
import { RichMarkdown } from './RichMarkdown';

interface AiStructureModalProps {
  note: Note;
  allNotes?: Note[];
  directory: WorkspaceDirectory;
  aiConfig: AiConfig;
  onClose: () => void;
  onApply: (updated: Note, newParticipants: string[]) => void;
  onOpenAiSettings: () => void;
}

export const AiStructureModal: React.FC<AiStructureModalProps> = ({
  note,
  allNotes = [],
  directory,
  aiConfig,
  onClose,
  onApply,
  onOpenAiSettings,
}) => {
  const [loading, setLoading] = useState(true);
  const [proposal, setProposal] = useState<AiStructureProposal | null>(null);
  const [applyMetadata, setApplyMetadata] = useState(true);
  const [bodyMode, setBodyMode] = useState<'append' | 'replace' | 'none'>('replace');
  const [showRawDiff, setShowRawDiff] = useState(false);
  const [showPrivacyPrompt, setShowPrivacyPrompt] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    generateStructureProposal(note, directory, aiConfig).then((res) => {
      if (active) {
        setProposal(res);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [note, directory, aiConfig]);

  const handleConfirm = () => {
    if (!proposal) return;
    let nextBody = note.body;

    if (bodyMode === 'replace') {
      nextBody = normalizeStructuredMarkdown(proposal.restructuredBody);
    } else if (bodyMode === 'append') {
      const additions: string[] = [];
      if (proposal.extractedDecisions.length > 0) {
        additions.push(
          '## Extracted Decisions',
          ...proposal.extractedDecisions.map((d) => `- [D:${d.status}] ${d.text}`)
        );
      }
      if (proposal.extractedTasks.length > 0) {
        additions.push(
          '## Extracted Tasks',
          ...proposal.extractedTasks.map((t) =>
            serializeTaskLine({
              status: 'todo',
              text: t.text,
              owner: t.owner,
              dueDate: t.dueDate,
              priority: t.priority,
              labels: t.labels,
            })
          )
        );
      }
      if (additions.length > 0) {
        nextBody = normalizeStructuredMarkdown(`${additions.join('\n')}\n\n---\n\n${note.body}`);
      } else {
        nextBody = normalizeStructuredMarkdown(note.body);
      }
    } else {
      nextBody = normalizeStructuredMarkdown(note.body);
    }

    const updated: Note = {
      ...note,
      title: applyMetadata ? proposal.suggestedTitle : note.title,
      scope: applyMetadata ? proposal.suggestedScope : note.scope,
      clientId: applyMetadata ? proposal.suggestedClientId : note.clientId,
      projectId: applyMetadata ? proposal.suggestedProjectId : note.projectId,
      participants: applyMetadata
        ? Array.from(new Set([...note.participants, ...proposal.suggestedParticipants]))
        : note.participants,
      labels: applyMetadata
        ? Array.from(new Set([...note.labels, ...proposal.suggestedLabels]))
        : note.labels,
      body: nextBody,
      updatedAt: new Date().toISOString(),
    };

    onApply(updated, applyMetadata ? proposal.suggestedParticipants : []);
  };

  const handleCopyCopilotPrompt = () => {
    const prompt = [
      'Structure the following meeting note into clean Markdown using:',
      '- @[Full Name] for people mentions',
      '- #label for topics',
      '- "- [ ] Action item @[Owner] due:YYYY-MM-DD" for tasks (top-level line, never double-bulleted like "- - [ ]")',
      '- "- [D:agreed] Decision statement" or "- [D:proposed] Decision statement" for decisions (top-level line, never double-bulleted)',
      '',
      `Title: ${note.title}`,
      `Date: ${note.date}`,
      note.body,
    ].join('\n');
    navigator.clipboard.writeText(prompt);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 1800);
  };

  const suggestedClientName = proposal?.suggestedClientId
    ? directory.clients.find((c) => c.id === proposal.suggestedClientId)?.name
    : null;
  const suggestedProjectName = proposal?.suggestedProjectId
    ? directory.projects.find((p) => p.id === proposal.suggestedProjectId)?.name
    : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={16} />
            <strong>Structure &amp; Extract — Review Before Applying</strong>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn btn-xs ${showRawDiff ? 'btn-soft' : 'btn-ghost'}`}
              onClick={() => setShowRawDiff((v) => !v)}
              title="Toggle raw Markdown view"
            >
              <Code2 size={12} /> {showRawDiff ? 'Formatted View' : 'Raw .md'}
            </button>
            <button type="button" className="btn btn-xs" onClick={handleCopyCopilotPrompt}>
              {copiedPrompt ? <Check size={12} /> : <Copy size={12} />}
              {copiedPrompt ? 'Copied' : 'Copy Prompt'}
            </button>
            <button type="button" className="btn btn-xs btn-ghost" onClick={onOpenAiSettings}>
              <KeyRound size={12} /> AI Engine
            </button>
            <button type="button" className="btn btn-icon btn-ghost" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="modal-body">
          {loading || !proposal ? (
            <AiLoadingState
              title="Analyzing & structuring note…"
              subtitle="Detecting @people, Client/Project context, #labels, implicit decisions, and tasks"
              providerLabel={formatAiEngineLabel(aiConfig)}
            />
          ) : (
            <>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-surface-subtle)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 12,
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>
                    Engine: <strong>{proposal.usedProvider}</strong>
                  </span>
                  <AiPrivacyInlineControls
                    report={proposal.privacyReport}
                    isOpen={showPrivacyPrompt}
                    onToggleOpen={() => setShowPrivacyPrompt((v) => !v)}
                  />
                </span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={applyMetadata}
                    onChange={(e) => setApplyMetadata(e.target.checked)}
                  />
                  Apply inferred Header Metadata (Title, Client/Project, Participants, #Labels)
                </label>
              </div>

              <AiPrivacyPromptDrawer report={proposal.privacyReport} isOpen={showPrivacyPrompt} />

              {/* Proposed Metadata Summary */}
              <div className="radar-card" style={{ gap: 6 }}>
                <div style={{ fontSize: 12.5 }}>
                  <strong>Title:</strong> {proposal.suggestedTitle}
                </div>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }}>
                  <span>
                    <strong>Space:</strong>{' '}
                    {suggestedClientName
                      ? `Client: ${suggestedClientName}`
                      : proposal.suggestedScope === 'internal'
                      ? 'Internal'
                      : 'Inbox'}
                    {suggestedProjectName ? ` → ${suggestedProjectName}` : ''}
                  </span>
                  <span>
                    <strong>Participants:</strong>{' '}
                    {proposal.suggestedParticipants.length > 0
                      ? proposal.suggestedParticipants.map((p) => `@${p}`).join(', ')
                      : 'None detected'}
                  </span>
                  <span>
                    <strong>Labels:</strong>{' '}
                    {proposal.suggestedLabels.length > 0
                      ? proposal.suggestedLabels.map((l) => `#${l}`).join(' ')
                      : 'None'}
                  </span>
                </div>
              </div>

              {/* Extracted Decisions & Tasks Count */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="pill pill-link">
                  {proposal.extractedDecisions.length} newly detected implicit Decision(s)
                </span>
                <span className="pill pill-person">
                  {proposal.extractedTasks.length} newly detected implicit Task(s)
                </span>
              </div>

              {/* Body Mode Selector */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={`btn btn-xs ${bodyMode === 'replace' ? 'btn-primary' : ''}`}
                  onClick={() => setBodyMode('replace')}
                >
                  Restructure into Clean Sections (Recommended)
                </button>
                <button
                  type="button"
                  className={`btn btn-xs ${bodyMode === 'append' ? 'btn-primary' : ''}`}
                  onClick={() => setBodyMode('append')}
                >
                  Prepend Extracted Tasks/Decisions (Keep Raw Text Intact)
                </button>
                <button
                  type="button"
                  className={`btn btn-xs ${bodyMode === 'none' ? 'btn-primary' : ''}`}
                  onClick={() => setBodyMode('none')}
                >
                  Metadata Only (Don't Change Note Body)
                </button>
              </div>

              {/* Side-by-Side Diff Preview */}
              <div className="diff-grid">
                <div>
                  <div className="form-label" style={{ marginBottom: 4 }}>
                    Current Note Body
                  </div>
                  {showRawDiff ? (
                    <div className="diff-pane">{note.body || '(Empty)'}</div>
                  ) : (
                    <div className="diff-pane diff-pane-rich">
                      {note.body.trim() ? (
                        <RichMarkdown
                          markdown={note.body}
                          people={directory.people}
                          clients={directory.clients}
                          notes={allNotes}
                          compact
                        />
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>(Empty)</span>
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <div className="form-label" style={{ marginBottom: 4 }}>
                    Proposed Structured Note
                  </div>
                  {showRawDiff ? (
                    <div className="diff-pane">{proposal.restructuredBody}</div>
                  ) : (
                    <div className="diff-pane diff-pane-rich">
                      <RichMarkdown
                        markdown={proposal.restructuredBody}
                        people={directory.people}
                        clients={directory.clients}
                        notes={allNotes}
                        compact
                      />
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={loading || !proposal}
            onClick={handleConfirm}
          >
            {loading ? (
              <>
                <Loader2 size={13} className="ai-spin" />
                Analyzing…
              </>
            ) : (
              'Apply Selected Changes'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AiSettingsModalProps {
  config: AiConfig;
  preferences: WorkspacePreferences;
  sensitiveTerms?: string[];
  onSave: (next: AiConfig) => void;
  onSavePreferences: (next: WorkspacePreferences) => void;
  onSaveSensitiveTerms?: (nextTerms: string[]) => void;
  onClose: () => void;
}

export const AiSettingsModal: React.FC<AiSettingsModalProps> = ({
  config,
  preferences,
  sensitiveTerms = [],
  onSave,
  onSavePreferences,
  onSaveSensitiveTerms,
  onClose,
}) => {
  const [draft, setDraft] = useState<AiConfig>({
    ...config,
    pseudonymize: config.pseudonymize !== false,
  });
  const [draftPrefs, setDraftPrefs] = useState<WorkspacePreferences>(preferences);
  const [draftTerms, setDraftTerms] = useState<string[]>(() =>
    normalizeSensitiveTerms(sensitiveTerms)
  );
  const [termInput, setTermInput] = useState('');

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleProviderSelect = (provider: AiProviderType) => {
    const defaultModel: Record<AiProviderType, string> = {
      local: 'deterministic-v1',
      openai: 'gpt-4o-mini',
      azure: 'gpt-4o',
      gemini: 'gemini-2.5-flash',
      anthropic: 'claude-3-5-haiku-latest',
    };
    setDraft({
      ...draft,
      provider,
      model: defaultModel[provider],
      baseUrl: provider === 'openai' ? 'https://api.openai.com/v1' : draft.baseUrl,
    });
  };

  const commitTermInput = (raw: string) => {
    const parts = raw
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    if (parts.length === 0) return;
    setDraftTerms((prev) => normalizeSensitiveTerms([...prev, ...parts]));
    setTermInput('');
  };

  const handleRemoveTerm = (target: string) => {
    setDraftTerms((prev) => prev.filter((t) => t.toLowerCase() !== target.toLowerCase()));
  };

  const isPseudonymized = draft.pseudonymize !== false;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Settings size={16} />
            <strong>Workspace &amp; AI Settings</strong>
          </div>
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* Focus & Initial Startup Behavior */}
          <div className="settings-section">
            <div className="settings-section-title">
              <Maximize2 size={13} />
              <span>Focus Mode &amp; Initial Behavior</span>
            </div>

            <div className="form-field">
              <span className="form-label">Initial View (When Opening Home URL)</span>
              <div className="settings-choice-grid" role="radiogroup" aria-label="Initial workspace view">
                <button
                  type="button"
                  role="radio"
                  aria-checked={draftPrefs.startupLayout === 'focus'}
                  className={`settings-choice-card ${
                    draftPrefs.startupLayout === 'focus' ? 'selected' : ''
                  }`}
                  onClick={() =>
                    setDraftPrefs({ ...draftPrefs, startupLayout: 'focus' })
                  }
                >
                  <div className="settings-choice-header">
                    <Maximize2 size={14} />
                    <span>Focus Mode</span>
                    <span className="settings-default-pill">Default</span>
                  </div>
                  <span className="settings-choice-desc">
                    Hide all side panels and open directly into a centered note.
                  </span>
                </button>

                <button
                  type="button"
                  role="radio"
                  aria-checked={draftPrefs.startupLayout === 'standard'}
                  className={`settings-choice-card ${
                    draftPrefs.startupLayout === 'standard' ? 'selected' : ''
                  }`}
                  onClick={() =>
                    setDraftPrefs({ ...draftPrefs, startupLayout: 'standard' })
                  }
                >
                  <div className="settings-choice-header">
                    <PanelLeft size={14} />
                    <span>Standard Workspace</span>
                  </div>
                  <span className="settings-choice-desc">
                    Show Left Navigation, Note List, and Context Radar on launch.
                  </span>
                </button>
              </div>
            </div>

            <label className="settings-toggle-row" htmlFor="pref-focus-on-new-note">
              <input
                id="pref-focus-on-new-note"
                type="checkbox"
                checked={draftPrefs.focusOnNewNote}
                onChange={(e) =>
                  setDraftPrefs({ ...draftPrefs, focusOnNewNote: e.target.checked })
                }
              />
              <div className="settings-toggle-copy">
                <span className="settings-toggle-label">
                  Automatically enter Focus Mode when opening a new note
                </span>
                <span className="settings-toggle-desc">
                  Centers the note and hides side panels whenever you spin up a new note (<code>Alt+N</code>). Press{' '}
                  <code>Alt+Z</code> anytime to toggle panels.
                </span>
              </div>
            </label>
          </div>

          {/* AI Engine & Corporate Compliance */}
          <div className="settings-section">
            <div className="settings-section-title">
              <ShieldCheck size={13} />
              <span>AI Engine &amp; Data Protection</span>
            </div>

            <div
              style={{
                padding: '9px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-surface-subtle)',
                border: '1px solid var(--border-subtle)',
                fontSize: 12,
                color: 'var(--text-secondary)',
              }}
            >
              <strong>Local-Only Key Storage:</strong> API keys stay exclusively in this browser's{' '}
              <code>localStorage</code> and are <strong>never</strong> written into synced OneDrive/Drive{' '}
              <code>.md</code> or <code>.zip</code> files. When set to <em>Local Smart Engine</em>, zero note text
              leaves your laptop.
            </div>

            <label className="settings-toggle-row" htmlFor="pref-ai-pseudonymize">
              <input
                id="pref-ai-pseudonymize"
                type="checkbox"
                checked={isPseudonymized}
                onChange={(e) =>
                  setDraft({ ...draft, pseudonymize: e.target.checked })
                }
              />
              <div className="settings-toggle-copy">
                <span
                  className="settings-toggle-label"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                >
                  <span>Pseudonymize personal data, companies &amp; projects before AI requests</span>
                  <span className="settings-default-pill">Default</span>
                </span>
                <span className="settings-toggle-desc">
                  Replaces known clients, projects, people, custom terms, and PII (emails, phones, IBANs, URLs, legal
                  entities like AG/GmbH/Inc) with ephemeral tokens (<code>PERSON_01</code>, <code>ORG_01</code>,{' '}
                  <code>PROJECT_01</code>) in RAM before calling external LLMs, then restores real names locally.
                </span>
              </div>
            </label>

            {!isPseudonymized && (
              <div
                role="alert"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '9px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--status-waiting-bg)',
                  color: 'var(--status-waiting-text)',
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  <strong>Unshielded Outbound AI:</strong> Raw personal names, client names, project titles, and
                  contact details in your notes will be sent directly to the configured provider. Only disable this for
                  approved corporate tenants or local <code>localhost</code> gateways.
                </div>
              </div>
            )}

            <div className="form-field">
              <label className="form-label" htmlFor="custom-sensitive-term-input">
                Custom Protected Terms (Synced Across Devices)
              </label>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 4 }}>
                Add your own company name, internal codenames, or unlisted prospects to always mask as{' '}
                <code>TERM_01</code>… Synced in <code>_strata/directory.json</code> across paired devices.
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  id="custom-sensitive-term-input"
                  type="text"
                  className="form-input"
                  style={{ flex: 1 }}
                  placeholder="e.g., Acme Advisory AG, Project Apollo (comma-separated)…"
                  value={termInput}
                  onChange={(e) => setTermInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitTermInput(termInput);
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={termInput.trim().length < 2}
                  onClick={() => commitTermInput(termInput)}
                >
                  <Plus size={13} /> Add
                </button>
              </div>

              {draftTerms.length > 0 && (
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                  {draftTerms.map((term) => (
                    <span key={term} className="pill pill-label" style={{ cursor: 'default' }}>
                      <span>{term}</span>
                      <button
                        type="button"
                        className="pill-remove"
                        aria-label={`Remove ${term}`}
                        onClick={() => handleRemoveTerm(term)}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="form-field">
              <label className="form-label">Provider</label>
              <select
                className="form-input"
                value={draft.provider}
                onChange={(e) => handleProviderSelect(e.target.value as AiProviderType)}
              >
                <option value="local">Local Smart Engine (Default — 100% Offline, Zero API Key)</option>
                <option value="azure">Azure OpenAI Service (Corporate Approved Tenant)</option>
                <option value="openai">OpenAI / Corporate OpenAI-Compatible Gateway</option>
                <option value="gemini">Google Gemini API</option>
                <option value="anthropic">Anthropic Claude API</option>
              </select>
            </div>

            {draft.provider !== 'local' && (
              <>
                {(draft.provider === 'openai' || draft.provider === 'azure') && (
                  <div className="form-field">
                    <label className="form-label">
                      {draft.provider === 'azure'
                        ? 'Azure Resource Endpoint (e.g., https://my-corp.openai.azure.com)'
                        : 'Base URL (OpenAI or Internal Corporate Gateway)'}
                    </label>
                    <input
                      type="text"
                      className="form-input"
                      value={draft.baseUrl || ''}
                      placeholder={
                        draft.provider === 'azure'
                          ? 'https://your-company.openai.azure.com'
                          : 'https://api.openai.com/v1'
                      }
                      onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                    />
                  </div>
                )}

                {draft.provider === 'azure' ? (
                  <div className="form-field">
                    <label className="form-label">Azure Deployment Name</label>
                    <input
                      type="text"
                      className="form-input"
                      value={draft.azureDeployment || ''}
                      placeholder="gpt-4o"
                      onChange={(e) => setDraft({ ...draft, azureDeployment: e.target.value })}
                    />
                  </div>
                ) : (
                  <div className="form-field">
                    <label className="form-label">Model Name</label>
                    <input
                      type="text"
                      className="form-input"
                      value={draft.model}
                      onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                    />
                  </div>
                )}

                <div className="form-field">
                  <label className="form-label">API Key</label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder="Paste approved API key…"
                    value={draft.apiKey}
                    onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const pendingParts = termInput
                .split(/[,;\n]+/)
                .map((s) => s.trim())
                .filter((s) => s.length >= 2);
              const finalTerms = normalizeSensitiveTerms([...draftTerms, ...pendingParts]);
              onSaveSensitiveTerms?.(finalTerms);
              saveWorkspacePreferences(draftPrefs);
              onSavePreferences(draftPrefs);
              saveAiConfig(draft);
              onSave(draft);
              onClose();
            }}
          >
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
};
