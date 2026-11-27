"use client";

import { useLayoutEffect, useRef } from "react";

/** A visible browser belongs to its conversation, not the next selection. */
export function useBrowserPanelNavigation(scope: string, activeTab: string, setOpen: (open: boolean) => void) {
  const previousScope = useRef(scope);
  useLayoutEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope;
    // Hide before paint; retained native tabs remain available when explicitly
    // opening the browser again. Other workspace tools keep their own behavior.
    if (activeTab === "browser") setOpen(false);
  }, [scope, activeTab, setOpen]);
}
