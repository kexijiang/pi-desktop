import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateContextUsageBreakdown,
  estimateSessionContextUsage,
  mergeContextUsageWithEstimate,
} from "./context-usage.ts";

test("estimates context from the latest assistant usage plus trailing messages", () => {
  const usage = estimateSessionContextUsage([
    { role: "user", content: "old message" },
    {
      role: "assistant",
      provider: "openai",
      model: "gpt-5",
      content: [{ type: "text", text: "answer" }],
      usage: {
        input: 1_000,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    { role: "user", content: "12345678" },
  ], 10_000);

  assert.deepEqual(usage, { tokens: 1_802, contextWindow: 10_000, percent: 18.02 });
});

test("estimates a new session without assistant usage", () => {
  const usage = estimateSessionContextUsage([
    { role: "user", content: "12345678" },
  ], 100);

  assert.deepEqual(usage, { tokens: 2, contextWindow: 100, percent: 2 });
  assert.equal(estimateSessionContextUsage([], 0), null);
});

test("estimates the model context without counting archived messages in the transcript", () => {
  const archived = { role: "user", content: "old ".repeat(10_000) };
  const retained = { role: "user", content: "retained" };
  const checkpoint = { role: "custom", customType: "compaction", content: "summary", details: { firstKeptEntryId: "retained" } };
  const current = { role: "user", content: "current" };
  assert.deepEqual(
    estimateSessionContextUsage([archived, retained, checkpoint, current], 100_000, ["old", "retained", "checkpoint", "current"]),
    estimateSessionContextUsage([checkpoint, retained, current], 100_000),
  );
});

test("Pi structured system entries are not counted again as conversation tokens", () => {
  const prompt = "Base prompt with sections";
  const tools = [{ name: "read", description: "Read", parameters: { type: "object" } }];
  const messages = [{ role: "user", content: "hello" }];
  const input = { messages, systemPrompt: prompt, tools, totalTokens: null };
  const baseline = estimateContextUsageBreakdown(input);
  assert.deepEqual(estimateContextUsageBreakdown({ ...input, messages: [
    { role: "system", content: prompt, toolsAdded: tools, timestamp: 1 }, ...messages,
    { role: "system", content: "", sections: { rules: "Section rules" }, timestamp: 2 },
  ] }), baseline);
});

test("prefers a provider-native total over overlapping cache fields", () => {
  const usage = estimateSessionContextUsage([
    {
      role: "assistant",
      provider: "compatible-gateway",
      model: "example-model",
      content: [{ type: "text", text: "answer" }],
      usage: {
        input: 26_000,
        output: 100,
        cacheRead: 26_000,
        cacheWrite: 0,
        totalTokens: 26_100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  ], 100_000);

  assert.deepEqual(usage, { tokens: 26_100, contextWindow: 100_000, percent: 26.1 });
});

test("separates project instructions, tools, messages, and runtime overhead", () => {
  const breakdown = estimateContextUsageBreakdown({
    systemPrompt: "Base prompt\n\n<project_context>\n<project_instructions path=\"AGENTS.md\">\nProject rules\n</project_instructions>\n</project_context>\n",
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "hello" }],
    totalTokens: 1_000,
  });

  assert.ok(breakdown.systemPrompt > 0);
  assert.ok(breakdown.projectInstructions > 0);
  assert.ok(breakdown.toolDefinitions > 0);
  assert.ok(breakdown.conversationMessages > 0);
  assert.ok(breakdown.otherRuntime > 0);
  assert.equal(Object.values(breakdown).reduce((sum, value) => sum + value, 0), 1_000);
});

test("adds optimistic trailing content to the conversation breakdown", () => {
  const usage = mergeContextUsageWithEstimate({
    tokens: 100,
    contextWindow: 1_000,
    percent: 10,
    breakdown: {
      systemPrompt: 30,
      projectInstructions: 20,
      toolDefinitions: 30,
      conversationMessages: 10,
      otherRuntime: 10,
    },
  }, {
    tokens: 125,
    contextWindow: 1_000,
    percent: 12.5,
  });

  assert.equal(usage.tokens, 125);
  assert.equal(usage.breakdown.conversationMessages, 35);
  assert.equal(Object.values(usage.breakdown).reduce((sum, value) => sum + value, 0), 125);
});

test("separates skills and addendum and keeps literal tags inside project context from being misclassified", () => {
  const systemPrompt = [
    "Base prompt",
    "<addendum>\nrun-time note\n</addendum>",
    "<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path=\"AGENTS.md\">\nMention <skills>fake</skills> and <addendum>fake</addendum> literally\n</project_instructions>\n</project_context>",
    "<skills>\nreal skill list\n</skills>",
    "<cwd>\n/tmp\n</cwd>",
  ].join("\n\n");
  const breakdown = estimateContextUsageBreakdown({ systemPrompt, tools: [], messages: [], totalTokens: 2_000 });
  assert.ok(breakdown.skills > 0);
  assert.ok(breakdown.addendum > 0);
  assert.ok(breakdown.projectInstructions > breakdown.skills, "literal tags stay inside project instructions");
  assert.ok(breakdown.projectInstructions > breakdown.addendum);
  assert.equal(Object.values(breakdown).reduce((sum, value) => sum + value, 0), 2_000);
});

test("prefers structured system sections over parsing the rendered string", () => {
  const messages = [{
    role: "system", content: "",
    sections: {
      preamble: "Preamble",
      tools: "<tools>\nx\n</tools>",
      addendum: "<addendum>\n" + "a".repeat(400) + "\n</addendum>",
      skills: "<skills>\n" + "s".repeat(800) + "\n</skills>",
    },
    timestamp: 1,
  }];
  const breakdown = estimateContextUsageBreakdown({ systemPrompt: "ignored", tools: [], messages, totalTokens: null });
  assert.ok(breakdown.skills >= 200);
  assert.ok(breakdown.addendum >= 100 && breakdown.addendum < breakdown.skills);
});

test("breakdown stays conserved when estimates exceed the provider total", () => {
  const breakdown = estimateContextUsageBreakdown({
    systemPrompt: "<skills>\n" + "s".repeat(4_000) + "\n</skills>\n\n<addendum>\n" + "a".repeat(4_000) + "\n</addendum>",
    tools: [], messages: [{ role: "user", content: "u".repeat(4_000) }], totalTokens: 500,
  });
  assert.equal(Object.values(breakdown).reduce((sum, value) => sum + value, 0), 500);
});
