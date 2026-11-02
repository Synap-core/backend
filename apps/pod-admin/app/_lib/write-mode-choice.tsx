"use client";

/**
 * How an agent's changes land — the ONE choice pod admin offers wherever a
 * person adds an agent or changes how its writes land (the `/device` approval;
 * the agent page). The rows are `AGENT_WRITE_MODE_CHOICES`
 * (@synap-core/types/agents): this file draws them and writes no label of its
 * own.
 *
 * Progressive disclosure: the recommended choice (normal) is shown with its
 * one sentence; the others are one click away ("Show all 3"). A current value
 * that is not the recommended one is always shown, so the person sees what is
 * set without opening anything.
 */

import { Button, Radio, RadioGroup } from "@heroui/react";
import { useState } from "react";
import {
  AGENT_WRITE_MODE_CHOICES,
  isAgentWriteMode,
  type AgentWriteMode,
} from "@synap-core/types/agents";

/** The rows to draw: the recommended one and the current one, or all. */
export function visibleWriteModeChoices(
  value: AgentWriteMode,
  expanded: boolean
) {
  return expanded
    ? AGENT_WRITE_MODE_CHOICES
    : AGENT_WRITE_MODE_CHOICES.filter((c) => c.recommended || c.mode === value);
}

export function WriteModeChoice({
  value,
  onChange,
  label,
  isDisabled,
}: {
  value: AgentWriteMode;
  onChange: (mode: AgentWriteMode) => void;
  /** The section's question, e.g. "How their changes land". */
  label: string;
  isDisabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = visibleWriteModeChoices(value, expanded);
  const hidden = AGENT_WRITE_MODE_CHOICES.length - shown.length;
  return (
    <div className="flex flex-col gap-1.5">
      <RadioGroup
        aria-label={label}
        size="sm"
        value={value}
        isDisabled={isDisabled}
        onValueChange={(v) => {
          if (isAgentWriteMode(v)) onChange(v);
        }}
      >
        {shown.map((c) => (
          <Radio key={c.mode} value={c.mode} description={c.line}>
            {c.label}
            {c.recommended ? (
              <span className="ml-1.5 text-tiny text-foreground/65">
                (recommended)
              </span>
            ) : null}
          </Radio>
        ))}
      </RadioGroup>
      {hidden > 0 && (
        <Button
          variant="light"
          size="sm"
          className="min-h-10 self-start"
          onPress={() => setExpanded(true)}
        >
          {`Show all ${AGENT_WRITE_MODE_CHOICES.length}`}
        </Button>
      )}
    </div>
  );
}
