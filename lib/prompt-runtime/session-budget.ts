import {
  applyProjectContextBudget,
  applySkillsPromptBudget,
  buildPromptBudgetReport,
  emptyProjectContextReport,
  emptySkillsReport,
  type AgentsContextFileLike,
  type BudgetSkillLike,
  type PromptBudgetConfig,
  type PromptBudgetProjectContextReport,
  type PromptBudgetReport,
  type PromptBudgetSkillsReport,
} from "./budget.ts";
import { readRuntimePromptSettings } from "./settings.ts";

/**
 * Per-ResourceLoader budget state. The loader callbacks run during
 * `reload()`, long before the session wrapper exists, so the latest report is
 * kept here and read back by the wrapper through the loader instance.
 */
export interface SessionPromptBudgetTracker {
  readonly agentsFilesOverride: <T extends AgentsContextFileLike>(base: { agentsFiles: T[] }) => { agentsFiles: T[] };
  readonly skillsOverride: <S extends BudgetSkillLike, D>(base: { skills: S[]; diagnostics: D[] }) => { skills: S[]; diagnostics: D[] };
  report(systemPromptChars?: number): PromptBudgetReport;
}

const trackers = new WeakMap<object, SessionPromptBudgetTracker>();

export function createSessionPromptBudgetTracker(
  readConfig: () => PromptBudgetConfig = () => readRuntimePromptSettings().budget,
): SessionPromptBudgetTracker {
  let projectContext: PromptBudgetProjectContextReport = emptyProjectContextReport();
  let skills: PromptBudgetSkillsReport = emptySkillsReport();
  return {
    agentsFilesOverride(base) {
      const result = applyProjectContextBudget(base, readConfig());
      projectContext = result.report;
      return { agentsFiles: result.agentsFiles };
    },
    skillsOverride(base) {
      const result = applySkillsPromptBudget(base, readConfig());
      skills = result.report;
      return { skills: result.skills, diagnostics: result.diagnostics };
    },
    report(systemPromptChars) {
      return buildPromptBudgetReport({ config: readConfig(), projectContext, skills, systemPromptChars });
    },
  };
}

export function bindPromptBudgetTracker(resourceLoader: object, tracker: SessionPromptBudgetTracker): void {
  trackers.set(resourceLoader, tracker);
}

export function readPromptBudgetReport(resourceLoader: object | undefined, systemPromptChars?: number): PromptBudgetReport | null {
  if (!resourceLoader) return null;
  return trackers.get(resourceLoader)?.report(systemPromptChars) ?? null;
}
