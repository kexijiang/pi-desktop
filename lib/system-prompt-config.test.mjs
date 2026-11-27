import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const config = await jiti.import("./system-prompt-config.ts");

test("legacy global prompts migrate into a default reusable template", () => {
  const root = mkdtempSync(join(tmpdir(), "piora-system-prompt-legacy-"));
  const path = join(root, "system-prompt.json");
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      prompt: "Always verify changes.",
      updatedAt: "2026-08-31T00:00:00.000Z",
    }), "utf8");
    const migrated = config.readSystemPromptConfig(path);
    assert.equal(migrated.templates.length, 1);
    assert.equal(migrated.templates[0].prompt, "Always verify changes.");
    assert.equal(migrated.defaultTemplateId, migrated.templates[0].id);
    assert.equal(migrated.selectorVisible, true);

    config.updateSystemPromptTemplate(migrated.templates[0].id, { name: "Verifier" }, path);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("templates support create, update, default selection, and deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "piora-system-prompt-library-"));
  const path = join(root, "piora", "system-prompt.json");
  try {
    const created = config.createSystemPromptTemplate("Reviewer", "Review carefully.", path);
    const template = created.templates[0];
    assert.equal(created.defaultTemplateId, template.id);

    const updated = config.updateSystemPromptTemplate(template.id, {
      name: "Strict reviewer",
      prompt: "Review and run tests.",
    }, path);
    assert.equal(updated.templates[0].prompt, "Review and run tests.");
    assert.equal(config.resolveSystemPromptSelection(updated, { mode: "default" }).templateName, "Strict reviewer");

    const piDefault = config.setDefaultSystemPromptTemplate(null, path);
    assert.equal(piDefault.defaultTemplateId, null);
    assert.equal(config.setSystemPromptSelectorVisible(false, path).selectorVisible, false);
    assert.equal(config.readSystemPromptConfig(path).selectorVisible, false);
    assert.throws(() => config.setSystemPromptSelectorVisible("false", path), /must be a boolean/);
    assert.equal(config.deleteSystemPromptTemplate(template.id, path).templates.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and unsafe prompt configs fail closed to Pi defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "piora-system-prompt-invalid-"));
  const path = join(root, "system-prompt.json");
  try {
    writeFileSync(path, "{not-json", "utf8");
    assert.deepEqual(config.readSystemPromptConfig(path).templates, []);
    assert.throws(
      () => config.createSystemPromptTemplate("Too long", "x".repeat(config.SYSTEM_PROMPT_MAX_LENGTH + 1), path),
      /must not exceed/,
    );
    assert.throws(() => config.createSystemPromptTemplate("Unsafe", "bad\0prompt", path), /null characters/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version 2 configs created before the selector setting remain visible", () => {
  const root = mkdtempSync(join(tmpdir(), "piora-system-prompt-visibility-"));
  const path = join(root, "system-prompt.json");
  try {
    writeFileSync(path, JSON.stringify({
      version: 2,
      templates: [],
      defaultTemplateId: null,
      updatedAt: null,
    }), "utf8");
    assert.equal(config.readSystemPromptConfig(path).selectorVisible, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("system prompt templates default new entries to append and keep legacy entries on replace", () => {
  const root = mkdtempSync(join(tmpdir(), "piora-system-prompt-apply-mode-"));
  const path = join(root, "piora", "system-prompt.json");
  try {
    const created = config.createSystemPromptTemplate("Lean", "Be terse.", path);
    assert.equal(created.templates[0].applyMode, "append");
    assert.equal(config.resolveSystemPromptSelection(created, { mode: "default" }).applyMode, "append");
    const switched = config.updateSystemPromptTemplate(created.templates[0].id, { applyMode: "replace" }, path);
    assert.equal(switched.templates[0].applyMode, "replace");
    assert.throws(() => config.updateSystemPromptTemplate(created.templates[0].id, { applyMode: "merge" }, path), /apply mode/);
    assert.throws(() => config.createSystemPromptTemplate("Bad", "x", path, { applyMode: 1 }), /apply mode/);

    writeFileSync(path, JSON.stringify({
      version: 2, templates: [{ id: "old", name: "Old", prompt: "Old prompt", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
      defaultTemplateId: "old", selectorVisible: true, updatedAt: null,
    }), "utf8");
    const stored = config.readSystemPromptConfig(path);
    assert.equal(stored.templates[0].applyMode, undefined);
    assert.equal(config.resolveSystemPromptSelection(stored, { mode: "default" }).applyMode, "replace");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
