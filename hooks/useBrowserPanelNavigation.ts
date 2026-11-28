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
    // Different saved layouts already restore their own visibility. Within one
    // layout, hide the browser when changing the room member or starting a draft.
    if (before.scope !== scope && before.layoutScope === layoutScope && activeTab === "browser") {
      setOpen(false);
    }
  }, [scope, layoutScope, activeTab, setOpen]);
}
