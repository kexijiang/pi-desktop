import type { Root, RootContent } from "mdast";
import type { VFile } from "vfile";

// Deliberately recognize command + known subcommand, never prose mentioning
// a tool, shell operators alone, or arbitrary HTML. This only changes display.
const COMMAND = /^(?:adb(?:\.exe)?\s+(?:(?:-s|-t)\s+\S+\s+)?(?:devices|install|uninstall|shell|push|pull|logcat|connect|disconnect|reboot|version)\b|git\s+(?:status|diff|log|show|add|commit|checkout|switch|branch|fetch|pull|push|clone)\b|(?:npm|pnpm|yarn)\s+(?:run|install|add|test|build|exec)\b)/i;

/** Preserve literal source before HTML/entity parsing can eat placeholders. */
export function remarkShellCommands() {
  return (tree: Root, file: VFile) => {
    const source = String(file);
    function transform(parent: { children: RootContent[] }) {
      parent.children = parent.children.map(node => {
        if (node.type === "paragraph" && node.position) {
          const start = node.position.start.offset, end = node.position.end.offset;
          if (start !== undefined && end !== undefined) {
            const value = source.slice(start, end);
            if (value.split(/\r?\n/).every(line => COMMAND.test(line.trimStart()))) {
              return { type: "code", lang: "sh", value, position: node.position };
            }
          }
        }
        if ("children" in node) transform(node as { children: RootContent[] });
        return node;
      });
    }
    transform(tree);
  };
}
