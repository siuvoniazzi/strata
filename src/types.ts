export type NoteScope = 'inbox' | 'internal' | 'client';

export type TaskStatus = 'todo' | 'doing' | 'waiting' | 'done';
export type TaskPriority = 'high' | 'medium' | 'low';
export type DecisionStatus = 'agreed' | 'proposed' | 'superseded';

export interface Client {
  id: string;
  name: string;
  color: string;
  domain?: string;
  industry?: string;
}

export interface Project {
  id: string;
  name: string;
  scope: 'client' | 'internal';
  clientId: string | null;
  status: 'active' | 'on-hold' | 'completed';
}

export interface Person {
  id: string;
  name: string;
  role?: string;
  email?: string;
  clientId: string | null;
  isInternal?: boolean;
}

export interface Note {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  scope: NoteScope;
  clientId: string | null;
  projectId: string | null;
  participants: string[]; // Person names who attended
  labels: string[]; // Explicit header labels (combined with inline #labels in views)
  body: string; // Source-of-truth Markdown
  createdAt: string;
  updatedAt: string;
  filePath?: string;
}

export interface ParsedTask {
  id: string;
  noteId: string;
  noteTitle: string;
  noteDate: string;
  clientId: string | null;
  projectId: string | null;
  lineIndex: number;
  rawLine: string;
  status: TaskStatus;
  text: string;
  owner: string | null;
  dueDate: string | null;
  priority: TaskPriority | null;
  labels: string[];
}

export interface ParsedDecision {
  id: string;
  noteId: string;
  noteTitle: string;
  noteDate: string;
  clientId: string | null;
  projectId: string | null;
  lineIndex: number;
  rationaleLineIndex: number | null;
  rawLine: string;
  status: DecisionStatus;
  text: string;
  rationale: string | null;
  stakeholders: string[];
  labels: string[];
}

export interface WorkspaceDirectory {
  clients: Client[];
  projects: Project[];
  people: Person[];
  customLabels: string[];
}

export type AiProviderType = 'local' | 'openai' | 'azure' | 'gemini' | 'anthropic';

export interface AiConfig {
  provider: AiProviderType;
  apiKey: string;
  model: string;
  baseUrl?: string; // OpenAI-compatible gateway or Azure endpoint
  azureDeployment?: string;
  azureApiVersion?: string;
}

export interface AiStructureProposal {
  suggestedTitle: string;
  suggestedScope: NoteScope;
  suggestedClientId: string | null;
  suggestedProjectId: string | null;
  suggestedParticipants: string[];
  suggestedLabels: string[];
  extractedTasks: Array<{
    text: string;
    owner: string | null;
    dueDate: string | null;
    priority: TaskPriority | null;
    labels: string[];
  }>;
  extractedDecisions: Array<{
    text: string;
    status: DecisionStatus;
    stakeholders: string[];
    rationale: string | null;
    labels: string[];
  }>;
  restructuredBody: string;
  usedProvider: string;
}

export interface RelatedNoteMatch {
  note: Note;
  score: number;
  reasons: string[];
  snippet: string;
}

export type ActiveMainView = 'notes' | 'tasks' | 'decisions' | 'reports' | 'people';

export type InitialLayoutMode = 'focus' | 'standard';

export interface WorkspacePreferences {
  startupLayout: InitialLayoutMode;
  focusOnNewNote: boolean;
}

export interface NoteFilter {
  kind: 'all' | 'inbox' | 'internal' | 'client' | 'project' | 'label' | 'person';
  clientId?: string;
  projectId?: string;
  label?: string;
  personName?: string;
}

export interface SyncTombstones {
  notes: Record<string, string>; // noteId -> ISO deletedAt
  clients: Record<string, string>; // clientId -> ISO deletedAt
  projects: Record<string, string>; // projectId -> ISO deletedAt
  people: Record<string, string>; // lowerCasePersonName -> ISO deletedAt
}

export type SyncProviderMode = 'none' | 'folder' | 'gdrive';

export interface GoogleDriveConfig {
  enabled: boolean;
  clientId: string;
  accessToken: string;
  tokenExpiresAt: number; // epoch ms
  folderId: string;
  folderName: string;
  userEmail?: string;
  autoSync: boolean;
}

