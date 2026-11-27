import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { isLegacyNotesSession, assertNotesSessionCommand, notesSessionResourceOptions } =
  await createJiti(import.meta.url).import("./notes-session.ts");

test("older notes keep their restrictions across branches", () => {
  const note = { type: "custom", customType: "piora-remote-policy", data: { policy: "notes" } };
  const laterEntry = { ...note, data: { policy: "agent" } };
  assert.equal(isLegacyNotesSession([note, laterEntry]), true);
  assert.equal(isLegacyNotesSession([laterEntry]), false);
  assert.equal(isLegacyNotesSession([]), false);
});

test("older notes accept plain text and exclude tool and workspace resources", () => {
  for (const type of ["bash", "set_tools", "set_capabilities", "fork", "reload", "set_system_prompt"]) {
    assert.throws(() => assertNotesSessionCommand(true, { type }), /disabled/);
  }
  assert.throws(() => assertNotesSessionCommand(true, { type: "prompt", message: " /some-extension" }), /plain messages/);
  assert.doesNotThrow(() => assertNotesSessionCommand(true, { type: "prompt", message: "Summarize this note" }));
  assert.doesNotThrow(() => assertNotesSessionCommand(false, { type: "bash" }));
  const resources = notesSessionResourceOptions();
  for (const key of ["noExtensions", "noSkills", "noPromptTemplates", "noThemes", "noContextFiles"]) {
    assert.equal(resources[key], true);
  }
  assert.deepEqual(resources.additionalExtensionPaths, []);
});
