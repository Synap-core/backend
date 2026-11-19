"use client";

/**
 * The F4 row (design A, "Records · N kinds"): every kind an app asked for in
 * ONE request (`synap_requests[].kinds`, #1196's `kindGroup`) is one row, not
 * one row per kind. Its level sets every kind at once; when the kinds hold
 * different levels the row says "Mixed" and selects none, so nothing is
 * flattened until the person presses one. "N kinds" opens the checklist:
 * "All N kinds it asked for" (indeterminate when some are off), then each
 * kind, with its own level when the request writes it. Each kind stays its
 * own permission (D4); the raw request sits in the developer fold.
 */

import { useId, useState } from "react";
import { Button, Checkbox } from "@heroui/react";
import { ChevronRight } from "lucide-react";
import {
  andList,
  kindLevel,
  kindLevels,
  kindsMixed,
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
  podWideKinds = [],
  isDisabled = false,
  defaultOpen = false,
  onSetLevel,
  onToggleKind,
  onSetKindLevel,
  onToggleAll,
}: {
  row: CanRow;
  draft: ConsentDraft;
  appName: string;
  /** The server's list of kinds kept pod-wide (`podWideKinds`). */
  podWideKinds?: readonly string[];
  isDisabled?: boolean;
  /** Opened at rest (a test, or a screenshot of the open state). */
  defaultOpen?: boolean;
  onSetLevel: (level: AccessLevel) => void;
  onToggleKind: (kind: string) => void;
  onSetKindLevel: (kind: string, level: AccessLevel) => void;
  onToggleAll: () => void;
}) {
  const t = consentT();
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const on = kindsOn(draft, row);
  const total = row.kinds.length;
  const mixed = kindsMixed(draft, row);
  const level = mixed ? null : rowLevel(draft, row);
  // A request that writes a kind gives each kind its own level control.
  const perKindLevels = row.levels.includes("edit");
  const reasons = [
    ...new Set(
      row.permissions
        .map((p) => p.reason?.trim())
        .filter((r): r is string => !!r)
    ),
  ];
  const podWide = row.kinds.filter((k) => podWideKinds.includes(k.kind));
  const showPodWide = podWide.length > 0 && draft.read.spaces !== "all";
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
            radius="full"
            className="h-7 min-h-7 min-w-0 self-start px-2.5 text-xs text-foreground/90"
            aria-expanded={open}
            aria-controls={`${id}-kinds`}
            startContent={
              <ChevronRight
                aria-hidden
                className={`h-3.5 w-3.5 ${open ? "rotate-90" : ""}`}
              />
            }
            onPress={() => setOpen((o) => !o)}
          >
            {t("kinds.count", { n: on })}
            {mixed ? ` · ${t("level.mixed")}` : ""}
          </Button>
        </div>
        <LevelControl
          label={t("kinds.access", { kind: row.label })}
          levels={row.levels}
          level={level}
          isDisabled={isDisabled}
          onChange={onSetLevel}
        />
      </div>
      {reasons.map((r) => (
        <p
          key={r}
          className="text-pretty text-xs leading-relaxed text-foreground/75"
        >
          {/* The developer's words, as text: why it asks. */}
          <span className="text-foreground/65">{t("reason.prefix")} </span>
          {r}
        </p>
      ))}
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
          </span>
          {on > 0 && on < total ? (
            <span className="text-xs text-foreground/65">
              {" "}
              · {t("kinds.someOn", { on, n: total })}
            </span>
          ) : null}
        </Checkbox>
        {perKindLevels ? (
          <ul
            aria-label={`${t("kinds.label")}, ${appName}`}
            className="flex flex-col"
          >
            {row.kinds.map((k) => (
              <li
                key={k.kind}
                className="flex flex-wrap items-center justify-between gap-x-3"
              >
                <span className="text-sm text-foreground/85">{k.label}</span>
                <LevelControl
                  label={t("kinds.access", { kind: k.label })}
                  levels={kindLevels(row, k.kind)}
                  level={kindLevel(draft, row, k.kind)}
                  isDisabled={isDisabled}
                  onChange={(l) => onSetKindLevel(k.kind, l)}
                />
              </li>
            ))}
          </ul>
        ) : (
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
        )}
        {showPodWide ? (
          <p className="text-pretty text-xs leading-relaxed text-foreground/65">
            {t("kinds.podWide", {
              names: andList(podWide.map((k) => k.label)),
            })}
          </p>
        ) : null}
      </div>
    </li>
  );
}
