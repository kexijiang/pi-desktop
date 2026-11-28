"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { parseSideChatTabId, type SideChatTabId } from "@/components/side-chat/side-chat-events";
import { isWorkflowSidePanelTab, type WorkflowSidePanelTab } from "@/components/workflow/workflow-events";

const STORAGE_KEY = "piora-right-panel-layouts-v1";
const TOOL_TABS = ["automation", "review", "files", "commands", "ssh", "browser", "design", "harmony"] as const;
export type RightPanelToolTab = typeof TOOL_TABS[number];
export type RightPanelTab = "home" | RightPanelToolTab | WorkflowSidePanelTab | SideChatTabId;
type TemporaryRightPanelTab = WorkflowSidePanelTab | SideChatTabId;

interface RightPanelLayout {
  open: boolean;
  maximized: boolean;
  activeTab: Exclude<RightPanelTab, WorkflowSidePanelTab>;
  openTools: RightPanelToolTab[];
  pendingTab?: TemporaryRightPanelTab;
}

const emptyLayout: RightPanelLayout = { open: false, maximized: false, activeTab: "home", openTools: [] };
type LayoutsByScope = Record<string, RightPanelLayout>;

export function rightPanelLayoutScope(sessionId?: string | null, roomId?: string | null): string {
  if (roomId) return `room:${roomId}`;
  return sessionId ? `session:${sessionId}` : "draft";
}

function isToolTab(value: unknown): value is RightPanelToolTab {
  return typeof value === "string" && (TOOL_TABS as readonly string[]).includes(value);
}

function dismissWorkflowTab(layout: RightPanelLayout): RightPanelLayout {
  return isWorkflowSidePanelTab(layout.pendingTab) ? { ...layout, pendingTab: undefined } : layout;
}

function readStoredLayout(value: unknown): RightPanelLayout {
  if (!value || typeof value !== "object") return emptyLayout;
  const stored = value as Partial<Omit<RightPanelLayout, "activeTab"> & { activeTab: unknown }>;
  const tab = stored.activeTab;
  const openTools = Array.isArray(stored.openTools) ? [...new Set(stored.openTools.filter(isToolTab))] : [];
  const activeTab = isToolTab(tab) ? tab
    : typeof tab === "string" && parseSideChatTabId(tab)?.kind === "live" ? tab as SideChatTabId
    : isWorkflowSidePanelTab(tab) ? openTools.at(-1) ?? "home" : "home";
  if (isToolTab(activeTab) && !openTools.includes(activeTab)) openTools.push(activeTab);
  return { open: stored.open === true, maximized: stored.open === true && stored.maximized === true, activeTab, openTools };
}

export function useRightPanelLayout(scope: string, initialScope: string, workflowSessionId?: string | null) {
  const [layouts, setLayouts] = useState<LayoutsByScope | null>(null);
  const [legacySideChatTab, setLegacySideChatTab] = useState<SideChatTabId | null>(null);
  const scopeRef = useRef(scope);
  useLayoutEffect(() => {
    const previousScope = scopeRef.current;
    scopeRef.current = scope;
    setLayouts((current) => {
      const before = current?.[previousScope];
      if (!before) return current;
      const after = dismissWorkflowTab(before);
      return before === after ? current : { ...current, [previousScope]: after };
    });
  }, [scope, workflowSessionId]);

  useEffect(() => {
    const restored: LayoutsByScope = {};
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as LayoutsByScope;
        for (const [key, value] of Object.entries(saved)) {
          if (key === "draft" || key.startsWith("session:") || key.startsWith("room:")) restored[key] = readStoredLayout(value);
        }
      } else {
        const tab = window.localStorage.getItem("piora-right-panel-tab");
        const open = window.localStorage.getItem("piora-right-panel-open");
        if (tab || open !== null) {
          restored[initialScope] = readStoredLayout({ open: open === "true", activeTab: isToolTab(tab) ? tab : "home" });
          if (tab && parseSideChatTabId(tab)?.kind === "live") setLegacySideChatTab(tab as SideChatTabId);
        }
      }
    } catch { /* Panel layout remains usable when browser storage is unavailable. */ }
    setLayouts((current) => ({ ...restored, ...current }));
  }, [initialScope]);

  useEffect(() => {
    if (!layouts) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layouts, (key, value) => key === "pendingTab" ? undefined : value));
    } catch { /* Keep the layout in memory if storage is unavailable. */ }
  }, [layouts]);

  const updateLayout = useCallback((update: (current: RightPanelLayout) => RightPanelLayout) => {
    const owner = scopeRef.current;
    setLayouts((current) => {
      const before = current?.[owner] ?? emptyLayout;
      const after = update(before);
      return before === after ? current : { ...current, [owner]: after };
    });
  }, []);

  const setRightPanelOpen = useCallback((action: SetStateAction<boolean>) => updateLayout((current) => {
    const open = typeof action === "function" ? action(current.open) : action;
    const layout = open ? current : dismissWorkflowTab(current);
    return open === layout.open ? layout : { ...layout, open, maximized: open && layout.maximized };
  }), [updateLayout]);
  const setRightPanelMaximized = useCallback((maximized: boolean) => updateLayout((current) => (
    !current.open || current.maximized === maximized ? current : { ...current, maximized }
  )), [updateLayout]);
  const setRightPanelTab = useCallback((tab: RightPanelTab) => updateLayout((current) => {
    if (isWorkflowSidePanelTab(tab)) return current.pendingTab === tab ? current : { ...current, pendingTab: tab };
    if (parseSideChatTabId(tab)?.kind === "loading") return { ...current, pendingTab: tab as SideChatTabId };
    const openTools = isToolTab(tab) && !current.openTools.includes(tab) ? [...current.openTools, tab] : current.openTools;
    return tab === current.activeTab && !current.pendingTab && openTools === current.openTools
      ? current : { ...current, activeTab: tab, openTools, pendingTab: undefined };
  }), [updateLayout]);
  const setOpenRightPanelTools = useCallback((action: SetStateAction<RightPanelToolTab[]>) => updateLayout((current) => {
    const openTools = typeof action === "function" ? action(current.openTools) : action;
    return openTools === current.openTools ? current : { ...current, openTools };
  }), [updateLayout]);
  const promoteDraftRightPanel = useCallback((sessionId: string) => {
    if (scopeRef.current !== "draft") return;
    const target = rightPanelLayoutScope(sessionId);
    setLayouts((current) => current?.[target] || !current?.draft ? current : { ...current, [target]: dismissWorkflowTab(current.draft) });
  }, []);
  const clearLegacySideChatTab = useCallback(() => setLegacySideChatTab(null), []);
  const closeWorkflowTab = useCallback(() => updateLayout(dismissWorkflowTab), [updateLayout]);

  const layout = layouts?.[scope] ?? emptyLayout;
  return {
    rightPanelOpen: layout.open,
    rightPanelTab: layout.pendingTab ?? layout.activeTab,
    rightPanelMaximized: layout.maximized,
    openRightPanelTools: layout.openTools,
    restoredSideChatTab: scope === initialScope && layout.activeTab === "home" && !layout.pendingTab ? legacySideChatTab : null,
    setRightPanelOpen, setRightPanelTab, setRightPanelMaximized, setOpenRightPanelTools, promoteDraftRightPanel, clearLegacySideChatTab, closeWorkflowTab,
  };
}
