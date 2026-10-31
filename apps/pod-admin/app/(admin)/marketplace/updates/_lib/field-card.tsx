"use client";

/**
 * One changed field of a template update, the change first: three lanes
 * (the catalog when you installed · the catalog now · yours), then, for
 * text, the readings a reviewer switches between (what the catalog changed ·
 * what you changed · side by side · the result), each through pod admin's one
 * text diff (`TextDiff`). A field both sides changed ends with its choices,
 * each with what it does in one sentence. The rules are the model's
 * (`updates-model.ts`); this only draws them.
 */

import { Chip, Radio, RadioGroup, Tab, Tabs, Textarea } from "@heroui/react";
import { useMemo, useState, type ReactNode } from "react";
import type { TFunction } from "@synap-core/types/i18n";
import {
  TextDiff,
  type Reading,
} from "../../../../_lib/object/content/document-changes";
import { textChanges } from "../../../../_lib/object/content/document-changes-model";
import { useT } from "../../../../../lib/i18n/locale-provider";
import { packageFieldStateLabel, type PackageUpdateField } from "./contract";
import { en, fr } from "./copy";
import { UpdateMark } from "./update-mark";
import {
  catalogHasYourEdit,
  choiceOptions,
  editStart,
  fieldMark,
  fieldShape,
  resultOf,
  sameValue,
  valueText,
  type ChoiceId,
  type ChoiceOption,
  type FieldShape,
} from "./updates-model";

const CATALOGS = { en, fr };

type Tx = TFunction<typeof en>;

export interface FieldCardProps {
  field: PackageUpdateField;
  /** The recommended choice (both-changed fields only). */
  recommended: ChoiceId | null;
  choice: ChoiceId | undefined;
  edited: string | undefined;
  onChoose: (choice: ChoiceId) => void;
  onEdit: (text: string) => void;
  disabled?: boolean;
}

export function FieldCard({
  field,
  recommended,
  choice,
  edited,
  onChoose,
  onEdit,
  disabled = false,
}: FieldCardProps) {
  const t = useT(CATALOGS);
  const shape = fieldShape(field);
  return (
    <section
      aria-label={field.label}
      data-update-field={field.key}
      className="flex flex-col gap-3 rounded-lg bg-foreground/[0.02] p-4 ring-1 ring-inset ring-foreground/10"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-medium tracking-tight text-foreground">
          {field.label}
        </h3>
        <UpdateMark
          mark={fieldMark(field.state)}
          label={packageFieldStateLabel(field.state)}
        />
      </div>

      <Lanes field={field} shape={shape} />

      {shape !== "short" && (
        <Readings field={field} shape={shape} choice={choice} edited={edited} />
      )}

      {field.state === "updates" && (
        <p className="text-[12.5px] text-foreground/65">{t("field.updates")}</p>
      )}
      {field.state === "yours" && (
        <p className="text-[12.5px] text-foreground/65">{t("field.yours")}</p>
      )}

      {field.state === "both" && (
        <Choices
          field={field}
          recommended={recommended}
          choice={choice}
          edited={edited}
          onChoose={onChoose}
          onEdit={onEdit}
          disabled={disabled}
        />
      )}
    </section>
  );
}

// ─── The three lanes ─────────────────────────────────────────────────────────

function Lanes({
  field,
  shape,
}: {
  field: PackageUpdateField;
  shape: FieldShape;
}) {
  const t = useT(CATALOGS);
  const lane = (label: ReactNode, value: unknown, dim = false) => (
    <div
      className={`flex min-w-0 flex-col gap-1 rounded-md bg-foreground/[0.03] px-3 py-2 ${dim ? "opacity-75" : ""}`}
    >
      <span className="text-[11px] font-medium text-foreground/60">
        {label}
      </span>
      <LaneValue value={value} shape={shape} t={t} />
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {lane(t("lane.base"), field.base, true)}
      {lane(
        <UpdateMark
          plain
          mark={fieldMark("updates")}
          label={t("lane.desired")}
        />,
        field.desired
      )}
      {lane(
        <UpdateMark plain mark={fieldMark("yours")} label={t("lane.live")} />,
        field.live
      )}
    </div>
  );
}

function LaneValue({
  value,
  shape,
  t,
}: {
  value: unknown;
  shape: FieldShape;
  t: Tx;
}) {
  const text = valueText(value);
  if (!text) {
    return (
      <em className="text-[13px] text-foreground/50">{t("lane.empty")}</em>
    );
  }
  // A long value is counted here; its words are in the readings below.
  if (shape !== "short") {
    return (
      <span className="text-[13px] tabular-nums text-foreground/80">
        {t("lane.chars", { n: text.length })}
      </span>
    );
  }
  return (
    <span className="break-words text-[13px] leading-relaxed text-foreground/90">
      {text}
    </span>
  );
}

// ─── The readings of a long field ────────────────────────────────────────────

type ReadingKey = "catalog" | "yours" | "side" | "result";

function Readings({
  field,
  shape,
  choice,
  edited,
}: {
  field: PackageUpdateField;
  shape: FieldShape;
  choice: ChoiceId | undefined;
  edited: string | undefined;
}) {
  const t = useT(CATALOGS);
  const code = shape === "structured";
  const base = valueText(field.base);
  const desired = valueText(field.desired);
  const live = valueText(field.live);
  const result = valueText(resultOf(field, choice, edited));

  // What each reading compares. A field only one side changed has one
  // reading worth a tab: the other would be an empty diff.
  const readings = useMemo(() => {
    const all: {
      key: ReadingKey;
      before: string;
      after: string;
      reading?: Reading;
    }[] = [];
    if (field.state === "updates" || field.state === "both") {
      all.push({ key: "catalog", before: base, after: desired });
    }
    if (field.state === "yours" || field.state === "both") {
      all.push({ key: "yours", before: base, after: live });
    }
    if (field.state === "both") {
      all.push({ key: "side", before: live, after: desired, reading: "side" });
      all.push({ key: "result", before: live, after: result });
    }
    return all;
  }, [field.state, base, desired, live, result]);

  const [active, setActive] = useState<ReadingKey>(
    readings[0]?.key ?? "catalog"
  );
  const shown = readings.find((r) => r.key === active) ?? readings[0];
  if (!shown) return null;

  const label = (key: ReadingKey) => {
    switch (key) {
      case "catalog":
        return t("tab.catalog");
      case "yours":
        return t("tab.yours");
      case "side":
        return t("tab.side");
      case "result":
        return t("tab.result");
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {readings.length > 1 && (
        <Tabs
          size="sm"
          variant="underlined"
          aria-label={t("tabs.aria")}
          selectedKey={shown.key}
          onSelectionChange={(key) => setActive(key as ReadingKey)}
          classNames={{
            tabList:
              "gap-3 px-0 border-b border-foreground/[0.05] rounded-none",
            tab: "px-1 h-9",
            cursor: "bg-primary",
            tabContent:
              "text-foreground/65 group-data-[selected=true]:text-foreground text-[12.5px] font-medium",
          }}
        >
          {readings.map((r) => (
            <Tab key={r.key} title={label(r.key)} />
          ))}
        </Tabs>
      )}
      {sameValue(shown.before, shown.after) ? (
        <p className="text-[12.5px] text-foreground/65">{t("reading.same")}</p>
      ) : (
        <TextDiff
          // A new reading is a new diff: its own reading switch starts fresh.
          key={shown.key}
          code={code}
          defaultReading={shown.reading}
          change={{
            before: shown.before,
            after: shown.after,
            lines: textChanges(shown.before, shown.after),
          }}
        />
      )}
    </div>
  );
}

// ─── Choices ─────────────────────────────────────────────────────────────────

function optionLabel(t: Tx, id: ChoiceId): string {
  switch (id) {
    case "catalog":
      return t("choice.catalog");
    case "combine":
      return t("choice.combine");
    case "mine":
      return t("choice.mine");
    case "edit":
      return t("choice.edit");
  }
}

function optionHint(
  t: Tx,
  option: ChoiceOption,
  field: PackageUpdateField
): string {
  if (option.id === "combine" && option.blocked) {
    switch (option.blocked) {
      case "notText":
        return t("choice.combine.notText");
      case "conflict":
        return t("choice.combine.conflict");
      case "sameAsCatalog":
        return t("choice.combine.sameAsCatalog");
      case "sameAsMine":
        return t("choice.combine.sameAsMine");
    }
  }
  switch (option.id) {
    case "catalog":
      return catalogHasYourEdit(field)
        ? t("choice.catalog.hintOverlap")
        : t("choice.catalog.hint");
    case "combine":
      return t("choice.combine.hint");
    case "mine":
      return t("choice.mine.hint");
    case "edit":
      return t("choice.edit.hint");
  }
}

/** What a choice does, in one sentence, under the options. */
export function consequenceOf(
  t: Tx,
  field: PackageUpdateField,
  choice: ChoiceId
): string {
  const params = { field: field.label };
  switch (choice) {
    case "catalog":
      return catalogHasYourEdit(field)
        ? t("consequence.catalogOverlap", params)
        : t("consequence.catalog", params);
    case "combine":
      return t("consequence.combine", params);
    case "mine":
      return t("consequence.mine", params);
    case "edit":
      return t("consequence.edit", params);
  }
}

function Choices({
  field,
  recommended,
  choice,
  edited,
  onChoose,
  onEdit,
  disabled,
}: Omit<FieldCardProps, "disabled"> & { disabled: boolean }) {
  const t = useT(CATALOGS);
  const options = choiceOptions(field, recommended);
  return (
    <div className="flex flex-col gap-3 border-t border-foreground/[0.06] pt-3">
      <RadioGroup
        label={t("choice.question", { field: field.label })}
        value={choice ?? null}
        isDisabled={disabled}
        onValueChange={(v) => onChoose(v as ChoiceId)}
        orientation="horizontal"
        classNames={{
          label: "text-[13px] font-medium text-foreground",
          wrapper: "grid grid-cols-1 gap-2 sm:grid-cols-2",
        }}
      >
        {options.map((option) => (
          <Radio
            key={option.id}
            value={option.id}
            isDisabled={!!option.blocked}
            description={optionHint(t, option, field)}
            classNames={{
              base: "m-0 max-w-none items-start gap-2 rounded-lg p-3 ring-1 ring-inset ring-foreground/10 data-[selected=true]:ring-2 data-[selected=true]:ring-primary/60 data-[disabled=true]:opacity-60",
              label:
                "flex flex-wrap items-center gap-1.5 text-[13px] font-medium",
              description: "text-[12px] leading-snug text-foreground/65",
            }}
          >
            {optionLabel(t, option.id)}
            {option.recommended && (
              <Chip
                size="sm"
                radius="sm"
                variant="flat"
                color="primary"
                className="h-5 text-[11px]"
              >
                {t("choice.recommended")}
              </Chip>
            )}
          </Radio>
        ))}
      </RadioGroup>

      {choice && (
        <p
          aria-live="polite"
          className="text-[12.5px] leading-relaxed text-foreground/80"
        >
          {consequenceOf(t, field, choice)}
        </p>
      )}

      {choice === "edit" && (
        <Textarea
          label={t("edit.label", { field: field.label })}
          labelPlacement="outside"
          value={edited ?? editStart(field)}
          onValueChange={onEdit}
          isDisabled={disabled}
          minRows={6}
          maxRows={24}
          variant="bordered"
          classNames={{ input: "font-mono text-[12.5px]" }}
        />
      )}
    </div>
  );
}
