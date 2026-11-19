"use client";

/**
 * The F4 row (design A, "Records · N kinds"): every kind an app asked for in
 * ONE request (`synap_requests[].kinds`, #1196's `kindGroup`) is one row, not
 * one row per kind. Its level sets every kind at once; "N kinds" opens the
 * checklist, whose first box, "All N kinds it asked for", is indeterminate
 * when some are off. Each kind stays its own permission (D4): the raw request
 * is shown beside the words, in mono.
 */

import { useId, useState } from "react";
import { Button, Checkbox } from "@heroui/react";
import { ChevronDown } from "lucide-react";
import {
  kindsOn,
  rowLevel,
  type CanRow,
  type ConsentDraft,
} from "./consent-access";
import { CONSENT_CHECKBOX, LevelControl } from "./LevelControl";
import type { AccessLevel } from "./consent-model";
import { consentT } from "./copy";

export function KindsGroupRow({
  row,
  draft,
  appName,
  isDisabled = false,
  defaultOpen = false,
  onSetLevel,
  onToggleKind,
  onToggleAll,
}: {
  row: CanRow;
  draft: ConsentDraft;
  appName: string;
  isDisabled?: boolean;
  /** Opened at rest (a test, or a screenshot of the open state). */
  defaultOpen?: boolean;
  onSetLevel: (level: AccessLevel) => void;
  onToggleKind: (kind: string) => void;
  onToggleAll: () => void;
}) {
  const t = consentT();
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const on = kindsOn(draft, row);
  const total = row.kinds.length;
  const level = rowLevel(draft, row);
  // The requests as declared ("entity.read · kinds: 29"), never hidden.
  const declared = [
    ...new Set(
      row.permissions.map((p) => p.permission.replace(/^entity\.[^.]+\./, "entity."))
    ),
  ].join(" · ");
  return (
    <li className="flex flex-col py-1" data-object={row.key}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-h-10 min-w-0 flex-1 basis-40 flex-col justify-center">
          <span className="text-sm font-medium text-foreground/90">
            {row.label}
          </span>
          <Button
            size="sm"
            variant="flat"
            color="primary"
            radius="full"
            className="h-7 min-h-7 min-w-0 self-start px-2.5 text-xs"
            aria-expanded={open}
            aria-controls={`${id}-kinds`}
            endContent={
              <ChevronDown
                aria-hidden
                className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
              />
            }
            onPress={() => setOpen((o) => !o)}
          >
            {t("kinds.count", { n: on })}
          </Button>
        </div>
        <LevelControl
          label={`${row.label}: access`}
          levels={row.levels}
          level={level}
          isDisabled={isDisabled}
          onChange={onSetLevel}
        />
      </div>
      <div
        id={`${id}-kinds`}
        hidden={!open}
        // A class's `display` beats the `hidden` attribute: keep both.
        className={`${open ? "flex" : "hidden"} flex-col gap-1.5 pb-2 pt-1`}
      >
        <Checkbox
          size="sm"
          classNames={CONSENT_CHECKBOX}
          isSelected={on === total}
          isIndeterminate={on > 0 && on < total}
          isDisabled={isDisabled}
          onValueChange={onToggleAll}
        >
          <span className="text-sm font-medium text-foreground/90">
            {t("kinds.all", { n: total })}
          </span>{" "}
          <span className="text-xs text-foreground/65">
            · {t("kinds.on", { n: on })}
          </span>
        </Checkbox>
        <div
          role="group"
          aria-label={`${t("kinds.label")}, ${appName}`}
          className="grid grid-cols-1 gap-x-4 min-[400px]:grid-cols-2"
        >
          {row.kinds.map((k) => (
            <Checkbox
              key={k.kind}
              size="sm"
              classNames={CONSENT_CHECKBOX}
              isSelected={k.permissions.some((p) => draft.permissions.has(p))}
              isDisabled={isDisabled}
              onValueChange={() => onToggleKind(k.kind)}
            >
              <span className="text-sm text-foreground/85">{k.label}</span>
            </Checkbox>
          ))}
        </div>
        <p className="text-xs leading-relaxed text-foreground/65">
          {t("kinds.note")}{" "}
          <span className="font-mono text-[11px] text-foreground/65">
            {declared}
          </span>
        </p>
      </div>
    </li>
  );
}
