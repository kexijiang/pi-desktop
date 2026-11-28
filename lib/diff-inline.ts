import { diffWordsWithSpace } from "diff";
import type { DiffFile, DiffLine } from "./diff-parse";

export interface InlineDiffSegment {
  text: string;
  changed: boolean;
}

export interface InlineDiffRange {
  start: number;
  end: number;
}

export interface InlineDiffBudgetOptions {
  maxPairs?: number;
  maxBudgetMs?: number;
}

export const MAX_INLINE_DIFF_LINE_LENGTH = 500;
export const DEFAULT_MAX_INLINE_DIFF_PAIRS = 80;
export const DEFAULT_MAX_INLINE_DIFF_BUDGET_MS = 16;
const MAX_INLINE_DIFF_EDIT_LENGTH = 160;
const SINGLE_PAIR_TIMEOUT_MS = 4;
const MAX_CHANGED_RATIO = 0.78;

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function computePairSegments(
  removedText: string,
  addedText: string,
): { removed: InlineDiffSegment[]; added: InlineDiffSegment[] } | null {
  if (!removedText || !addedText) return null;
  if (removedText.length > MAX_INLINE_DIFF_LINE_LENGTH || addedText.length > MAX_INLINE_DIFF_LINE_LENGTH) {
    return null;
  }
  const parts = diffWordsWithSpace(removedText, addedText, {
    maxEditLength: MAX_INLINE_DIFF_EDIT_LENGTH,
    timeout: SINGLE_PAIR_TIMEOUT_MS,
  });
  if (!parts) return null;
  const removed: InlineDiffSegment[] = [];
  const added: InlineDiffSegment[] = [];
  let removedChanged = 0;
  let addedChanged = 0;
  let sharedChars = 0;

  for (const part of parts) {
    if (!part.value) continue;
    if (part.removed) {
      removed.push({ text: part.value, changed: true });
      removedChanged += part.value.length;
    } else if (part.added) {
      added.push({ text: part.value, changed: true });
      addedChanged += part.value.length;
    } else {
      removed.push({ text: part.value, changed: false });
      added.push({ text: part.value, changed: false });
      sharedChars += part.value.trim().length;
    }
  }

  // When two paired lines share virtually no non-whitespace content, highlighting
  // the entire line as an inline pill adds visual noise instead of clarity.
  if (sharedChars === 0) return null;
  if (removedChanged === 0 && addedChanged === 0) return null;
  const removedRatio = removedChanged / Math.max(1, removedText.length);
  const addedRatio = addedChanged / Math.max(1, addedText.length);
  if (removedRatio > MAX_CHANGED_RATIO && addedRatio > MAX_CHANGED_RATIO) return null;

  return { removed, added };
}

export function segmentsToChangedRanges(segments: readonly InlineDiffSegment[]): InlineDiffRange[] {
  const ranges: InlineDiffRange[] = [];
  let offset = 0;
  for (const segment of segments) {
    const end = offset + segment.text.length;
    if (segment.changed && end > offset) {
      const previous = ranges[ranges.length - 1];
      if (previous && previous.end === offset) {
        previous.end = end;
      } else {
        ranges.push({ start: offset, end });
      }
    }
    offset = end;
  }
  return ranges;
}

interface SharedBudgetState {
  startedAt: number;
  maxBudgetMs: number;
  remainingPairs: number;
}

function appendInlineDiffForLines(
  lines: readonly DiffLine[],
  result: Map<DiffLine, InlineDiffSegment[]>,
  budget: SharedBudgetState,
): void {
  let removedBlock: DiffLine[] = [];
  let addedBlock: DiffLine[] = [];

  const flush = () => {
    const pairCount = Math.min(removedBlock.length, addedBlock.length);
    for (let index = 0; index < pairCount; index++) {
      if (budget.remainingPairs <= 0 || nowMs() - budget.startedAt >= budget.maxBudgetMs) {
        budget.remainingPairs = 0;
        break;
      }
      const removedLine = removedBlock[index]!;
      const addedLine = addedBlock[index]!;
      if (
        removedLine.text.length > MAX_INLINE_DIFF_LINE_LENGTH
        || addedLine.text.length > MAX_INLINE_DIFF_LINE_LENGTH
      ) {
        continue;
      }
      budget.remainingPairs -= 1;
      const pair = computePairSegments(removedLine.text, addedLine.text);
      if (!pair) continue;
      result.set(removedLine, pair.removed);
      result.set(addedLine, pair.added);
    }
    removedBlock = [];
    addedBlock = [];
  };

  for (const line of lines) {
    if (budget.remainingPairs <= 0) break;
    if (line.kind === "removed") {
      if (addedBlock.length > 0) flush();
      removedBlock.push(line);
    } else if (line.kind === "added") {
      addedBlock.push(line);
    } else {
      flush();
    }
  }
  flush();
}

/**
 * Computes IDEA-style intra-line word diff segments for paired removed/added
 * lines inside a hunk, bounded by pair count and wall-clock time so large
 * patches never jank initial render.
 */
export function buildInlineDiffMap(
  lines: readonly DiffLine[],
  options?: InlineDiffBudgetOptions,
): Map<DiffLine, InlineDiffSegment[]> {
  const result = new Map<DiffLine, InlineDiffSegment[]>();
  const budget: SharedBudgetState = {
    startedAt: nowMs(),
    maxBudgetMs: options?.maxBudgetMs ?? DEFAULT_MAX_INLINE_DIFF_BUDGET_MS,
    remainingPairs: options?.maxPairs ?? DEFAULT_MAX_INLINE_DIFF_PAIRS,
  };
  appendInlineDiffForLines(lines, result, budget);
  return result;
}

/**
 * Computes intra-line word diff segments across all hunks of a parsed patch
 * under a single shared pair and wall-clock time budget.
 */
export function buildInlineDiffMapForFiles(
  files: readonly DiffFile[],
  options?: InlineDiffBudgetOptions,
): Map<DiffLine, InlineDiffSegment[]> {
  const result = new Map<DiffLine, InlineDiffSegment[]>();
  const budget: SharedBudgetState = {
    startedAt: nowMs(),
    maxBudgetMs: options?.maxBudgetMs ?? DEFAULT_MAX_INLINE_DIFF_BUDGET_MS,
    remainingPairs: options?.maxPairs ?? DEFAULT_MAX_INLINE_DIFF_PAIRS,
  };
  for (const file of files) {
    if (budget.remainingPairs <= 0) break;
    for (const hunk of file.hunks) {
      if (budget.remainingPairs <= 0) break;
      appendInlineDiffForLines(hunk.lines, result, budget);
    }
  }
  return result;
}
