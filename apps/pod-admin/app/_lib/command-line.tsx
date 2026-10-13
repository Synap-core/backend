"use client";

/**
 * A command a person runs in a terminal somewhere else (on a computer, on
 * the machine hosting the pod), in mono with its one Copy. The console never
 * runs host commands; this is how it hands one over — the same on Computers
 * and Updates.
 */

import { CopyButton } from "./copy-button";

export function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <code className="min-w-0 max-w-full break-all rounded-md bg-foreground/[0.06] px-2.5 py-1.5 font-mono text-[12px] text-foreground">
        {command}
      </code>
      <CopyButton
        text={command}
        label="Copy"
        variant="light"
        ariaLabel={`Copy ${command}`}
      />
    </div>
  );
}
