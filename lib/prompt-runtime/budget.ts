export interface PromptBudgetConfig {
  enabled: boolean;
  /** Max characters kept per AGENTS.md / CLAUDE.md context file (0 = unlimited). */
  projectContextPerFileMaxChars: number;
  /** Max total characters kept across all project context files (0 = unlimited). */
  projectContextTotalMaxChars: number;
  /** Max visible skills kept in the auto-injected system prompt list (0 = unlimited). */
  skillsMaxCount: number;
  /** Max characters kept per skill description in the system prompt (0 = unlimited). */
  skillDescriptionMaxChars: number;
  /** Max total characters kept across auto-injected skill entries (0 = unlimited). */
  skillsTotalMaxChars: number;
  /** Warn when total system prompt characters exceed this threshold (0 = unlimited). */
  warnTotalSystemPromptChars: number;
}

export interface PromptBudgetTruncatedFile {
  path: string;
  originalChars: number;
  keptChars: number;
}

export interface PromptBudgetProjectContextReport {
  totalFiles: number;
  truncatedFiles: PromptBudgetTruncatedFile[];
  omittedFiles: string[];
  originalChars: number;
  keptChars: number;
}

export interface PromptBudgetSkillsReport {
  totalSkills: number;
  visibleSkills: number;
  truncatedDescriptions: string[];
  omittedFromPrompt: string[];
  originalChars: number;
  keptChars: number;
}

export type PromptBudgetWarning =
  | {
      kind: "project_context_truncated";
      truncatedFiles: number;
      omittedFiles: number;
      originalChars: number;
      keptChars: number;
    }
  | {
      kind: "skills_truncated";
      truncatedDescriptions: number;
      omittedSkills: number;
      totalVisibleSkills: number;
    }
  | {
      kind: "system_prompt_large";
      totalChars: number;
      warnChars: number;
    };

export interface PromptBudgetReport {
  enabled: boolean;
  projectContext: PromptBudgetProjectContextReport;
  skills: PromptBudgetSkillsReport;
  systemPromptChars?: number;
  truncated: boolean;
  warnings: PromptBudgetWarning[];
  fingerprint: string;
}

export interface AgentsContextFileLike {
  path: string;
  content: string;
}

export interface BudgetSkillLike {
  name: string;
  description: string;
  disableModelInvocation: boolean;
}

export const DEFAULT_PROMPT_BUDGET_CONFIG: PromptBudgetConfig = {
  enabled: true,
  projectContextPerFileMaxChars: 12_000,
  projectContextTotalMaxChars: 24_000,
  skillsMaxCount: 30,
  skillDescriptionMaxChars: 240,
  skillsTotalMaxChars: 8_000,
  warnTotalSystemPromptChars: 40_000,
};

export const PROMPT_BUDGET_LIMITS = {
  projectContextPerFileMaxChars: { min: 0, max: 500_000 },
  projectContextTotalMaxChars: { min: 0, max: 500_000 },
  skillsMaxCount: { min: 0, max: 500 },
  skillDescriptionMaxChars: { min: 0, max: 4_096 },
  skillsTotalMaxChars: { min: 0, max: 500_000 },
  warnTotalSystemPromptChars: { min: 0, max: 1_000_000 },
} as const;

type NumericBudgetKey = keyof typeof PROMPT_BUDGET_LIMITS;
const NUMERIC_BUDGET_KEYS = Object.keys(PROMPT_BUDGET_LIMITS) as NumericBudgetKey[];
const BUDGET_KEY_SET = new Set<string>(["enabled", ...NUMERIC_BUDGET_KEYS]);

export function createDefaultPromptBudgetConfig(): PromptBudgetConfig {
  return { ...DEFAULT_PROMPT_BUDGET_CONFIG };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidBudgetInteger(key: NumericBudgetKey, value: unknown): value is number {
  const { min, max } = PROMPT_BUDGET_LIMITS[key];
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function normalizePromptBudgetConfig(raw: unknown): PromptBudgetConfig {
  const result = createDefaultPromptBudgetConfig();
  if (!isPlainObject(raw)) return result;
  if (typeof raw.enabled === "boolean") result.enabled = raw.enabled;
  for (const key of NUMERIC_BUDGET_KEYS) {
    if (isValidBudgetInteger(key, raw[key])) {
      result[key] = raw[key];
    }
  }
  return result;
}

export function parsePromptBudgetConfigPatch(raw: unknown): Partial<PromptBudgetConfig> {
  if (!isPlainObject(raw)) {
    throw new TypeError("budget must be an object.");
  }
  const patch: Partial<PromptBudgetConfig> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!BUDGET_KEY_SET.has(key)) {
      throw new TypeError(`Unknown prompt budget setting: ${key}`);
    }
    if (key === "enabled") {
      if (typeof value !== "boolean") {
        throw new TypeError('Prompt budget setting "enabled" must be a boolean.');
      }
      patch.enabled = value;
      continue;
    }
    const numericKey = key as NumericBudgetKey;
    const { min, max } = PROMPT_BUDGET_LIMITS[numericKey];
    if (!isValidBudgetInteger(numericKey, value)) {
      throw new TypeError(`Prompt budget setting "${numericKey}" must be an integer between ${min} and ${max}.`);
    }
    patch[numericKey] = value;
  }
  return patch;
}

function sliceSafeUtf16(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  let end = maxLength;
  const code = text.charCodeAt(end - 1);
  // Avoid splitting a UTF-16 surrogate pair.
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, Math.max(0, end));
}

function truncateProjectContextContent(content: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (content.length <= maxChars) return content;
  const sliced = sliceSafeUtf16(content, maxChars);
  const minBoundary = Math.floor(sliced.length * 0.7);
  const lastNewline = sliced.lastIndexOf("\n");
  const candidate = lastNewline >= minBoundary ? sliced.slice(0, lastNewline) : sliced;
  return candidate.trimEnd();
}

function truncateSkillDescription(description: string, maxChars: number): string {
  if (maxChars <= 0 || description.length <= maxChars) return description;
  if (maxChars === 1) return "…";
  const bodyLimit = maxChars - 1;
  const sliced = sliceSafeUtf16(description, bodyLimit);
  const minSentencePos = Math.floor(bodyLimit * 0.4);

  // Prefer ending at a complete first sentence when it fits comfortably.
  const sentenceMatch = sliced.match(/^[\s\S]*?(?:[.!?](?=\s|$)|[。！？])/);
  if (sentenceMatch && sentenceMatch[0].length >= minSentencePos && sentenceMatch[0].length <= bodyLimit) {
    return `${sentenceMatch[0].trimEnd()}…`;
  }

  const minWordPos = Math.floor(bodyLimit * 0.6);
  const lastSpace = sliced.lastIndexOf(" ");
  const boundary = lastSpace >= minWordPos ? sliced.slice(0, lastSpace) : sliced;
  return `${boundary.trimEnd()}…`;
}

export function formatProjectContextTruncationFooter(path: string, omittedChars: number): string {
  return `[Truncated: omitted ${omittedChars} chars from ${path}. Use the read tool to inspect full details when needed.]`;
}

/**
 * Apply character budgets to AGENTS.md / CLAUDE.md project context files.
 * Allocates total budget cwd-first (tail to head) while preserving original
 * `[global, ..., cwd]` render order and deterministic truncation footers.
 */
export function applyProjectContextBudget<TFile extends AgentsContextFileLike>(
  base: { agentsFiles: readonly TFile[] },
  config: PromptBudgetConfig = DEFAULT_PROMPT_BUDGET_CONFIG,
): { agentsFiles: TFile[]; report: PromptBudgetProjectContextReport } {
  const files = base.agentsFiles;
  const originalChars = files.reduce((sum, file) => sum + file.content.length, 0);

  if (!config.enabled) {
    return {
      agentsFiles: files.map((file) => ({ ...file })),
      report: {
        totalFiles: files.length,
        truncatedFiles: [],
        omittedFiles: [],
        originalChars,
        keptChars: originalChars,
      },
    };
  }

  const perFileCap = config.projectContextPerFileMaxChars > 0
    ? config.projectContextPerFileMaxChars
    : Number.POSITIVE_INFINITY;
  let remainingTotal = config.projectContextTotalMaxChars > 0
    ? config.projectContextTotalMaxChars
    : Number.POSITIVE_INFINITY;

  const keptByIndex: Array<TFile | null> = new Array(files.length).fill(null);
  const truncatedByIndex: Array<PromptBudgetTruncatedFile | null> = new Array(files.length).fill(null);
  const omittedByIndex: Array<string | null> = new Array(files.length).fill(null);

  for (let index = files.length - 1; index >= 0; index -= 1) {
    const file = files[index];
    const origLen = file.content.length;
    const cap = Math.min(perFileCap, remainingTotal);

    if (origLen <= cap) {
      keptByIndex[index] = { ...file };
      if (Number.isFinite(remainingTotal)) remainingTotal = Math.max(0, remainingTotal - origLen);
      continue;
    }

    if (cap <= 0) {
      omittedByIndex[index] = file.path;
      continue;
    }

    const keptBody = truncateProjectContextContent(file.content, cap);
    const omittedChars = Math.max(1, origLen - keptBody.length);
    const footer = formatProjectContextTruncationFooter(file.path, omittedChars);
    const content = keptBody ? `${keptBody}\n\n${footer}` : footer;
    keptByIndex[index] = { ...file, content };
    truncatedByIndex[index] = {
      path: file.path,
      originalChars: origLen,
      keptChars: keptBody.length,
    };
    if (Number.isFinite(remainingTotal)) {
      remainingTotal = Math.max(0, remainingTotal - keptBody.length);
    }
  }

  const agentsFiles: TFile[] = [];
  const truncatedFiles: PromptBudgetTruncatedFile[] = [];
  const omittedFiles: string[] = [];
  let keptChars = 0;

  for (let index = 0; index < files.length; index += 1) {
    const kept = keptByIndex[index];
    if (kept) {
      agentsFiles.push(kept);
      const truncated = truncatedByIndex[index];
      keptChars += truncated ? truncated.keptChars : kept.content.length;
    }
    const truncated = truncatedByIndex[index];
    if (truncated) truncatedFiles.push(truncated);
    const omitted = omittedByIndex[index];
    if (omitted) omittedFiles.push(omitted);
  }

  return {
    agentsFiles,
    report: {
      totalFiles: files.length,
      truncatedFiles,
      omittedFiles,
      originalChars,
      keptChars,
    },
  };
}

/**
 * Apply count/character budgets to skills injected into the system prompt.
 * NEVER removes skills from the returned array so `/skill:name` expansion and
 * slash-command autocomplete stay intact; overflow skills receive shallow
 * copies with `disableModelInvocation: true`.
 */
export function applySkillsPromptBudget<TSkill extends BudgetSkillLike, TDiagnostic = unknown>(
  base: { skills: readonly TSkill[]; diagnostics: TDiagnostic[] },
  config: PromptBudgetConfig = DEFAULT_PROMPT_BUDGET_CONFIG,
): { skills: TSkill[]; diagnostics: TDiagnostic[]; report: PromptBudgetSkillsReport } {
  const truncatedDescriptions: string[] = [];
  const omittedFromPrompt: string[] = [];
  let visibleSkills = 0;
  let keptVisibleCount = 0;
  let originalChars = 0;
  let keptChars = 0;

  const skills = base.skills.map((skill) => {
    if (skill.disableModelInvocation) {
      return { ...skill };
    }

    visibleSkills += 1;
    const rawDescription = typeof skill.description === "string" ? skill.description : "";
    const origEntryChars = skill.name.length + rawDescription.length;
    originalChars += origEntryChars;

    if (!config.enabled) {
      keptVisibleCount += 1;
      keptChars += origEntryChars;
      return { ...skill };
    }

    if (config.skillsMaxCount > 0 && keptVisibleCount >= config.skillsMaxCount) {
      omittedFromPrompt.push(skill.name);
      return { ...skill, disableModelInvocation: true };
    }

    const description = config.skillDescriptionMaxChars > 0
      ? truncateSkillDescription(rawDescription, config.skillDescriptionMaxChars)
      : rawDescription;
    const entryChars = skill.name.length + description.length;

    if (config.skillsTotalMaxChars > 0 && keptChars + entryChars > config.skillsTotalMaxChars) {
      omittedFromPrompt.push(skill.name);
      return { ...skill, disableModelInvocation: true };
    }

    if (description !== rawDescription) {
      truncatedDescriptions.push(skill.name);
    }
    keptVisibleCount += 1;
    keptChars += entryChars;
    return description !== rawDescription ? { ...skill, description } : { ...skill };
  });

  return {
    skills,
    diagnostics: base.diagnostics,
    report: {
      totalSkills: base.skills.length,
      visibleSkills,
      truncatedDescriptions,
      omittedFromPrompt,
      originalChars,
      keptChars,
    },
  };
}

export function emptyProjectContextReport(): PromptBudgetProjectContextReport {
  return {
    totalFiles: 0,
    truncatedFiles: [],
    omittedFiles: [],
    originalChars: 0,
    keptChars: 0,
  };
}

export function emptySkillsReport(): PromptBudgetSkillsReport {
  return {
    totalSkills: 0,
    visibleSkills: 0,
    truncatedDescriptions: [],
    omittedFromPrompt: [],
    originalChars: 0,
    keptChars: 0,
  };
}

export function buildPromptBudgetReport(input: {
  config: PromptBudgetConfig;
  projectContext?: PromptBudgetProjectContextReport;
  skills?: PromptBudgetSkillsReport;
  systemPromptChars?: number;
}): PromptBudgetReport {
  const projectContext = input.projectContext ?? emptyProjectContextReport();
  const skills = input.skills ?? emptySkillsReport();
  const warnings: PromptBudgetWarning[] = [];

  if (projectContext.truncatedFiles.length > 0 || projectContext.omittedFiles.length > 0) {
    warnings.push({
      kind: "project_context_truncated",
      truncatedFiles: projectContext.truncatedFiles.length,
      omittedFiles: projectContext.omittedFiles.length,
      originalChars: projectContext.originalChars,
      keptChars: projectContext.keptChars,
    });
  }

  if (skills.truncatedDescriptions.length > 0 || skills.omittedFromPrompt.length > 0) {
    warnings.push({
      kind: "skills_truncated",
      truncatedDescriptions: skills.truncatedDescriptions.length,
      omittedSkills: skills.omittedFromPrompt.length,
      totalVisibleSkills: skills.visibleSkills,
    });
  }

  if (
    input.config.enabled
    && input.config.warnTotalSystemPromptChars > 0
    && typeof input.systemPromptChars === "number"
    && input.systemPromptChars > input.config.warnTotalSystemPromptChars
  ) {
    warnings.push({
      kind: "system_prompt_large",
      totalChars: input.systemPromptChars,
      warnChars: input.config.warnTotalSystemPromptChars,
    });
  }

  const truncated = projectContext.truncatedFiles.length > 0
    || projectContext.omittedFiles.length > 0
    || skills.truncatedDescriptions.length > 0
    || skills.omittedFromPrompt.length > 0;

  const fingerprint = JSON.stringify({
    e: input.config.enabled,
    pc: [
      projectContext.truncatedFiles.map((item) => [item.path, item.originalChars, item.keptChars]),
      projectContext.omittedFiles,
    ],
    sk: [skills.truncatedDescriptions, skills.omittedFromPrompt],
    lg: warnings.some((warning) => warning.kind === "system_prompt_large")
      ? input.config.warnTotalSystemPromptChars
      : 0,
  });

  return {
    enabled: input.config.enabled,
    projectContext,
    skills,
    ...(typeof input.systemPromptChars === "number" ? { systemPromptChars: input.systemPromptChars } : {}),
    truncated,
    warnings,
    fingerprint,
  };
}
