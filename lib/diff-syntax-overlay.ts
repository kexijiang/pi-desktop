import type { CSSProperties } from "react";
import type { InlineDiffRange } from "./diff-inline";

export interface SyntaxHastNode {
  type: "text" | "element";
  value?: string;
  tagName?: string;
  properties?: {
    className?: string[] | string;
    style?: CSSProperties;
  };
  children?: SyntaxHastNode[];
}

export interface TextRangePiece {
  text: string;
  changed: boolean;
}

/**
 * Splits a text leaf spanning `[baseOffset, baseOffset + value.length)` along
 * sorted disjoint changed character ranges so whole-line Prism tokens stay
 * intact while changed words receive inline `<mark>` overlays.
 */
export function splitTextByChangedRanges(
  value: string,
  baseOffset: number,
  ranges: readonly InlineDiffRange[],
): TextRangePiece[] {
  if (!value || ranges.length === 0) {
    return value ? [{ text: value, changed: false }] : [];
  }
  const endOffset = baseOffset + value.length;
  const pieces: TextRangePiece[] = [];
  let cursor = baseOffset;

  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start >= endOffset) break;
    const overlapStart = Math.max(cursor, range.start);
    const overlapEnd = Math.min(endOffset, range.end);
    if (overlapStart > cursor) {
      pieces.push({ text: value.slice(cursor - baseOffset, overlapStart - baseOffset), changed: false });
    }
    if (overlapEnd > overlapStart) {
      pieces.push({ text: value.slice(overlapStart - baseOffset, overlapEnd - baseOffset), changed: true });
    }
    cursor = overlapEnd;
  }

  if (cursor < endOffset) {
    pieces.push({ text: value.slice(cursor - baseOffset), changed: false });
  }
  return pieces;
}

/** Resolves Prism token class names against a react-syntax-highlighter stylesheet. */
export function resolvePrismTokenStyle(
  className: string[] | string | undefined,
  baseStyle: CSSProperties | undefined,
  stylesheet: Record<string, CSSProperties>,
): CSSProperties | undefined {
  const names = (Array.isArray(className) ? className : typeof className === "string" ? className.split(/\s+/) : [])
    .filter((entry) => entry && entry !== "token");
  if (names.length === 0) return baseStyle;

  let merged: CSSProperties | undefined = baseStyle ? { ...baseStyle } : undefined;
  const apply = (key: string) => {
    const rule = stylesheet[key];
    if (!rule) return;
    merged = merged ? Object.assign(merged, rule) : { ...rule };
  };
  for (const name of names) apply(name);
  if (names.length >= 2) {
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < names.length; j++) {
        if (i !== j) apply(`${names[i]}.${names[j]}`);
      }
    }
  }
  return merged;
}
