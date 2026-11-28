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

function withoutDraft(layouts: LayoutsByScope): LayoutsByScope {
  if (!("draft" in layouts)) return layouts;
  const next = { ...layouts };
  delete next.draft;
  return next;
}

export function useRightPanelLayout(
  scope: string,
  initialScope: string,
  workflowSessionId?: string | null,
  conversationScope?: string,
) {
  const [layouts, setLayouts] = useState<LayoutsByScope | null>(null);
  const [legacySideChatTab, setLegacySideChatTab] = useState<SideChatTabId | null>(null);
  const scopeRef = useRef(scope);
  const conversationScopeRef = useRef(conversationScope);
  useLayoutEffect(() => {
    const previousScope = scopeRef.current;
    const previousConversationScope = conversationScopeRef.current;
    scopeRef.current = scope;
    conversationScopeRef.current = conversationScope;
    setLayouts((current) => {
      if (!current) return current;
      // Leaving an unpromoted draft, or starting a fresh draft conversation,
      // discards the ephemeral draft layout so a new session never inherits a
      // previously opened browser or tool tab.
      if (
        (previousScope === "draft" && scope !== "draft")
        || (scope === "draft" && conversationScope !== undefined && previousConversationScope !== conversationScope)
      ) {
        return withoutDraft(current);
      }
      const before = current[previousScope];
      if (!before) return current;
      const after = dismissWorkflowTab(before);
      return before === after ? current : { ...current, [previousScope]: after };
    });
  }, [scope, workflowSessionId, conversationScope]);

  useEffect(() => {
    const restored: LayoutsByScope = {};
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as LayoutsByScope;
        for (const [key, value] of Object.entries(saved)) {
          // Never restore ephemeral "draft" layouts across reloads or new sessions.
          if (key.startsWith("session:") || key.startsWith("room:")) restored[key] = readStoredLayout(value);
        }
      } else {
        const tab = window.localStorage.getItem("piora-right-panel-tab");
        const open = window.localStorage.getItem("piora-right-panel-open");
        if (tab || open !== null) {
          if (initialScope !== "draft") {
            restored[initialScope] = readStoredLayout({ open: open === "true", activeTab: isToolTab(tab) ? tab : "home" });
            if (tab && parseSideChatTabId(tab)?.kind === "live") setLegacySideChatTab(tab as SideChatTabId);
          } else if (tab !== "browser" && open === "true" && isToolTab(tab)) {
            restored[initialScope] = readStoredLayout({ open: true, activeTab: tab });
          }
        }
      }
    } catch { /* Panel layout remains usable when browser storage is unavailable. */ }
    setLayouts((current) => ({ ...restored, ...current }));
  }, [initialScope]);

  useEffect(() => {
    if (!layouts) return;
    try {
      const persistent = withoutDraft(layouts);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persistent, (key, value) => key === "pendingTab" ? undefined : value));
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
    setLayouts((current) => {
      if (!current?.draft) return current;
      const promoted = dismissWorkflowTab(current.draft);
      const next = withoutDraft(current);
      if (!next[target]) next[target] = promoted;
      return next;
    });
  }, []);
  const resetDraftRightPanel = useCallback(() => {
    setLayouts((current) => (current ? withoutDraft(current) : current));
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
    setRightPanelOpen,
    setRightPanelTab,
    setRightPanelMaximized,
    setOpenRightPanelTools,
    promoteDraftRightPanel,
    resetDraftRightPanel,
    clearLegacySideChatTab,
    closeWorkflowTab,
  };
}
