import type { WorkspacePreferences } from '../types';

const PREFERENCES_STORAGE_KEY = 'strata.preferences';

export const DEFAULT_PREFERENCES: WorkspacePreferences = {
  startupLayout: 'focus',
  focusOnNewNote: true,
};

export function loadWorkspacePreferences(): WorkspacePreferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<WorkspacePreferences>;
    return {
      startupLayout: parsed.startupLayout === 'standard' ? 'standard' : 'focus',
      focusOnNewNote:
        typeof parsed.focusOnNewNote === 'boolean'
          ? parsed.focusOnNewNote
          : DEFAULT_PREFERENCES.focusOnNewNote,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function saveWorkspacePreferences(prefs: WorkspacePreferences): void {
  try {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage write errors in restricted/sandboxed contexts
  }
}
