import type {
  AiConfig,
  AiPrivacyCategory,
  AiPrivacyReport,
  Client,
  Note,
  Person,
  WorkspaceDirectory,
} from '../types';
import { formatPersonMention } from './markdown';

const PUA_START = '\uE000';
const PUA_END = '\uE001';

const PRIVACY_SYSTEM_INSTRUCTION = `
PRIVACY PLACEHOLDER RULE: Input text replaces real personal, company, project, and contact identifiers with deterministic tokens such as PERSON_01, ORG_01, PROJECT_01, TERM_01, NOTE_01, EMAIL_01, PHONE_01, IBAN_01, and URL_01. Treat these tokens as exact proper names/identifiers and preserve their exact token IDs verbatim in your output (e.g. @[PERSON_01], [[NOTE_01]], ORG_01, PROJECT_01). Never invent new token numbers or alter token prefixes.`;

const LEGAL_SUFFIX_PATTERN =
  /\s+(?:GmbH\s*&\s*Co\.?\s*KG|GmbH|AG|Inc\.?|Corp\.?|Corporation|Ltd\.?|Limited|LLC|LLP|S\.A\.|SA|Sàrl|SARL|SE|PLC|KGaA|BV|NV|KG|OHG|UG|e\.V\.|Holding|Holdings)\s*$/iu;

const GENERIC_ORG_WORDS = new Set([
  'group',
  'holding',
  'holdings',
  'partners',
  'partner',
  'global',
  'international',
  'swiss',
  'deutsche',
  'europe',
  'european',
  'digital',
  'tech',
  'technologies',
  'technology',
  'systems',
  'solutions',
  'consulting',
  'advisory',
  'capital',
  'ventures',
  'bank',
  'wealth',
  'health',
  'healthcare',
  'labs',
  'studio',
  'studios',
  'services',
  'enterprise',
  'client',
  'company',
  'team',
  'internal',
  'general',
  'north',
  'south',
  'east',
  'west',
  'first',
  'united',
  'national',
]);

// Common English & German words (including capitalized German nouns, days, months, and Strata terms)
// that must never be treated as standalone single-token person or codename aliases.
const COMMON_WORD_STOPLIST = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'montag',
  'dienstag',
  'mittwoch',
  'donnerstag',
  'freitag',
  'samstag',
  'sonntag',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'januar',
  'februar',
  'märz',
  'maerz',
  'mai',
  'juni',
  'juli',
  'oktober',
  'dezember',
  'will',
  'mark',
  'bill',
  'art',
  'grace',
  'hope',
  'chase',
  'grant',
  'lane',
  'page',
  'ward',
  'wood',
  'stone',
  'hall',
  'hill',
  'west',
  'north',
  'south',
  'east',
  'young',
  'king',
  'long',
  'short',
  'white',
  'black',
  'brown',
  'green',
  'frank',
  'max',
  'mann',
  'frau',
  'herr',
  'stein',
  'berg',
  'wald',
  'bach',
  'feld',
  'hof',
  'kraft',
  'wolf',
  'fuchs',
  'klein',
  'gross',
  'groß',
  'kurz',
  'lang',
  'neu',
  'alt',
  'gut',
  'plan',
  'status',
  'update',
  'sync',
  'review',
  'kickoff',
  'timeline',
  'scope',
  'budget',
  'team',
  'lead',
  'manager',
  'management',
  'phase',
  'board',
  'charter',
  'sprint',
  'roadmap',
  'portal',
  'cloud',
  'data',
  'security',
  'audit',
  'risk',
  'blocker',
  'task',
  'tasks',
  'decision',
  'decisions',
  'action',
  'items',
  'notes',
  'note',
  'inbox',
  'internal',
  'client',
  'project',
  'projekt',
  'kunde',
  'kunden',
  'aufgabe',
  'aufgaben',
  'entscheid',
  'entscheidung',
  'vorschlag',
  'besprechung',
  'termin',
  'übersicht',
  'planung',
  'leitung',
  'vertrag',
  'angebot',
  'lösung',
  'architektur',
  'system',
  'plattform',
  'heute',
  'morgen',
  'woche',
]);

const LEADING_ORG_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'with',
  'from',
  'at',
  'by',
  'to',
  'in',
  'on',
  'of',
  'new',
  'our',
  'your',
  'their',
  'client',
  'company',
  'vendor',
  'partner',
  'der',
  'die',
  'das',
  'ein',
  'eine',
  'einer',
  'eines',
  'dem',
  'den',
  'und',
  'oder',
  'für',
  'mit',
  'von',
  'bei',
  'zu',
  'zur',
  'zum',
  'im',
  'am',
  'aus',
  'nach',
  'laut',
  'neue',
  'neuer',
  'neues',
  'unser',
  'unsere',
  'kunde',
  'firma',
]);

const VALID_IBAN_COUNTRIES = new Set([
  'AD', 'AE', 'AL', 'AT', 'AZ', 'BA', 'BE', 'BG', 'BH', 'BR', 'BY', 'CH', 'CR', 'CY', 'CZ',
  'DE', 'DK', 'DO', 'EE', 'EG', 'ES', 'FI', 'FO', 'FR', 'GB', 'GE', 'GI', 'GL', 'GR', 'GT',
  'HR', 'HU', 'IE', 'IL', 'IQ', 'IS', 'IT', 'JO', 'KW', 'KZ', 'LB', 'LC', 'LI', 'LT', 'LU',
  'LV', 'MC', 'MD', 'ME', 'MK', 'MR', 'MT', 'MU', 'NL', 'NO', 'PK', 'PL', 'PS', 'PT', 'QA',
  'RO', 'RS', 'SA', 'SC', 'SE', 'SI', 'SK', 'SM', 'ST', 'SV', 'TL', 'TN', 'TR', 'UA', 'VA',
  'VG', 'XK',
]);

export function isAiPseudonymizationEnabled(config: AiConfig): boolean {
  return config.pseudonymize !== false;
}

export function normalizeSensitiveTerms(terms?: string[]): string[] {
  if (!Array.isArray(terms)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of terms) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().replace(/\s+/g, ' ');
    if (trimmed.length < 2) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeUnicodeBoundaryRegex(phrase: string, flags = 'giu'): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, flags);
}

export function deriveClientAliases(client: Client): string[] {
  const full = client.name.trim();
  if (!full) return [];
  const aliases = [full];

  const stripped = full.replace(LEGAL_SUFFIX_PATTERN, '').trim();
  if (
    stripped &&
    stripped.toLowerCase() !== full.toLowerCase() &&
    stripped.length >= 3 &&
    !GENERIC_ORG_WORDS.has(stripped.toLowerCase())
  ) {
    aliases.push(stripped);
  }

  const words = (stripped || full).split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const firstWord = words[0].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (
      firstWord.length >= 4 &&
      !GENERIC_ORG_WORDS.has(firstWord.toLowerCase()) &&
      !COMMON_WORD_STOPLIST.has(firstWord.toLowerCase())
    ) {
      aliases.push(firstWord);
    }
  }

  return Array.from(new Set(aliases));
}

function computeUniquePersonPartAliases(people: Person[]): Map<string, string[]> {
  const partCounts = new Map<string, number>();

  for (const p of people) {
    const parts = p.name
      .trim()
      .split(/\s+/)
      .map((tok) => tok.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
      .filter((tok) => tok.length >= 3 && !COMMON_WORD_STOPLIST.has(tok.toLowerCase()));

    const uniqueInPerson = new Set(parts.map((x) => x.toLowerCase()));
    for (const lower of uniqueInPerson) {
      partCounts.set(lower, (partCounts.get(lower) || 0) + 1);
    }
  }

  const byPersonId = new Map<string, string[]>();
  for (const p of people) {
    const parts = p.name
      .trim()
      .split(/\s+/)
      .map((tok) => tok.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
      .filter((tok) => tok.length >= 3 && !COMMON_WORD_STOPLIST.has(tok.toLowerCase()));

    if (parts.length < 2) {
      byPersonId.set(p.id, []);
      continue;
    }

    const unambiguous = parts.filter((tok) => partCounts.get(tok.toLowerCase()) === 1);
    byPersonId.set(p.id, unambiguous);
  }

  return byPersonId;
}

/**
 * Selects only the directory entities relevant to a given note so we do not transmit
 * the entire workspace client/project/person directory on every structuring request.
 */
export function selectRelevantDirectoryForNote(
  note: Note,
  directory: WorkspaceDirectory
): WorkspaceDirectory {
  const haystack = `${note.title}\n${note.body}`;
  const lowerHaystack = haystack.toLowerCase();
  const participantLower = new Set(note.participants.map((p) => p.toLowerCase()));
  const partAliasesByPerson = computeUniquePersonPartAliases(directory.people);

  const matchedClientIds = new Set<string>();
  const matchedProjectIds = new Set<string>();
  const matchedPersonIds = new Set<string>();

  if (note.clientId) matchedClientIds.add(note.clientId);
  if (note.projectId) matchedProjectIds.add(note.projectId);

  for (const person of directory.people) {
    const fullLower = person.name.trim().toLowerCase();
    if (!fullLower) continue;
    let hit =
      participantLower.has(fullLower) ||
      lowerHaystack.includes(fullLower) ||
      Boolean(person.email && lowerHaystack.includes(person.email.toLowerCase()));

    if (!hit) {
      const parts = partAliasesByPerson.get(person.id) || [];
      hit = parts.some((part) => makeUnicodeBoundaryRegex(part, 'gu').test(haystack));
    }

    if (hit) {
      matchedPersonIds.add(person.id);
      if (person.clientId) matchedClientIds.add(person.clientId);
    }
  }

  for (const client of directory.clients) {
    const aliases = deriveClientAliases(client);
    const domainHit = Boolean(client.domain && lowerHaystack.includes(client.domain.toLowerCase()));
    if (
      matchedClientIds.has(client.id) ||
      domainHit ||
      aliases.some((alias) => makeUnicodeBoundaryRegex(alias, 'giu').test(haystack))
    ) {
      matchedClientIds.add(client.id);
    }
  }

  for (const proj of directory.projects) {
    const projHit =
      matchedProjectIds.has(proj.id) ||
      (proj.name.trim().length >= 2 &&
        makeUnicodeBoundaryRegex(proj.name.trim(), 'giu').test(haystack)) ||
      Boolean(proj.clientId && matchedClientIds.has(proj.clientId));

    if (projHit) {
      matchedProjectIds.add(proj.id);
      if (proj.clientId) matchedClientIds.add(proj.clientId);
    }
  }

  return {
    clients: directory.clients.filter((c) => matchedClientIds.has(c.id)),
    projects: directory.projects.filter((p) => matchedProjectIds.has(p.id)),
    people: directory.people.filter((p) => matchedPersonIds.has(p.id)),
    customLabels: directory.customLabels,
    sensitiveTerms: directory.sensitiveTerms,
  };
}

interface SentinelEntry {
  outbound: string;
  canonical?: string;
  category?: AiPrivacyCategory;
}

export interface AiPrivacySession {
  enabled: boolean;
  scrubText: (text: string) => string;
  scrubPrompts: (
    systemPrompt: string,
    userPrompt: string
  ) => {
    systemPrompt: string;
    userPrompt: string;
    report: AiPrivacyReport;
  };
  rehydrateText: (text: string) => string;
  rehydrateValue: <T>(value: T) => T;
}

export function createAiPrivacySession(options: {
  directory?: WorkspaceDirectory;
  notes?: Note[];
  enabled: boolean;
}): AiPrivacySession {
  const { directory, notes = [], enabled } = options;

  if (!enabled) {
    return {
      enabled: false,
      scrubText: (text: string) => text,
      scrubPrompts: (systemPrompt: string, userPrompt: string) => ({
        systemPrompt,
        userPrompt,
        report: {
          enabled: false,
          maskedCount: 0,
          totalReplacements: 0,
          countsByCategory: {},
          scrubbedSystemPrompt: systemPrompt,
          scrubbedUserPrompt: userPrompt,
        },
      }),
      rehydrateText: (text: string) => text,
      rehydrateValue: <T>(value: T): T => value,
    };
  }

  const counters: Record<AiPrivacyCategory, number> = {
    PERSON: 0,
    ORG: 0,
    PROJECT: 0,
    TERM: 0,
    NOTE: 0,
    EMAIL: 0,
    PHONE: 0,
    IBAN: 0,
    URL: 0,
  };

  // Alias ("CATEGORY::lowercaseAlias") -> canonical display string (e.g. "Sarah Chen")
  const aliasToCanonical = new Map<string, string>();
  // Canonical key ("CATEGORY::lowercaseCanonical") -> lazily allocated token ("PERSON_01")
  const canonicalToToken = new Map<string, string>();
  // Token ("PERSON_01") -> { canonical: "Sarah Chen", category: "PERSON" }
  const tokenToEntity = new Map<string, { canonical: string; category: AiPrivacyCategory }>();

  const sentinels: SentinelEntry[] = [];
  let totalReplacements = 0;

  const registerCanonicalAlias = (
    category: AiPrivacyCategory,
    alias: string,
    canonicalValue: string
  ): void => {
    const cleanAlias = alias.trim();
    const cleanCanonical = canonicalValue.trim();
    if (!cleanAlias || !cleanCanonical) return;
    const aliasKey = `${category}::${cleanAlias.toLowerCase()}`;
    if (!aliasToCanonical.has(aliasKey)) {
      aliasToCanonical.set(aliasKey, cleanCanonical);
    }
    const canonKey = `${category}::${cleanCanonical.toLowerCase()}`;
    if (!aliasToCanonical.has(canonKey)) {
      aliasToCanonical.set(canonKey, cleanCanonical);
    }
  };

  // Lazily allocates a sequential token ONLY when an entity actually occurs in outbound text
  const allocateTokenForMatch = (category: AiPrivacyCategory, matchedOrCanonical: string): string => {
    const trimmed = matchedOrCanonical.trim();
    const aliasKey = `${category}::${trimmed.toLowerCase()}`;
    const canonical = aliasToCanonical.get(aliasKey) || trimmed;
    const canonKey = `${category}::${canonical.toLowerCase()}`;

    const existing = canonicalToToken.get(canonKey);
    if (existing) return existing;

    counters[category] += 1;
    const num = String(counters[category]).padStart(2, '0');
    const token = `${category}_${num}`;
    canonicalToToken.set(canonKey, token);
    aliasToCanonical.set(canonKey, canonical);
    tokenToEntity.set(token, { canonical, category });
    return token;
  };

  const makeEntitySentinel = (category: AiPrivacyCategory, matchedOrCanonical: string): string => {
    const token = allocateTokenForMatch(category, matchedOrCanonical);
    const info = tokenToEntity.get(token);
    const id = sentinels.length;
    sentinels.push({
      outbound: token,
      canonical: info?.canonical,
      category,
    });
    totalReplacements += 1;
    return `${PUA_START}${id}${PUA_END}`;
  };

  const makeStructuralSentinel = (verbatimText: string): string => {
    const id = sentinels.length;
    sentinels.push({ outbound: verbatimText });
    return `${PUA_START}${id}${PUA_END}`;
  };

  const unwrapSentinels = (input: string): string =>
    input.replace(/\uE000(\d+)\uE001/g, (_, idxStr: string) => {
      const entry = sentinels[Number(idxStr)];
      return entry ? entry.outbound : '';
    });

  // Pre-seed known directory lookup rules WITHOUT allocating tokens until matched
  const clients = directory?.clients || [];
  const projects = directory?.projects || [];
  const people = directory?.people || [];
  const sensitiveTerms = normalizeSensitiveTerms(directory?.sensitiveTerms);
  const partAliasesByPerson = computeUniquePersonPartAliases(people);

  interface PhraseRule {
    phrase: string;
    canonical: string;
    category: AiPrivacyCategory;
    caseSensitive: boolean;
  }

  const phraseRules: PhraseRule[] = [];
  const registeredRuleKeys = new Set<string>();

  const addPhraseRule = (
    phrase: string,
    canonical: string,
    category: AiPrivacyCategory,
    caseSensitive = false
  ) => {
    const clean = phrase.trim();
    const cleanCanon = canonical.trim();
    if (clean.length < 2 || !cleanCanon) return;
    registerCanonicalAlias(category, clean, cleanCanon);
    const ruleKey = `${category}::${caseSensitive ? 'CS' : 'CI'}::${clean}`;
    if (registeredRuleKeys.has(ruleKey)) return;
    registeredRuleKeys.add(ruleKey);
    phraseRules.push({ phrase: clean, canonical: cleanCanon, category, caseSensitive });
  };

  // 1. Custom Sensitive Terms
  for (const term of sensitiveTerms) {
    addPhraseRule(term, term, 'TERM', false);
  }

  // 2. Known Clients & Domains
  for (const client of clients) {
    if (!client.name.trim()) continue;
    for (const alias of deriveClientAliases(client)) {
      addPhraseRule(alias, client.name, 'ORG', false);
    }
    if (client.domain?.trim()) {
      addPhraseRule(client.domain.trim(), client.domain.trim(), 'URL', false);
    }
  }

  // 3. Known Projects
  for (const proj of projects) {
    const name = proj.name.trim();
    if (name.length < 2) continue;
    const isCommonSingleWord =
      !name.includes(' ') && COMMON_WORD_STOPLIST.has(name.toLowerCase());
    addPhraseRule(name, name, 'PROJECT', isCommonSingleWord);
  }

  // 4. Known People
  for (const person of people) {
    const fullName = person.name.trim();
    if (!fullName) continue;
    addPhraseRule(fullName, fullName, 'PERSON', false);

    if (person.email?.trim()) {
      addPhraseRule(person.email.trim(), person.email.trim(), 'EMAIL', false);
    }

    const unambiguousParts = partAliasesByPerson.get(person.id) || [];
    for (const part of unambiguousParts) {
      addPhraseRule(part, fullName, 'PERSON', true);
    }
  }

  // 5. Known Notes (canonical exact title mapping for [[Note Title]] links)
  for (const n of notes) {
    if (n.title?.trim()) {
      registerCanonicalAlias('NOTE', n.title.trim(), n.title.trim());
    }
  }

  const scrubInternal = (rawInput: string): string => {
    if (!rawInput) return rawInput;
    let work = rawInput;

    // Step A: Protect local Markdown asset paths `![alt](assets/...)` and `[label](assets/...)`
    work = work.replace(
      /(!?)\[([^\]]*)\]\((assets\/[^)\s]+)\)/gi,
      (_, bang: string, label: string, assetPath: string) => {
        const scrubbedLabel = label ? scrubInternal(label) : '';
        const protectedPath = makeStructuralSentinel(assetPath);
        return `${bang}[${scrubbedLabel}](${protectedPath})`;
      }
    );

    // Step B: Replace [[WikiNote Links]] -> [[NOTE_xx]] for lossless citation restoration
    work = work.replace(
      /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g,
      (full, target: string, alias?: string) => {
        const cleanTarget = target.trim();
        const lowerTarget = cleanTarget.toLowerCase();
        if (
          !cleanTarget ||
          /^NOTE_\d+$/i.test(cleanTarget) ||
          lowerTarget === 'exact note title' ||
          lowerTarget === 'note title' ||
          lowerTarget === 'link'
        ) {
          return full;
        }
        const sentinel = makeEntitySentinel('NOTE', cleanTarget);
        if (alias && alias.trim()) {
          const scrubbedAlias = scrubInternal(alias.trim());
          return `[[${sentinel}|${scrubbedAlias}]]`;
        }
        return `[[${sentinel}]]`;
      }
    );

    // Step C: Explicit @[Full Name] mentions (catches both known & brand-new unlisted people)
    work = work.replace(/@\[([^\]\n]+)\]/g, (full, rawName: string) => {
      const cleanName = rawName.trim();
      const lowerName = cleanName.toLowerCase();
      if (
        !cleanName ||
        /^PERSON_\d+$/i.test(cleanName) ||
        lowerName === 'full name' ||
        lowerName === 'owner' ||
        lowerName === 'owners'
      ) {
        return full;
      }
      addPhraseRule(cleanName, cleanName, 'PERSON', false);
      const parts = cleanName
        .split(/\s+/)
        .filter((p) => p.length >= 3 && !COMMON_WORD_STOPLIST.has(p.toLowerCase()));
      if (parts.length >= 2) {
        addPhraseRule(parts[0], cleanName, 'PERSON', true);
      }
      return `@[${makeEntitySentinel('PERSON', cleanName)}]`;
    });

    // Step D: Structured Contact & Technical PII (Emails, IBANs, URLs, IPv4s, Phone Numbers)
    work = work.replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,
      (email) => makeEntitySentinel('EMAIL', email)
    );

    work = work.replace(
      /\b([A-Z]{2})\d{2}(?:[\s-]?[A-Z0-9]{4}){3,7}(?:[\s-]?[A-Z0-9]{1,4})?\b/g,
      (match, country: string) => {
        const compact = match.replace(/[\s-]+/g, '');
        const digitCount = (compact.slice(4).match(/\d/g) || []).length;
        if (
          !VALID_IBAN_COUNTRIES.has(country) ||
          compact.length < 15 ||
          compact.length > 34 ||
          digitCount < 6
        ) {
          return match;
        }
        return makeEntitySentinel('IBAN', match);
      }
    );

    work = work.replace(/\b(?:https?:\/\/|www\.)[^\s<>)\]]+/gi, (rawUrl) => {
      const trailingMatch = rawUrl.match(/([.,;:!?]+)$/);
      const trailing = trailingMatch ? trailingMatch[1] : '';
      const cleanUrl = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
      return `${makeEntitySentinel('URL', cleanUrl)}${trailing}`;
    });

    work = work.replace(
      /\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{2,5})?)\b/g,
      (ip) => makeEntitySentinel('URL', ip)
    );

    work = work.replace(
      /(?:(?:\+|00)\d{1,3}[\s./()-]*(?:\d[\s./()-]*){6,13}\d|\(\d{2,5}\)[\s./-]*\d{3,4}[\s./-]*\d{3,6}|\b0\d{2,4}[\s./-]\d{2,4}[\s./-]\d{2,4}(?:[\s./-]\d{2,4})?\b)/g,
      (candidate) => {
        const trimmed = candidate.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return candidate;
        const digitsOnly = trimmed.replace(/\D/g, '');
        if (digitsOnly.length < 8 || digitsOnly.length > 16) return candidate;
        return makeEntitySentinel('PHONE', trimmed);
      }
    );

    // Step E: Apply known Directory & Custom Sensitive Term phrase rules FIRST (longest-first)
    // so ground-truth clients, projects (including quoted names), people, and custom terms
    // always take priority over heuristic unlisted-entity rules.
    const applyPhraseRules = (rules: PhraseRule[]) => {
      const sorted = [...rules].sort((a, b) => b.phrase.length - a.phrase.length);
      for (const rule of sorted) {
        const regex = makeUnicodeBoundaryRegex(rule.phrase, rule.caseSensitive ? 'gu' : 'giu');
        work = work.replace(regex, () => makeEntitySentinel(rule.category, rule.canonical));
      }
    };

    const initialRuleCount = phraseRules.length;
    applyPhraseRules(phraseRules);

    // Step F: High-Precision EN & DE Context Rules for remaining UNLISTED Entities
    // F1. Unlisted Companies with explicit legal suffixes (AG, GmbH, Inc, Ltd, LLC, SA, Sàrl, Corp, PLC...)
    work = work.replace(
      /(?<![\p{L}\p{N}])([A-ZÄÖÜ][\p{L}\p{N}&.'-]{1,25}(?:[ \t]+[A-ZÄÖÜ][\p{L}\p{N}&.'-]{1,25}){0,3})[ \t]+(GmbH[ \t]*&[ \t]*Co\.?[ \t]*KG|GmbH|AG|Inc\.?|Corp\.?|Corporation|Ltd\.?|Limited|LLC|LLP|S\.A\.|Sàrl|SARL|PLC|KGaA|BV|NV)(?![\p{L}\p{N}])/gu,
      (fullMatch, rawPrefix: string, suffix: string) => {
        const words = rawPrefix.trim().split(/\s+/);
        let leadingTrimmed = '';
        while (words.length > 1 && LEADING_ORG_STOPWORDS.has(words[0].toLowerCase())) {
          leadingTrimmed += `${words.shift()!} `;
        }
        if (words.length === 1 && LEADING_ORG_STOPWORDS.has(words[0].toLowerCase())) {
          return fullMatch;
        }
        const cleanOrg = `${words.join(' ')} ${suffix.trim()}`;
        addPhraseRule(cleanOrg, cleanOrg, 'ORG', false);
        const baseName = words.join(' ');
        if (
          baseName.length >= 4 &&
          !GENERIC_ORG_WORDS.has(baseName.toLowerCase()) &&
          !COMMON_WORD_STOPLIST.has(baseName.toLowerCase())
        ) {
          addPhraseRule(baseName, cleanOrg, 'ORG', true);
        }
        return `${leadingTrimmed}${makeEntitySentinel('ORG', cleanOrg)}`;
      }
    );

    // F2. Unlisted Project Codenames ("Project Titan", "Projekt Alpina", "Codename Horizon")
    work = work.replace(
      /\b(Project|Projekt|Codename)[ \t]+([A-ZÄÖÜ][\p{L}\p{N}_-]{2,24}(?:[ \t]+[A-ZÄÖÜ][\p{L}\p{N}_-]{2,24})?)\b/gu,
      (fullMatch, prefix: string, rawCodename: string) => {
        const words = rawCodename.trim().split(/\s+/);
        if (
          words.every(
            (w) => COMMON_WORD_STOPLIST.has(w.toLowerCase()) || GENERIC_ORG_WORDS.has(w.toLowerCase())
          )
        ) {
          return fullMatch;
        }
        const cleanProj = rawCodename.trim();
        addPhraseRule(cleanProj, cleanProj, 'PROJECT', true);
        return `${prefix} ${makeEntitySentinel('PROJECT', cleanProj)}`;
      }
    );

    // F3. Unlisted Meeting / 1:1 Person Names (EN & DE)
    work = work.replace(
      /\b(1:1[ \t]*(?:—|–|-|:|with|mit)|Met with|Call with|Sync with|Spoke with|Meeting with|Besprechung mit|Gespräch mit|Telefonat mit|Termin mit)[ \t]+([A-ZÄÖÜ][\p{L}'-]{2,20}[ \t]+[A-ZÄÖÜ][\p{L}'-]{2,22})\b/gu,
      (fullMatch, lead: string, fullName: string) => {
        const nameParts = fullName.trim().split(/\s+/);
        if (
          nameParts.some(
            (w) =>
              COMMON_WORD_STOPLIST.has(w.toLowerCase()) || LEADING_ORG_STOPWORDS.has(w.toLowerCase())
          )
        ) {
          return fullMatch;
        }
        const cleanName = fullName.trim();
        addPhraseRule(cleanName, cleanName, 'PERSON', false);
        if (nameParts[0].length >= 3) {
          addPhraseRule(nameParts[0], cleanName, 'PERSON', true);
        }
        return `${lead} ${makeEntitySentinel('PERSON', cleanName)}`;
      }
    );

    // F4. Unbracketed @handle mentions (excluding prompt meta instructions like @owners / @people)
    work = work.replace(
      /(^|[\s(])@([A-ZÄÖÜa-zäöüß][\p{L}\p{N}._-]{2,28})(?=$|[\s,.;:!?)])/gu,
      (fullMatch, prefix: string, handle: string) => {
        const lower = handle.toLowerCase();
        if (
          lower === 'owners' ||
          lower === 'owner' ||
          lower === 'people' ||
          lower === 'person' ||
          /^person_\d+$/i.test(handle)
        ) {
          return fullMatch;
        }
        return `${prefix}@${makeEntitySentinel('PERSON', handle)}`;
      }
    );

    // Step G: Apply any newly discovered unlisted entity aliases (e.g. "Lukas" from "Besprechung mit Lukas Weber")
    if (phraseRules.length > initialRuleCount) {
      applyPhraseRules(phraseRules.slice(initialRuleCount));
    }

    return work;
  };

  const scrubText = (text: string): string => unwrapSentinels(scrubInternal(text));

  const scrubPrompts = (systemPrompt: string, userPrompt: string) => {
    const scrubbedUser = scrubText(userPrompt);
    const scrubbedSysCore = scrubText(systemPrompt);
    const finalSystemPrompt = `${scrubbedSysCore}\n${PRIVACY_SYSTEM_INSTRUCTION}`;

    const countsByCategory: Partial<Record<AiPrivacyCategory, number>> = {};
    let maskedCount = 0;
    for (const [cat, count] of Object.entries(counters) as Array<[AiPrivacyCategory, number]>) {
      if (count > 0) {
        countsByCategory[cat] = count;
        maskedCount += count;
      }
    }

    return {
      systemPrompt: finalSystemPrompt,
      userPrompt: scrubbedUser,
      report: {
        enabled: true,
        maskedCount,
        totalReplacements,
        countsByCategory,
        scrubbedSystemPrompt: finalSystemPrompt,
        scrubbedUserPrompt: scrubbedUser,
      },
    };
  };

  const rehydrateText = (rawOutput: string): string => {
    if (!rawOutput || tokenToEntity.size === 0) return rawOutput;
    let text = rawOutput;
    const restoredChunks: string[] = [];
    const stash = (real: string): string => {
      const idx = restoredChunks.length;
      restoredChunks.push(real);
      return `\uE002${idx}\uE003`;
    };

    const entries = Array.from(tokenToEntity.entries()).sort((a, b) => b[0].length - a[0].length);

    for (const [token, { canonical, category }] of entries) {
      const [prefix, numStr] = token.split('_');
      const numInt = Number(numStr);
      const tokenPattern = `${prefix}[_\\s]0?${numInt}`;

      if (category === 'PERSON') {
        const bracketMentionRe = new RegExp(`@\\[\\s*${tokenPattern}\\s*\\]`, 'gi');
        text = text.replace(bracketMentionRe, () => stash(formatPersonMention(canonical)));

        const bareMentionRe = new RegExp(`(?<!\\[)@${tokenPattern}(?![\\p{L}\\p{N}])`, 'giu');
        text = text.replace(bareMentionRe, () => stash(formatPersonMention(canonical)));
      }

      if (category === 'NOTE') {
        const wikiNoteRe = new RegExp(`\\[\\[\\s*${tokenPattern}\\s*\\]\\]`, 'gi');
        text = text.replace(wikiNoteRe, () => stash(`[[${canonical}]]`));
      }

      const generalRe = new RegExp(`(?<![\\p{L}\\p{N}])${tokenPattern}(?![\\p{L}\\p{N}])`, 'giu');
      text = text.replace(generalRe, () => stash(canonical));
    }

    return text.replace(/\uE002(\d+)\uE003/g, (_, idxStr: string) => restoredChunks[Number(idxStr)] ?? '');
  };

  const rehydrateValue = <T>(value: T): T => {
    if (typeof value === 'string') {
      return rehydrateText(value) as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => rehydrateValue(item)) as unknown as T;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = rehydrateValue(v);
      }
      return out as T;
    }
    return value;
  };

  return {
    enabled: true,
    scrubText,
    scrubPrompts,
    rehydrateText,
    rehydrateValue,
  };
}
