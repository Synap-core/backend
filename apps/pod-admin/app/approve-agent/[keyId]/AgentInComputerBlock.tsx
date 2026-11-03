"use client";

/**
 * `/approve-agent` — the agent inside its computer (0395, D6/D7): which
 * computer, engine and job, which OS user, how its changes will land, and
 * that nothing else on the computer changes. What it shows is
 * `agent-in-computer` (tested); this file only draws it.
 */

import { Button } from "@heroui/react";
import { Laptop } from "lucide-react";
import type { AgentWriteMode } from "@synap-core/types/agents";
import { WriteModeChoice } from "../../_lib/write-mode-choice";
import { shownWriteMode, type AgentInComputerView } from "./agent-in-computer";

export function AgentInComputerBlock({
  view,
  writeMode,
  onWriteMode,
  isDisabled,
}: {
  view: AgentInComputerView;
  writeMode: AgentWriteMode | null;
  onWriteMode: (m: AgentWriteMode | null) => void;
  isDisabled?: boolean;
}) {
  const shown = shownWriteMode(view, writeMode);
  const question = `How ${view.name}'s changes land`;
  return (
    <section
      className="flex flex-col gap-2.5 rounded-lg px-4 py-3 ring-1 ring-inset ring-foreground/10"
      data-testid="agent-in-computer"
    >
      <p className="flex items-center gap-1.5 text-small font-medium text-foreground">
        <Laptop
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 text-foreground/65"
        />
        <span>
          {view.isNew ? "Adds" : "Reconnects"} {view.name}
        </span>
      </p>
      {view.seat && (
        <p className="text-small text-foreground/65">Runs as {view.seat}.</p>
      )}
      {shown ? (
        <WriteModeChoice
          label={question}
          value={shown}
          onChange={onWriteMode}
          isDisabled={isDisabled}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-small text-foreground/85">
            Keeps its permission
            {view.currentModeLabel ? `: ${view.currentModeLabel}` : ""}.
          </p>
          <Button
            size="sm"
            variant="light"
            isDisabled={isDisabled}
            onPress={() => onWriteMode(view.currentMode ?? "pod-default")}
          >
            Change…
          </Button>
        </div>
      )}
      <p className="text-small text-foreground/65">{view.nothingElse}</p>
    </section>
  );
}
