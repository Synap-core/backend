/**
 * The agent's why under a question, drawn ONCE for every ask card
 * (`AskAnswer`). It wraps inside the card (a long URL never runs past the
 * edge: the founder saw the curl line cut off, 3 Nov 2026) and keeps the
 * agent's line breaks. A fenced block (three backticks) is a command: it
 * draws in a selectable, wrapping monospace block.
 */
import type { ReactNode } from "react";

const FENCE = /```[^\n`]*\n?([\s\S]*?)```/g;

export type ContextPart =
  { kind: "text"; text: string } | { kind: "code"; text: string };

export function contextParts(context: string): ContextPart[] {
  const parts: ContextPart[] = [];
  let at = 0;
  for (const m of context.matchAll(FENCE)) {
    const text = context.slice(at, m.index).trim();
    if (text) parts.push({ kind: "text", text });
    const code = m[1]!.trim();
    if (code) parts.push({ kind: "code", text: code });
    at = m.index + m[0].length;
  }
  const rest = context.slice(at).trim();
  if (rest) parts.push({ kind: "text", text: rest });
  return parts;
}

export function AskContext({ context }: { context: string }): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {contextParts(context).map((part, i) =>
        part.kind === "code" ? (
          <pre
            key={i}
            data-ask-command
            className="m-0 select-all whitespace-pre-wrap break-all rounded-md bg-foreground/[0.05] px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground/85 ring-1 ring-inset ring-foreground/10"
          >
            {part.text}
          </pre>
        ) : (
          <p
            key={i}
            className="whitespace-pre-wrap text-pretty break-words text-[13px] leading-relaxed text-foreground/75"
          >
            {part.text}
          </p>
        )
      )}
    </div>
  );
}
