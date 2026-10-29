"use client";

/**
 * What a key can do, read and set by FAMILY at one level (Records, Content,
 * Work, Activity: Off · View · Edit / Post; Decide: Off · On), the founder's
 * object-first levels of the app consent page lifted into the shared model
 * (`@synap-core/types/grants` access-levels; key pages plan 447800fe §5.1).
 * Kinds, subjects, activity families and verbs sit one disclosure deeper
 * ("Only some…", `familyParts`). Doors and lifetime close the set.
 *
 * Three hosts: New key (step 3), a key request's Review ("What it asks for",
 * "Narrow it" under the request's ceiling) and a key's own page ("Change").
 * Nothing here decides what a level means.
 */

import {
  Button,
  Checkbox,
  Chip,
  Input,
  Radio,
  RadioGroup,
} from "@heroui/react";
import { useState } from "react";
import {
  FULL_ACCESS_LABEL,
  KEY_USES,
  LEVEL_WORDS,
  accessFamiliesForScope,
  accessFamily,
  familyAccess,
  familyParts,
  grantLifetime,
  isFullAccess,
  setFamilyLevel,
  setFamilyPart,
  setGrantLifetime,
  setKeyGrant,
  setKeyUses,
  type AccessFamily,
  type FamilyPartsContext,
  type KeyCeiling,
  type KeyDraft,
  type KeyScope,
} from "@synap-core/types/grants";
import { resolveKeyUseLabel } from "@synap-core/types/vocabulary";
import { LevelControl } from "../../../_lib/review/level-control";
import {
  keyUseAllowed,
  levelAllowed,
  lifetimeChoices,
  lifetimeLabel,
  partAllowed,
} from "./key-form-model";

/** Parts listed before "Show all N" in a family's "Only some…". */
const PARTS_CAP = 8;

/** "Notes, People and 3 more": the parts a partial family holds. */
function onlyWords(names: readonly string[]): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return rest > 0
    ? `${shown.join(", ")} and ${rest} more`
    : shown.length > 1
      ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
      : (shown[0] ?? "");
}

/**
 * What the key can do, read-only: one line per family that is not Off, its
 * level as a mark (and which parts, when only some), then its doors and its
 * lifetime. Full access reads as ONE red line. Shared by step 3 (closed), a
 * key request's "What it asks for" and a key's own page.
 */
export function AccessSummary({
  draft,
  scope,
  ctx,
  lifetime,
}: {
  draft: KeyDraft;
  scope: KeyScope;
  ctx: FamilyPartsContext;
  /** An existing key says its own end ("Ends 26 Jan 2027"); a draft its lifetime. */
  lifetime?: string;
}) {
  const full = isFullAccess(draft.grant);
  const lines = full
    ? []
    : accessFamiliesForScope(scope).flatMap((f) => {
        const a = familyAccess(draft.grant, f);
        if (a.level === "off") return [];
        const only = a.partial
          ? familyParts(draft.grant, f, ctx)
              .filter((p) => p.on)
              .map((p) => p.label)
          : [];
        return [{ family: f, level: a.level, only }];
      });
  const life = grantLifetime(draft.grant);
  const uses = draft.uses.map((u) => resolveKeyUseLabel(u));
  return (
    <div data-key-access="" className="flex flex-col gap-1.5">
      {full ? (
        <p className="text-[13px] font-medium text-danger">
          {FULL_ACCESS_LABEL}
        </p>
      ) : lines.length === 0 ? (
        <p className="text-[12.5px] text-foreground/70">
          Nothing yet: it can touch nothing.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {lines.map((l) => (
            <li
              key={l.family.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]"
            >
              <span className="w-20 shrink-0 font-medium text-foreground">
                {l.family.label}
              </span>
              <Chip
                size="sm"
                variant="flat"
                color={l.family.id === "decide" ? "danger" : "primary"}
              >
                {LEVEL_WORDS[l.level]}
              </Chip>
              {l.only.length > 0 ? (
                <span className="text-foreground/65">
                  only {onlyWords(l.only)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[12px] text-foreground/65">
        {[
          uses.length > 0
            ? `Where it is used: ${uses.join(", ")}`
            : "No place it is used yet",
          lifetime ??
            (life.kind === "never"
              ? "Never expires"
              : `Ends in ${lifetimeLabel(life.days)}`),
        ].join(" · ")}
      </p>
    </div>
  );
}

/**
 * One family's row: its level control and, below a level, which of its parts
 * hold it ("Only some…"). Decide's verbs show as soon as it is On, red.
 */
function FamilyRow({
  family,
  draft,
  ctx,
  ceiling,
  onChange,
}: {
  family: AccessFamily;
  draft: KeyDraft;
  ctx: FamilyPartsContext;
  ceiling?: KeyCeiling;
  onChange: (next: KeyDraft) => void;
}) {
  const grant = draft.grant;
  const a = familyAccess(grant, family);
  const decide = family.id === "decide";
  const [open, setOpen] = useState(a.partial);
  const [all, setAll] = useState(false);
  const parts = familyParts(grant, family, ctx);
  const showParts = a.level !== "off" && (decide || open);
  const shownParts = all ? parts : parts.slice(0, PARTS_CAP);
  const onlyLabel =
    family.id === "records"
      ? "Only some kinds…"
      : family.id === "activity"
        ? "Only dev or CI…"
        : "Only some…";
  return (
    <li className="flex flex-col gap-1.5 py-2" data-family={family.id}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="flex min-w-0 flex-col">
          <span
            className={`text-[13px] font-medium ${decide ? "text-danger" : "text-foreground"}`}
          >
            {family.label}
          </span>
          {a.partial && !showParts ? (
            <span className="text-[11.5px] text-foreground/65">Only some</span>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {!decide && a.level !== "off" && parts.length > 1 ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="text-[12px] text-foreground/65 underline decoration-foreground/25 underline-offset-2 hover:text-foreground"
            >
              {onlyLabel}
            </button>
          ) : null}
          <LevelControl
            label={family.label}
            levels={family.levels}
            words={LEVEL_WORDS}
            level={a.level}
            isLevelDisabled={(l) =>
              l !== a.level && !levelAllowed(ceiling, grant, family, l)
            }
            onChange={(l) =>
              onChange(setKeyGrant(draft, setFamilyLevel(grant, family, l)))
            }
          />
        </span>
      </div>
      {showParts ? (
        <div className="flex flex-col gap-1 pl-1">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {shownParts.map((p) => (
              <Checkbox
                key={p.id}
                size="sm"
                color={decide ? "danger" : "primary"}
                isSelected={p.on}
                isDisabled={
                  !p.on && !partAllowed(ceiling, grant, family, p.id, ctx)
                }
                onValueChange={(on) =>
                  onChange(
                    setKeyGrant(
                      draft,
                      setFamilyPart(grant, family, p.id, on, ctx)
                    )
                  )
                }
              >
                <span className="text-[12.5px]">{p.label}</span>
              </Checkbox>
            ))}
          </div>
          {parts.length > PARTS_CAP ? (
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              className="self-start text-[12px] text-foreground/65 underline decoration-foreground/25 underline-offset-2 hover:text-foreground"
            >
              {all ? "Show fewer" : `Show all ${parts.length}`}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * What the key can do, editable: each family at one level, its doors, its
 * lifetime. Under a `ceiling` (a key request) nothing can be set wider than
 * what was asked.
 */
export function AccessEditor({
  draft,
  scope,
  ctx,
  ceiling,
  lifetime = true,
  doors = true,
  onChange,
}: {
  draft: KeyDraft;
  scope: KeyScope;
  ctx: FamilyPartsContext;
  ceiling?: KeyCeiling;
  /** A live key's lifetime is not changed here (its page says when it ends). */
  lifetime?: boolean;
  /** A live key's doors are its scopes, set when it was made: not changed here. */
  doors?: boolean;
  onChange: (next: KeyDraft) => void;
}) {
  const grant = draft.grant;
  const full = isFullAccess(grant);
  return (
    <div className="flex flex-col gap-4">
      {full ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-danger/[0.06] px-3 py-2.5 ring-1 ring-inset ring-danger/20">
          <span className="flex flex-col">
            <span className="text-[13px] font-medium text-danger">
              {FULL_ACCESS_LABEL}
            </span>
            <span className="text-[11.5px] text-foreground/70">
              Everything you can do yourself, approving and deleting included.
            </span>
          </span>
          <Button
            size="sm"
            variant="flat"
            radius="md"
            onPress={() =>
              // Every family at its top level, then each can be lowered: a
              // narrowing, never a widening.
              onChange(
                setKeyGrant(
                  draft,
                  setFamilyLevel(grant, accessFamily("decide"), "on")
                )
              )
            }
          >
            Narrow it
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-foreground/[0.06]">
          {accessFamiliesForScope(scope).map((f) => (
            <FamilyRow
              key={f.id}
              family={f}
              draft={draft}
              ctx={ctx}
              ceiling={ceiling}
              onChange={onChange}
            />
          ))}
        </ul>
      )}
      {doors ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[12px] font-medium text-foreground/85">
            Where it is used
          </legend>
          {KEY_USES.map((use) => {
            const on = draft.uses.includes(use.id);
            return (
              <Checkbox
                key={use.id}
                size="sm"
                isSelected={on}
                isDisabled={!on && !keyUseAllowed(ceiling, use.id)}
                onValueChange={(next) =>
                  onChange(
                    setKeyUses(
                      draft,
                      next
                        ? [...draft.uses, use.id]
                        : draft.uses.filter((u) => u !== use.id)
                    )
                  )
                }
              >
                <span className="text-[12.5px]">
                  {resolveKeyUseLabel(use.id)}
                </span>
              </Checkbox>
            );
          })}
        </fieldset>
      ) : null}
      {lifetime ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[12px] font-medium text-foreground/85">
            Lifetime
          </legend>
          <LifetimePicker
            draft={draft}
            ceiling={ceiling}
            onChange={(days) =>
              onChange(setKeyGrant(draft, setGrantLifetime(grant, days)))
            }
          />
          {grantLifetime(grant).kind === "never" ? (
            <p
              role="note"
              className="rounded-md bg-warning/10 px-3 py-2 text-[12px] text-warning"
            >
              A key that never expires works until someone revokes it, even if
              it leaks. Prefer a year.
            </p>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}

function LifetimePicker({
  draft,
  ceiling,
  onChange,
}: {
  draft: KeyDraft;
  ceiling?: KeyCeiling;
  onChange: (days: number | null) => void;
}) {
  const choices = lifetimeChoices(ceiling);
  const life = grantLifetime(draft.grant);
  const current = life.kind === "never" ? null : life.days;
  const isChoice = choices.includes(current);
  const value = isChoice ? String(current) : "custom";
  return (
    <div className="flex flex-col gap-2">
      <RadioGroup
        aria-label="Lifetime"
        orientation="horizontal"
        size="sm"
        value={value}
        onValueChange={(v) => {
          if (v === "custom") return onChange(current ?? 90);
          onChange(v === "null" ? null : Number(v));
        }}
      >
        {choices.map((d) => (
          <Radio key={String(d)} value={String(d)}>
            {lifetimeLabel(d)}
          </Radio>
        ))}
        <Radio value="custom">After…</Radio>
      </RadioGroup>
      {value === "custom" ? (
        <Input
          type="number"
          size="sm"
          className="max-w-[12rem]"
          label="Days"
          min={1}
          value={current === null ? "" : String(current)}
          onValueChange={(v) => {
            const n = Number(v);
            if (Number.isFinite(n) && v.trim() !== "") onChange(n);
          }}
        />
      ) : null}
    </div>
  );
}
