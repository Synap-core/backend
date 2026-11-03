/**
 * The agent's why under a question, drawn ONCE for every ask card
 * (`AskAnswer`). A why that carries a shell line (an act ask: "run the curl
 * line in this card's why") shows that line in a monospace block that wraps
 * inside the card and selects whole, so a long URL never runs past the edge
 * (the founder saw the line cut off, 3 Nov 2026).
 */

/** A command starts at `curl` / `wget` + a flag or URL, or at a `$ ` prompt. */
const COMMAND_START = /(?:^|\s)((?:curl|wget)\s+(?:-|https?:)|\$\s+\S)/;

export interface ContextParts {
  /** The words before the command; null when the why is all command. */
  prose: string | null;
  /** The shell line, from its first word to the end; null when there is none. */
  command: string | null;
}

export function splitContextCommand(context: string): ContextParts {
  const match = COMMAND_START.exec(context);
  if (!match) return { prose: context.trim() || null, command: null };
  const start = match.index + match[0].length - match[1]!.length;
  const prose = context.slice(0, start).trim();
  const command = context
    .slice(start)
    .replace(/^\$\s+/, "")
    .trim();
  return { prose: prose || null, command: command || null };
}

export function AskContext({ context }: { context: string }) {
  const { prose, command } = splitContextCommand(context);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {prose && (
        <p className="text-pretty break-words text-[13px] leading-relaxed text-foreground/75">
          {prose}
        </p>
      )}
      {command && (
        <pre
          data-ask-command
          className="m-0 select-all whitespace-pre-wrap break-all rounded-md bg-foreground/[0.05] px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground/85 ring-1 ring-inset ring-foreground/10"
        >
          {command}
        </pre>
      )}
    </div>
  );
}
