import type { Note, WorkspaceDirectory } from '../types';

export const NOTE_TEMPLATES: Array<{
  id: string;
  label: string;
  titlePrefix: string;
  body: string;
}> = [
  {
    id: 'blank',
    label: 'Blank Note',
    titlePrefix: '',
    body: '',
  },
  {
    id: 'client-meeting',
    label: 'Client Meeting',
    titlePrefix: 'Client Sync — ',
    body: [
      '## Context & Agenda',
      '- ',
      '',
      '## Discussion Notes',
      '- ',
      '',
      '## Decisions',
      '- [D:agreed] ',
      '',
      '## Action Items',
      '- [ ] ',
    ].join('\n'),
  },
  {
    id: 'one-on-one',
    label: '1:1 Check-in',
    titlePrefix: '1:1 — ',
    body: [
      '## Top of Mind',
      '- ',
      '',
      '## Progress & Blockers',
      '- ',
      '',
      '## Decisions & Agreements',
      '- [D:agreed] ',
      '',
      '## Follow-ups',
      '- [ ] ',
    ].join('\n'),
  },
  {
    id: 'decision-memo',
    label: 'Decision Memo',
    titlePrefix: 'Decision — ',
    body: [
      '## Problem & Context',
      '- ',
      '',
      '## Options Considered',
      '- Option A: ',
      '- Option B: ',
      '',
      '## Decision',
      '- [D:proposed] ',
      '  > Rationale: ',
      '',
      '## Implementation Tasks',
      '- [ ] ',
    ].join('\n'),
  },
];

const LEGACY_DEMO_NOTE_IDS = new Set([
  'note-northstar-today',
  'note-northstar-kickoff',
  'note-helios-intake',
  'note-internal-ops',
]);

const LEGACY_DEMO_CLIENT_IDS = new Set(['client-northstar', 'client-helios']);

const LEGACY_DEMO_PROJECT_IDS = new Set([
  'proj-sso-cutover',
  'proj-wealth-portal',
  'proj-patient-intake',
  'proj-platform-ops',
]);

const LEGACY_DEMO_PERSON_IDS = new Set([
  'person-sarah-chen',
  'person-marcus-weber',
  'person-elena-rostova',
  'person-david-kim',
  'person-claire-dubois',
]);

const LEGACY_DEMO_LABELS = new Set([
  'security',
  'sso',
  'pricing',
  'architecture',
  'q4-launch',
  'compliance',
  'risk',
]);

export function createBlankInitialNote(): Note {
  const now = new Date();
  const iso = now.toISOString();
  return {
    id: `note-${now.getTime().toString(36)}`,
    title: '',
    date: iso.slice(0, 10),
    scope: 'inbox',
    clientId: null,
    projectId: null,
    participants: [],
    labels: [],
    body: '',
    createdAt: iso,
    updatedAt: iso,
  };
}

export function createSeedWorkspace(): { notes: Note[]; directory: WorkspaceDirectory } {
  return {
    notes: [createBlankInitialNote()],
    directory: {
      clients: [],
      projects: [],
      people: [],
      customLabels: [],
    },
  };
}

/**
 * Automatically purges legacy v1 demo records from IndexedDB while preserving any user-created notes & entities.
 */
export function purgeLegacyDemoData(
  notes: Note[],
  directory: WorkspaceDirectory
): { notes: Note[]; directory: WorkspaceDirectory; didPurge: boolean } {
  const filteredNotes = notes.filter((n) => !LEGACY_DEMO_NOTE_IDS.has(n.id));
  const filteredClients = directory.clients.filter((c) => !LEGACY_DEMO_CLIENT_IDS.has(c.id));
  const filteredProjects = directory.projects.filter((p) => !LEGACY_DEMO_PROJECT_IDS.has(p.id));
  const filteredPeople = directory.people.filter((p) => !LEGACY_DEMO_PERSON_IDS.has(p.id));
  const filteredLabels = directory.customLabels.filter((l) => !LEGACY_DEMO_LABELS.has(l));

  const didPurge =
    filteredNotes.length !== notes.length ||
    filteredClients.length !== directory.clients.length ||
    filteredProjects.length !== directory.projects.length ||
    filteredPeople.length !== directory.people.length ||
    filteredLabels.length !== directory.customLabels.length;

  return {
    notes: filteredNotes.length > 0 ? filteredNotes : [createBlankInitialNote()],
    directory: {
      clients: filteredClients,
      projects: filteredProjects,
      people: filteredPeople,
      customLabels: filteredLabels,
    },
    didPurge,
  };
}
