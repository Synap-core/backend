"use client";

/**
 * "When an AI uses it" on a tool's page (lane W3, decision b387ca45 §5): for
 * the whole tool and for each action, every AI's mode and the exceptions
 * (one agent, a class, a space), each a door to its agent with its way back.
 * It reads the approval rows (`tool-approvals-model.ts`) and has no store of
 * its own; the page writes through `governanceRules.create` / `revoke`.
 */

import { Button, Select, SelectItem } from "@heroui/react";
import Link from "next/link";
import { agentHref } from "../../../../lib/console-nav";
import { resolveActionRunModeLabel } from "@synap-core/types/vocabulary";
import type { GovernanceRuleRow } from "../../../../lib/governance-rules/rule-view-model";
import type {
  EveryoneState,
  EveryoneValue,
} from "../../../../lib/governance-rules/tool-approvals-model";
import { ApprovalLine } from "../../../(admin)/approvals/_lib/approval-line";
import { isEveryoneValue, type ActionModeChoice } from "../action-mode-model";
import { objectViewsT } from "./copy";

/** Every AI's mode at one level, as the page holds it. */
export type EveryoneRead =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; everyone: EveryoneState; choices: ActionModeChoice[] };

/**
 * Every AI's mode: a pod admin picks it (one row for every AI on the pod),
 * everyone else reads it. Loading draws nothing yet; a failed read says so,
 * never "asks first".
 */
export function EveryoneControl({
  label,
  ariaLabel,
  read,
  canSet,
  isPending,
  refusal,
  onSet,
}: {
  label: string;
  ariaLabel: string;
  read: EveryoneRead;
  canSet: boolean;
  isPending: boolean;
  refusal: string | undefined;
  onSet: (next: EveryoneValue) => void;
}) {
  const t = objectViewsT();
  if (read.state === "loading") return null;
  if (read.state === "failed") {
    return (
      <p className="text-[12px] text-foreground/65">
        {t("tool.approvals.modeFailed")}
      </p>
    );
  }
  const { everyone, choices } = read;
  const current = choices.find((c) => c.mode === everyone.value);
  return (
    <div
      data-everyone-mode={everyone.mode}
      data-everyone-from={everyone.from}
      className="flex flex-col gap-1"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-[12px] text-foreground/65">{label}</span>
        {canSet ? (
          <Select
            size="sm"
            radius="md"
            variant="bordered"
            className="w-full max-w-[260px]"
            aria-label={ariaLabel}
            selectedKeys={[everyone.value]}
            disabledKeys={choices.filter((c) => c.disabled).map((c) => c.mode)}
            isDisabled={isPending}
            onSelectionChange={(keys) => {
              const k = Array.from(keys as Set<string>)[0];
              if (isEveryoneValue(k) && k !== everyone.value) onSet(k);
            }}
          >
            {choices.map((c) => (
              <SelectItem key={c.mode} description={c.line}>
                {c.label}
              </SelectItem>
            ))}
          </Select>
        ) : (
          <span className="text-[12px] text-foreground">
            {current?.label ?? resolveActionRunModeLabel(everyone.mode)}
          </span>
        )}
      </div>
      {current && (
        <span className="text-[11.5px] text-foreground/65">{current.line}</span>
      )}
      {refusal && (
        <p className="text-[12px] text-status-down" role="alert">
          {refusal}
        </p>
      )}
    </div>
  );
}

/**
 * The exceptions at one level: each row for one agent, a class or a space,
 * with its agent as a door and its way back (a pod admin's). Omitted when
 * there are none.
 */
export function ExceptionList({
  rows,
  titleOf,
  detailOf,
  whereOf,
  readOnly,
  onTakeBack,
}: {
  rows: readonly GovernanceRuleRow[];
  titleOf: (row: GovernanceRuleRow) => string;
  /** The action a row names, when narrower than the whole tool; else null. */
  detailOf: (row: GovernanceRuleRow) => string | null;
  whereOf: (row: GovernanceRuleRow) => string;
  readOnly: boolean;
  onTakeBack: (row: GovernanceRuleRow) => void;
}) {
  const t = objectViewsT();
  if (rows.length === 0) return null;
  return (
    <div data-approval-exceptions="" className="flex flex-col gap-1">
      <p className="text-[11.5px] text-foreground/65">
        {t("tool.approvals.exceptions", { count: rows.length })}
      </p>
      <div className="-mx-2 divide-y divide-foreground/[0.05]">
        {rows.map((row) => (
          <ApprovalLine
            key={row.id}
            row={row}
            // On a tool's page the tool is known: the line is titled by WHO.
            byWho
            title={titleOf(row)}
            detail={detailOf(row)}
            where={whereOf(row)}
            readOnly={readOnly}
            onTakeBack={() => onTakeBack(row)}
            doors={
              row.agentUserId && !readOnly ? (
                <Button
                  as={Link}
                  href={agentHref(row.agentUserId)}
                  data-approval-agent=""
                  size="sm"
                  variant="light"
                  radius="md"
                  className="min-h-9"
                >
                  {t("tool.approvals.agentDoor")}
                </Button>
              ) : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

/** The whole tool's rows could not be read: say so, with a retry. */
export function ApprovalsReadFailed({ onRetry }: { onRetry: () => void }) {
  const t = objectViewsT();
  return (
    <div data-approvals-failed="" className="flex flex-wrap items-center gap-3">
      <p className="text-[12.5px] text-status-down">
        {t("tool.approvals.failed")}
      </p>
      <Button size="sm" variant="flat" radius="md" onPress={onRetry}>
        {t("tool.approvals.retry")}
      </Button>
    </div>
  );
}
