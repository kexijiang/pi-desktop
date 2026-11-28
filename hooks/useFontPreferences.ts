"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  CODE_FONT_SIZES,
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  DEFAULT_FONT_PREFERENCE,
  FONT_PREFERENCE_STORAGE_KEY,
  UI_FONT_PRESETS,
  UI_FONT_SIZES,
  UI_FONT_WEIGHTS,
  isCodeFontSize,
  isUiFontId,
  isUiFontSize,
  isUiFontWeight,
  parseStoredFontPreference,
  serializeFontPreference,
  type CodeFontSize,
  type FontPreference,
  type UiFontId,
  type UiFontSize,
  type UiFontWeight,
} from "@/lib/font-preferences";

const listeners = new Set<() => void>();
const SERVER_SNAPSHOT = `${DEFAULT_FONT_PREFERENCE.family}:${DEFAULT_FONT_PREFERENCE.size}:${DEFAULT_FONT_PREFERENCE.codeSize}:${DEFAULT_FONT_PREFERENCE.weight}`;
let storageListenerAttached = false;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function readDocumentPreference(): FontPreference {
  if (typeof document === "undefined") return { ...DEFAULT_FONT_PREFERENCE };
  const familyValue = document.documentElement.dataset.uiFont;
  const sizeValue = Number(document.documentElement.dataset.uiFontSize);
  const codeSizeValue = Number(document.documentElement.dataset.codeFontSize);
  const weightValue = Number(document.documentElement.dataset.uiFontWeight);
  return {
    schemaVersion: 1,
    family: isUiFontId(familyValue) ? familyValue : DEFAULT_FONT_PREFERENCE.family,
    size: isUiFontSize(sizeValue) ? sizeValue : DEFAULT_FONT_PREFERENCE.size,
    codeSize: isCodeFontSize(codeSizeValue) ? codeSizeValue : DEFAULT_FONT_PREFERENCE.codeSize,
    weight: isUiFontWeight(weightValue) ? weightValue : DEFAULT_FONT_PREFERENCE.weight,
  };
}

function getSnapshot(): string {
  const preference = readDocumentPreference();
  return `${preference.family}:${preference.size}:${preference.codeSize}:${preference.weight}`;
}

function getServerSnapshot(): string {
  return SERVER_SNAPSHOT;
}

function applyPreference(preference: FontPreference, persist = true): void {
  const root = document.documentElement;
  root.dataset.uiFont = preference.family;
  root.dataset.uiFontSize = String(preference.size);
  root.dataset.codeFontSize = String(preference.codeSize);
  root.dataset.uiFontWeight = String(preference.weight);
  root.style.setProperty("--ui-font-size", `${preference.size}px`);
  root.style.setProperty("--code-font-size", `${preference.codeSize}px`);
  root.style.setProperty("--code-line-number-font-size", `${Math.max(11, preference.codeSize - 2)}px`);
  root.style.setProperty("--ui-font-weight", String(preference.weight));
  if (persist) {
    try {
      localStorage.setItem(FONT_PREFERENCE_STORAGE_KEY, serializeFontPreference(preference));
    } catch {
      // Preference still applies for the current renderer session.
    }
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageListenerAttached && typeof window !== "undefined") {
    storageListenerAttached = true;
    window.addEventListener("storage", (event) => {
      if (event.key !== FONT_PREFERENCE_STORAGE_KEY) return;
      applyPreference(parseStoredFontPreference(event.newValue), false);
    });
  }
  return () => listeners.delete(listener);
}

export function useFontPreferences() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [familyPart, sizePart, codeSizePart, weightPart] = snapshot.split(":");
  const weight = Number(weightPart);
  const preference: FontPreference = {
    schemaVersion: 1,
    family: isUiFontId(familyPart) ? familyPart : DEFAULT_FONT_PREFERENCE.family,
    size: isUiFontSize(Number(sizePart)) ? Number(sizePart) as UiFontSize : DEFAULT_FONT_PREFERENCE.size,
    codeSize: isCodeFontSize(Number(codeSizePart)) ? Number(codeSizePart) as CodeFontSize : DEFAULT_FONT_PREFERENCE.codeSize,
    weight: isUiFontWeight(weight) ? weight : DEFAULT_FONT_PREFERENCE.weight,
  };

  useEffect(() => {
    let stored = { ...DEFAULT_FONT_PREFERENCE };
    try {
      stored = parseStoredFontPreference(localStorage.getItem(FONT_PREFERENCE_STORAGE_KEY));
    } catch {
      // Keep the pre-paint/default preference when storage is unavailable.
    }
    applyPreference(stored, false);
  }, []);

  const setFamily = useCallback((family: UiFontId) => {
    if (!isUiFontId(family)) return;
    applyPreference({ ...readDocumentPreference(), family });
  }, []);

  const setSize = useCallback((size: UiFontSize) => {
    if (!isUiFontSize(size)) return;
    applyPreference({ ...readDocumentPreference(), size });
  }, []);

  const setCodeSize = useCallback((codeSize: CodeFontSize) => {
    if (!isCodeFontSize(codeSize)) return;
    applyPreference({ ...readDocumentPreference(), codeSize });
  }, []);

  const stepCodeSize = useCallback((delta: number) => {
    const current = readDocumentPreference();
    const next = Math.max(CODE_FONT_SIZE_MIN, Math.min(CODE_FONT_SIZE_MAX, current.codeSize + delta));
    if (next === current.codeSize) return;
    applyPreference({ ...current, codeSize: next });
  }, []);

  const reset = useCallback(() => {
    applyPreference({ ...DEFAULT_FONT_PREFERENCE });
  }, []);

  const setWeight = useCallback((weight: UiFontWeight) => {
    if (!isUiFontWeight(weight)) return;
    applyPreference({ ...readDocumentPreference(), weight });
  }, []);

  return {
    preference,
    presets: UI_FONT_PRESETS,
    sizes: UI_FONT_SIZES,
    codeSizes: CODE_FONT_SIZES,
    weights: UI_FONT_WEIGHTS,
    setFamily,
    setSize,
    setCodeSize,
    stepCodeSize,
    setWeight,
    reset,
  };
}
