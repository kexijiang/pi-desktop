import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProjectContextBudget,
  applySkillsPromptBudget,
  buildPromptBudgetReport,
  DEFAULT_PROMPT_BUDGET_CONFIG,
  parsePromptBudgetConfigPatch,
  normalizePromptBudgetConfig,
} from "./budget.ts";

const config = (patch = {}) => ({ ...DEFAULT_PROMPT_BUDGET_CONFIG, ...patch });

test("project context budget favors cwd files and preserves the original order", () => {
  const files = [
    { path: "global/AGENTS.md", content: "G".repeat(900) },
    { path: "parent/AGENTS.md", content: "P".repeat(900) },
    { path: "cwd/AGENTS.md", content: "C".repeat(900) },
  ];
  const result = applyProjectContextBudget({ agentsFiles: files }, config({
    projectContextPerFileMaxChars: 0,
    projectContextTotalMaxChars: 1_200,
  }));
  assert.deepEqual(result.agentsFiles.map((file) => file.path), ["parent/AGENTS.md", "cwd/AGENTS.md"]);
  const cwd = result.agentsFiles.find((file) => file.path === "cwd/AGENTS.md");
  assert.equal(cwd.content, "C".repeat(900), "cwd file is allocated first and kept whole");
  const parent = result.agentsFiles.find((file) => file.path === "parent/AGENTS.md");
  assert.match(parent.content, /\[Truncated: omitted \d+ chars from parent\/AGENTS\.md\. Use the read tool/);
  assert.deepEqual(result.report.omittedFiles, ["global/AGENTS.md"]);
  assert.equal(result.report.truncatedFiles.length, 1);
});

test("project context truncation is deterministic and disabled budgets pass through", () => {
  const files = [{ path: "AGENTS.md", content: `${"line\n".repeat(5_000)}` }];
  const first = applyProjectContextBudget({ agentsFiles: files }, config({ projectContextPerFileMaxChars: 1_000 }));
  const second = applyProjectContextBudget({ agentsFiles: files }, config({ projectContextPerFileMaxChars: 1_000 }));
  assert.deepEqual(first, second);
  assert.doesNotMatch(first.agentsFiles[0].content, /\d{4}-\d{2}-\d{2}T/);
  const off = applyProjectContextBudget({ agentsFiles: files }, config({ enabled: false }));
  assert.equal(off.agentsFiles[0].content, files[0].content);
  assert.equal(off.report.truncatedFiles.length, 0);
  assert.equal(files[0].content.length, 25_000, "input is not mutated");
});

test("skills budget keeps every skill but hides overflow from automatic injection", () => {
  const skills = Array.from({ length: 5 }, (_, index) => ({
    name: `skill-${index}`,
    description: `Does thing ${index}. ${"detail ".repeat(100)}`,
    filePath: `/skills/${index}/SKILL.md`,
    disableModelInvocation: index === 4,
  }));
  const result = applySkillsPromptBudget({ skills, diagnostics: [] }, config({ skillsMaxCount: 2, skillDescriptionMaxChars: 40 }));
  assert.equal(result.skills.length, 5, "no skill is removed, so /skill:name keeps working");
  assert.deepEqual(result.skills.map((skill) => skill.disableModelInvocation), [false, false, true, true, true]);
  assert.ok(result.skills[0].description.length <= 40);
  assert.match(result.skills[0].description, /…$/);
  assert.equal(result.skills[0].filePath, skills[0].filePath);
  assert.deepEqual(result.report.omittedFromPrompt, ["skill-2", "skill-3"]);
  assert.equal(skills[2].disableModelInvocation, false, "input skills are not mutated");
});

test("skills total character budget omits trailing visible skills", () => {
  const skills = Array.from({ length: 4 }, (_, index) => ({ name: `s${index}`, description: "x".repeat(100), disableModelInvocation: false }));
  const result = applySkillsPromptBudget({ skills, diagnostics: [] }, config({ skillsMaxCount: 0, skillDescriptionMaxChars: 0, skillsTotalMaxChars: 250 }));
  assert.deepEqual(result.report.omittedFromPrompt, ["s2", "s3"]);
  assert.equal(result.skills.filter((skill) => !skill.disableModelInvocation).length, 2);
});

test("budget report exposes warnings and a stable fingerprint", () => {
  const { report: projectContext } = applyProjectContextBudget(
    { agentsFiles: [{ path: "AGENTS.md", content: "a".repeat(50_000) }] },
    config(),
  );
  const report = buildPromptBudgetReport({ config: config(), projectContext, systemPromptChars: 60_000 });
  assert.equal(report.truncated, true);
  assert.deepEqual(report.warnings.map((warning) => warning.kind), ["project_context_truncated", "system_prompt_large"]);
  assert.equal(report.fingerprint, buildPromptBudgetReport({ config: config(), projectContext, systemPromptChars: 61_000 }).fingerprint);
  const quiet = buildPromptBudgetReport({ config: config(), systemPromptChars: 10 });
  assert.equal(quiet.truncated, false);
  assert.deepEqual(quiet.warnings, []);
});

test("budget settings validate strictly and normalize leniently", () => {
  assert.deepEqual(parsePromptBudgetConfigPatch({ skillsMaxCount: 10, enabled: false }), { skillsMaxCount: 10, enabled: false });
  assert.throws(() => parsePromptBudgetConfigPatch({ skillsMaxCount: -1 }), /between/);
  assert.throws(() => parsePromptBudgetConfigPatch({ skillsMaxCount: 1.5 }), /integer/);
  assert.throws(() => parsePromptBudgetConfigPatch({ bogus: 1 }), /Unknown prompt budget/);
  assert.throws(() => parsePromptBudgetConfigPatch({ enabled: "yes" }), /boolean/);
  assert.throws(() => parsePromptBudgetConfigPatch([]), /object/);
  assert.deepEqual(normalizePromptBudgetConfig({ skillsMaxCount: "x", enabled: false }), { ...DEFAULT_PROMPT_BUDGET_CONFIG, enabled: false });
});
