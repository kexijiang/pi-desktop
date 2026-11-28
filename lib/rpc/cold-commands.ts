import { DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { resolveSessionAgentRuntimeProfile } from "../agent-profile-store";
import type { AgentRuntimeProfile } from "../agent-runtime-profile";
import { createChatCommandCatalog, templateUsesArguments } from "../chat-command-input";
import { applyExtensionLoadPlan, resolveExtensionLoadPlan } from "../extension-config";
import { NativeMcpController } from "../native-mcp";
import { isLegacyNotesSession } from "../notes-session";
import { resolveSessionPath } from "../session-reader";
import { SessionRuntimeResolverError } from "../session-runtime-resolver";

/**
 * Load slash command metadata for an idle/unstarted session without creating an
 * AgentSession, emitting `session_start`, or spawning MCP stdio servers.
 */
export async function readColdSessionCommands(
  sessionId: string,
  runtimeProfile: AgentRuntimeProfile,
) {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) {
    throw new SessionRuntimeResolverError("SESSION_NOT_FOUND", `Session ${sessionId} not found.`);
  }
  await resolveSessionAgentRuntimeProfile(sessionId, runtimeProfile);
  const manager = SessionManager.open(filePath);
  const entries = manager.getEntries();
  if (isLegacyNotesSession(entries) || runtimeProfile === "device-control") {
    return { commands: [] as SlashCommandInfo[], catalog: createChatCommandCatalog([]) };
  }

  const cwd = manager.getCwd() || process.cwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const plan = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: runtimeProfile });
  const nativeMcp = new NativeMcpController(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: plan.enabledPaths,
    noExtensions: true,
    extensionFactories: nativeMcp.factories,
    extensionsOverride: (result) => applyExtensionLoadPlan(result, plan),
  });
  await loader.reload();

  const commands: SlashCommandInfo[] = [];
  const seenExtensions = new Set<string>();
  const loaded = applyExtensionLoadPlan(loader.getExtensions(), plan);
  for (const extension of loaded.extensions) {
    for (const registered of extension.commands.values()) {
      const name = (registered as { invocationName?: string; name?: string }).invocationName ?? registered.name;
      if (!name || seenExtensions.has(name)) continue;
      seenExtensions.add(name);
      commands.push({
        name,
        description: registered.description,
        source: "extension",
        sourceInfo: extension.sourceInfo,
      });
    }
  }
  const templates = loader.getPrompts().prompts;
  for (const template of templates) {
    commands.push({
      name: template.name,
      description: template.description,
      source: "prompt",
      sourceInfo: template.sourceInfo,
    });
  }
  for (const skill of loader.getSkills().skills) {
    commands.push({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill",
      sourceInfo: skill.sourceInfo,
    });
  }
  const catalog = createChatCommandCatalog(commands.map(item => {
    const template = item.source === "prompt" ? templates.find(candidate => candidate.name === item.name) : undefined;
    return {
      ...item,
      ...(template?.argumentHint ? { argumentHint: template.argumentHint } : {}),
      ...(template?.content !== undefined ? { usesTemplateArguments: templateUsesArguments(template.content) } : {}),
    };
  }));
  return { commands, catalog };
}
