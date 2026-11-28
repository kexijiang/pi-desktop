import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { fileRevision } from "./jsonl-file-index.ts";
import { DEFAULT_WORKFLOW_TURN_BUDGET, type WorkflowRun, type WorkflowSnapshot } from "./workflow-types.ts";

export interface WorkflowRecord { schemaVersion: 1; epoch: string; snapshot: WorkflowSnapshot; actions: string[] }
export class WorkflowStateCorruptError extends Error {
  readonly code = "WORKFLOW_STATE_CORRUPT";
  readonly status = 500;
  constructor(message = "Invalid workflow state; refusing to reset it") {
    super(message);
    this.name = "WorkflowStateCorruptError";
  }
}
const host = globalThis as typeof globalThis & {
  __pioraWorkflowEpoch?: string;
  __pioraWorkflowLastResetAt?: number;
};
export const workflowEpoch = host.__pioraWorkflowEpoch ??= randomUUID();

function nextWorkflowResetGeneration(): number {
  const next = Math.max(Date.now(), (host.__pioraWorkflowLastResetAt ?? 0) + 1);
  host.__pioraWorkflowLastResetAt = next;
  return next;
}

export function settleActiveDuration(run: WorkflowRun, now = Date.now()): void {
  if (typeof run.activeSince === "number" && Number.isFinite(run.activeSince)) {
    run.timeUsedMs = (run.timeUsedMs ?? 0) + Math.max(0, now - run.activeSince);
    run.activeSince = null;
  }
}

export class WorkflowStore {
  readonly plansDirectory: string;

  constructor(
    readonly directory: string = join(getAgentDir(), "piora", "workflows"),
    plansDirectory?: string,
  ) {
    const defaultWorkflowDir = join(getAgentDir(), "piora", "workflows");
    this.plansDirectory = plansDirectory ?? (
      directory === defaultWorkflowDir
        ? join(getAgentDir(), "piora", "plans")
        : join(directory, "plans")
    );
  }

  private path(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid workflow session id");
    return join(this.directory, `${sessionId}.json`);
  }

  read(sessionId: string): WorkflowRecord {
    let record: WorkflowRecord;
    try { record = JSON.parse(readFileSync(this.path(sessionId), "utf8")) as WorkflowRecord; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, epoch: workflowEpoch, actions: [], snapshot: { sessionId, revision: 0, mode: "agent", turnBudget: DEFAULT_WORKFLOW_TURN_BUDGET, current: null, history: [] } };
      }
      if (error instanceof SyntaxError) throw new WorkflowStateCorruptError("Invalid workflow state; refusing to reset it");
      throw error;
    }
    if (!record || typeof record !== "object" || record.schemaVersion !== 1 || record.snapshot?.sessionId !== sessionId || !Number.isSafeInteger(record.snapshot.revision)
      || !["agent", "plan", "goal"].includes(record.snapshot.mode) || !Array.isArray(record.snapshot.history) || !Array.isArray(record.actions)) {
      throw new WorkflowStateCorruptError("Invalid workflow state; refusing to reset it");
    }
    // Reading history never starts a model or replays an execution from a dead host.
    if (record.epoch !== workflowEpoch) {
      const now = Date.now();
      const run = record.snapshot.current;
      if (run && ["running", "planning"].includes(run.status)) {
        settleActiveDuration(run, now);
        run.status = "paused";
        run.reason = "host_restarted";
        run.updatedAt = now;
      }
      if (record.snapshot.autoContinuing) delete record.snapshot.autoContinuing;
      // Even an unchanged review snapshot needs a fresh user action identity.
      // A click queued by the previous process must not become execution here.
      record.snapshot.revision++;
      record.epoch = workflowEpoch;
      this.write(record);
    }
    return record;
  }

  write(record: WorkflowRecord): void {
    const path = this.path(record.snapshot.sessionId);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(path, JSON.stringify(record));
  }

  resetCorruptState(sessionId: string): WorkflowRecord {
    const target = this.path(sessionId);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (existsSync(target)) {
      const backup = join(this.directory, `${sessionId}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.bak`);
      renameSync(target, backup);
    }
    const fresh: WorkflowRecord = {
      schemaVersion: 1,
      epoch: workflowEpoch,
      actions: [],
      snapshot: {
        sessionId,
        revision: 0,
        resetAt: nextWorkflowResetGeneration(),
        mode: "agent",
        turnBudget: DEFAULT_WORKFLOW_TURN_BUDGET,
        current: null,
        history: [],
      },
    };
    this.write(fresh);
    return fresh;
  }
  fileRevision(sessionId: string): string {
    try {
      const stat = statSync(this.path(sessionId), { throwIfNoEntry: false });
      return stat ? `${workflowEpoch}:${fileRevision(stat)}` : `${workflowEpoch}:missing`;
    } catch {
      return `${workflowEpoch}:invalid`;
    }
  }
}

export function readWorkflowSnapshot(sessionId: string): WorkflowSnapshot { return new WorkflowStore().read(sessionId).snapshot; }
export function readWorkflowFileRevision(sessionId: string): string { return new WorkflowStore().fileRevision(sessionId); }
export function resetCorruptWorkflowState(sessionId: string): WorkflowSnapshot { return new WorkflowStore().resetCorruptState(sessionId).snapshot; }
