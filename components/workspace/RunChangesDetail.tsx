"use client";

import { useEffect, useMemo, useState } from "react";
import { useFontPreferences } from "@/hooks/useFontPreferences";
import { useI18n } from "@/hooks/useI18n";
import { parseUnifiedDiff } from "@/lib/diff-parse";
import { CODE_FONT_SIZE_MAX, CODE_FONT_SIZE_MIN, DEFAULT_CODE_FONT_SIZE } from "@/lib/font-preferences";
import type { RunPatchUnavailableReason } from "@/lib/file-changes/run-patch";
import type { PromptFileChange, PromptFileChanges } from "@/lib/prompt-file-changes";
import { AliIcon } from "../AliIcon";
import { DiffView } from "../DiffView";
import styles from "./WorkspacePanel.module.css";

const RUN_DIFF_MODE_KEY = "piora-run-diff-mode";
const RUN_DIFF_WRAP_KEY = "piora-run-diff-wrap";

type DiffMode = "unified" | "split";

function formatRelativeDirectory(filePath: string, cwd?: string): string | null {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const slash = normalizedPath.lastIndexOf("/");
  const fullDir = slash > 0 ? normalizedPath.slice(0, slash) : "";
  if (!cwd) return fullDir || null;
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedPath.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)) {
    const relative = normalizedPath.slice(normalizedCwd.length + 1);
    const relSlash = relative.lastIndexOf("/");
    return relSlash > 0 ? relative.slice(0, relSlash) : null;
  }
  return fullDir || null;
}

function readStoredMode(): DiffMode {
  try {
    return window.localStorage.getItem(RUN_DIFF_MODE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

function readStoredWrap(): boolean {
  try {
    return window.localStorage.getItem(RUN_DIFF_WRAP_KEY) === "true";
  } catch {
    return false;
  }
}

export function RunChangesDetail({
  snapshot,
  file,
  active,
  onOpenFile,
  onOpenReview,
  onRefreshRunChanges,
}: {
  snapshot: PromptFileChanges | null;
  file: PromptFileChange | undefined;
  active: boolean;
  onOpenFile: (path: string, name: string, options?: { line?: number }) => void;
  onOpenReview?: () => void;
  onRefreshRunChanges?: () => void;
}) {
  const { t } = useI18n();
  const { preference, setCodeSize, stepCodeSize } = useFontPreferences();
  const sessionId = snapshot?.sessionId;
  const runId = snapshot?.runId;
  const path = file?.path;
  const revision = file?.patchRevision;
  const [retryCount, setRetryCount] = useState(0);
  const key = JSON.stringify([sessionId, runId, path, revision, retryCount]);
  const [loaded, setLoaded] = useState<{
    key: string;
    patch: string | null;
    unavailableReason?: RunPatchUnavailableReason;
    error?: boolean;
  } | null>(null);
  const [mode, setMode] = useState<DiffMode>("unified");
  const [wrap, setWrap] = useState(false);
  const [hunkCursor, setHunkCursor] = useState(0);
  const [revealDiffLine, setRevealDiffLine] = useState<{ line: number; key: number } | null>(null);
  const current = loaded?.key === key ? loaded : null;

  useEffect(() => {
    setMode(readStoredMode());
    setWrap(readStoredWrap());
  }, []);

  useEffect(() => {
    setHunkCursor(0);
    setRevealDiffLine(null);
  }, [key]);

  useEffect(() => {
    if (!active || !sessionId || !runId || !path || !revision) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ runId, path });
    void fetch(`/api/agent/${encodeURIComponent(sessionId)}/changes?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 409) {
          const payload = await response.json().catch(() => ({})) as { code?: string };
          if (payload.code === "RUN_SUPERSEDED") {
            onRefreshRunChanges?.();
          }
          throw new Error(`HTTP ${response.status}`);
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { patch: string | null; unavailableReason?: RunPatchUnavailableReason };
        if (!controller.signal.aborted) {
          setLoaded({ key, patch: data.patch, unavailableReason: data.unavailableReason });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ key, patch: null, error: true });
      });
    return () => controller.abort();
  }, [active, key, onRefreshRunChanges, path, revision, runId, sessionId]);

  const patchNavigation = useMemo(() => {
    if (!current?.patch) return { hunkLines: [] as number[], firstFileLine: 1 };
    const parsed = parseUnifiedDiff(current.patch);
    const hunkLines: number[] = [];
    let firstFileLine = 1;
    let foundFirstLine = false;
    let offset = 0;
    for (const parsedFile of parsed.files) {
      for (const hunk of parsedFile.hunks) {
        const firstChangedOffset = hunk.lines.findIndex((line) => line.kind === "added" || line.kind === "removed");
        const targetOffset = firstChangedOffset >= 0 ? firstChangedOffset : 0;
        if (hunk.lines.length > 0) {
          hunkLines.push(offset + targetOffset + 1);
        }
        if (!foundFirstLine) {
          // Prefer the first added line in the same change block; for pure deletions,
          // jump to the nearest surviving new-side line instead of leading context.
          const firstAdded = hunk.lines.find((line) => line.kind === "added" && line.newLine != null);
          if (firstAdded?.newLine != null) {
            firstFileLine = firstAdded.newLine;
          } else if (firstChangedOffset >= 0) {
            const after = hunk.lines.slice(firstChangedOffset + 1).find((line) => line.newLine != null);
            const before = [...hunk.lines.slice(0, firstChangedOffset)].reverse().find((line) => line.newLine != null);
            firstFileLine = after?.newLine ?? before?.newLine ?? Math.max(1, hunk.newStart || hunk.oldStart || 1);
          } else {
            firstFileLine = Math.max(1, hunk.newStart || hunk.oldStart || 1);
          }
          foundFirstLine = true;
        }
        offset += hunk.lines.length;
      }
    }
    return { hunkLines, firstFileLine };
  }, [current?.patch]);

  if (!file) {
    const label = !snapshot ? "files.runNever" : snapshot.status === "running" ? "files.runPending"
      : snapshot.status === "unavailable" ? "files.runUnavailable" : "files.runEmpty";
    return <div className={styles.empty}>{t(label)}</div>;
  }

  const name = file.path.replace(/\\/g, "/").split("/").pop() ?? file.path;
  const directory = formatRelativeDirectory(file.path, snapshot?.cwd);
  const unavailableReason = current?.unavailableReason ?? file.unavailableReason;
  const unavailableCopy = unavailableReason
    ? t(`files.runDiffReason.${unavailableReason}`)
    : t("files.runDiffUnavailable");

  const updateMode = (nextMode: DiffMode) => {
    setMode(nextMode);
    try { window.localStorage.setItem(RUN_DIFF_MODE_KEY, nextMode); } catch { /* ignore */ }
  };

  const toggleWrap = () => {
    setWrap((currentWrap) => {
      const nextWrap = !currentWrap;
      try { window.localStorage.setItem(RUN_DIFF_WRAP_KEY, String(nextWrap)); } catch { /* ignore */ }
      return nextWrap;
    });
  };

  const jumpHunk = (delta: number) => {
    const total = patchNavigation.hunkLines.length;
    if (total === 0) return;
    const nextIndex = (hunkCursor + delta + total) % total;
    setHunkCursor(nextIndex);
    setRevealDiffLine({ line: patchNavigation.hunkLines[nextIndex]!, key: Date.now() });
  };

  const hasStats = (file.additions ?? 0) > 0 || (file.deletions ?? 0) > 0;
  const hunkCount = patchNavigation.hunkLines.length;

  return <section className={styles.runDiff} aria-label={t("files.runFileDiff")} data-run-file-diff>
    <header className={styles.runDiffHeader}>
      <div className={styles.runDiffIdentity} title={file.path}>
        <span className={styles.runDiffName}>{name}</span>
        {directory ? <span className={styles.runDiffPath}>{directory}</span> : null}
        {hasStats ? (
          <span className={styles.runDiffStats}>
            {(file.additions ?? 0) > 0 ? <span className={styles.additions}>+{file.additions}</span> : null}
            {(file.deletions ?? 0) > 0 ? <span className={styles.deletions}>−{file.deletions}</span> : null}
          </span>
        ) : null}
      </div>
      <div className={styles.runDiffToolbar}>
        {hunkCount > 1 ? (
          <div className={styles.runDiffToolGroup} role="group" aria-label={t("files.runFileDiff")}>
            <button type="button" className={styles.runDiffToolBtn} title={t("files.runDiffPrevHunk")} aria-label={t("files.runDiffPrevHunk")} onClick={() => jumpHunk(-1)}>
              <AliIcon name="arrowup" size={12} />
            </button>
            <span className={styles.runDiffToolMeta}>{hunkCursor + 1}/{hunkCount}</span>
            <button type="button" className={styles.runDiffToolBtn} title={t("files.runDiffNextHunk")} aria-label={t("files.runDiffNextHunk")} onClick={() => jumpHunk(1)}>
              <AliIcon name="arrowdown" size={12} />
            </button>
          </div>
        ) : null}
        {current?.patch ? (
          <div className={styles.runDiffToolGroup} role="group">
            <button type="button" className={styles.runDiffToolBtn} aria-pressed={mode === "unified"} onClick={() => updateMode("unified")}>
              {t("files.runDiffUnified")}
            </button>
            <button type="button" className={styles.runDiffToolBtn} aria-pressed={mode === "split"} onClick={() => updateMode("split")}>
              {t("files.runDiffSplit")}
            </button>
          </div>
        ) : null}
        {current?.patch ? (
          <button type="button" className={styles.runDiffToolBtn} aria-pressed={wrap} title={t("files.runDiffWrap")} onClick={toggleWrap}>
            {t("files.runDiffWrap")}
          </button>
        ) : null}
        <div className={styles.runDiffToolGroup} role="group">
          <button
            type="button"
            className={styles.runDiffToolBtn}
            disabled={preference.codeSize <= CODE_FONT_SIZE_MIN}
            title={t("files.runDiffZoomOut")}
            aria-label={t("files.runDiffZoomOut")}
            onClick={() => stepCodeSize(-1)}
          >
            A−
          </button>
          <button
            type="button"
            className={styles.runDiffToolBtn}
            title={t("files.runDiffResetZoom")}
            onClick={() => setCodeSize(DEFAULT_CODE_FONT_SIZE)}
          >
            {preference.codeSize}px
          </button>
          <button
            type="button"
            className={styles.runDiffToolBtn}
            disabled={preference.codeSize >= CODE_FONT_SIZE_MAX}
            title={t("files.runDiffZoomIn")}
            aria-label={t("files.runDiffZoomIn")}
            onClick={() => stepCodeSize(1)}
          >
            A+
          </button>
        </div>
        {file.kind !== "deleted" && (
          <button
            type="button"
            className="ui-button"
            onClick={() => onOpenFile(file.path, name, { line: patchNavigation.firstFileLine })}
          >
            {t("files.runOpenFile")}
          </button>
        )}
      </div>
    </header>
    <div className={styles.runDiffBody}>
      {revision && !current ? <div className={styles.empty} role="status">{t("files.runDiffLoading")}</div>
        : current?.patch ? (
          <DiffView
            key={key}
            patch={current.patch}
            filePath={file.path}
            mode={mode}
            wrap={wrap}
            showFileHeader={false}
            revealDiffLine={revealDiffLine}
            onOpenFile={(targetPath, line) => onOpenFile(targetPath, name, { line })}
          />
        )
        : (
          <div className={styles.runDiffFallback} role={current?.error ? "alert" : undefined}>
            <p>{current?.error ? t("files.runDiffFailed") : unavailableCopy}</p>
            <div className={styles.runDiffFallbackActions}>
              {current?.error ? (
                <button
                  type="button"
                  className="ui-button"
                  onClick={() => {
                    onRefreshRunChanges?.();
                    setRetryCount((count) => count + 1);
                  }}
                >
                  {t("files.runDiffRetry")}
                </button>
              ) : null}
              {file.kind !== "deleted" ? (
                <button type="button" className="ui-button" onClick={() => onOpenFile(file.path, name)}>
                  {t("files.runOpenFile")}
                </button>
              ) : null}
              {onOpenReview ? (
                <button type="button" className="ui-button" onClick={onOpenReview}>
                  {t("files.reviewAll")}
                </button>
              ) : null}
            </div>
          </div>
        )}
    </div>
  </section>;
}
