"use client";

import { useLayoutEffect, useRef } from "react";

/** A visible browser belongs to its conversation, not the next selection. */
export function useBrowserPanelNavigation(
  scope: string,
  activeTab: string,
  setOpen: (open: boolean) => void,
  layoutScope?: string,
) {
  const previous = useRef({ scope, layoutScope });
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { scope, layoutScope };
    // Different saved session/room layouts restore their own visibility.
    // Within one layout — or whenever entering a fresh draft session — never
    // carry an open browser panel forward.
    if (
      before.scope !== scope
      && activeTab === "browser"
      && (before.layoutScope === layoutScope || layoutScope === "draft")
    ) {
      setOpen(false);
    }
  }, [scope, layoutScope, activeTab, setOpen]);
}
