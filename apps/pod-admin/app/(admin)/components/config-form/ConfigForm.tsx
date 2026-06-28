"use client";

/**
 * ConfigForm — HeroUI renderer for ConfigFieldSpec[].
 *
 * Accepts a UseConfigFormResult from useConfigForm() and renders each field
 * by valueType. Progressive disclosure via an "Advanced" Accordion section.
 * Save bar appears when dirty; shows a 2 s "Saved ✓" flash on success.
 *
 * All six valueTypes share a single `FieldFrame` wrapper that owns the
 * label, description, required-asterisk, and error-message slot so every
 * field has consistent vertical rhythm and type scale.
 */

import {
  Accordion,
  AccordionItem,
  Button,
  Chip,
  Input,
  Select,
  SelectItem,
  Switch,
} from "@heroui/react";
import { Check, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConfigFieldSpec } from "../../../../lib/config-form/types";
import type { UseConfigFormResult } from "../../../../lib/config-form/useConfigForm";

// ─── FieldFrame ────────────────────────────────────────────────────────────────
// Single container for ALL field types — owns label, description, required
// asterisk, and error slot. Controls are children.
//
// layout="stack" (default): label on top, control below (string/number/enum/
//   string-list/json)
// layout="row": label+desc left, control right (boolean Switch)

function FieldFrame({
  spec,
  error,
  layout = "stack",
  children,
}: {
  spec: ConfigFieldSpec;
  error?: string;
  layout?: "stack" | "row";
  children: ReactNode;
}) {
  if (layout === "row") {
    return (
      <div className="flex items-center justify-between gap-3 py-0.5">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[12.5px] font-medium text-foreground">
            {spec.label}
            {spec.required && (
              <span className="text-danger ml-0.5" aria-hidden>
                *
              </span>
            )}
          </span>
          {spec.description && (
            <span className="text-[11px] text-foreground/55">
              {spec.description}
            </span>
          )}
          {error && <span className="text-[11px] text-danger">{error}</span>}
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12.5px] font-medium text-foreground">
        {spec.label}
        {spec.required && (
          <span className="text-danger ml-0.5" aria-hidden>
            *
          </span>
        )}
      </span>
      {spec.description && (
        <span className="text-[11px] text-foreground/55">
          {spec.description}
        </span>
      )}
      {children}
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </div>
  );
}

// ─── string-list widget ────────────────────────────────────────────────────────

function StringListField({
  spec,
  value,
  onChange,
  error,
  disabled,
}: {
  spec: ConfigFieldSpec;
  value: string[];
  onChange: (v: string[]) => void;
  error?: string;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [dupFlash, setDupFlash] = useState(false);

  function add() {
    const v = draft.trim();
    if (!v) return;
    if (value.includes(v)) {
      setDupFlash(true);
      setTimeout(() => setDupFlash(false), 1500);
      return;
    }
    onChange([...value, v]);
    setDraft("");
  }

  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 ? (
        <span className="text-[11px] text-foreground/40 italic">
          No values yet
        </span>
      ) : (
        <div className="flex flex-wrap gap-1.5 min-h-[28px]">
          {value.map((v) => (
            <Chip
              key={v}
              size="sm"
              radius="md"
              variant="flat"
              onClose={
                disabled
                  ? undefined
                  : () => onChange(value.filter((x) => x !== v))
              }
            >
              {v}
            </Chip>
          ))}
        </div>
      )}
      {dupFlash && (
        <span className="text-[11px] text-warning">Already in list</span>
      )}
      <Input
        size="sm"
        variant="bordered"
        radius="md"
        placeholder={spec.placeholder ?? "Add value and press Enter…"}
        value={draft}
        onValueChange={setDraft}
        isDisabled={disabled}
        isInvalid={!!error}
        aria-label={spec.label}
        endContent={
          <Button
            size="sm"
            variant="light"
            radius="md"
            isIconOnly
            onPress={add}
            isDisabled={disabled || !draft.trim()}
            aria-label="Add"
          >
            <Plus className="h-3 w-3" />
          </Button>
        }
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
      />
    </div>
  );
}

// ─── json (key→value rows) widget ─────────────────────────────────────────────
// Local state = ordered array of entries with STABLE IDs so row React keys
// never mutate on key rename — this prevents focus loss after one keystroke.
//
// Reconcile to Record<string,string> on every change:
//   - empty keys are skipped (not emitted to parent)
//   - duplicate keys: first instance wins; later dups get an inline hint

type JsonEntry = { id: string; key: string; value: string };

let _jsonEntryCounter = 0;
function makeEntryId() {
  return `je-${++_jsonEntryCounter}`;
}

function recordToEntries(rec: Record<string, string>): JsonEntry[] {
  return Object.entries(rec).map(([k, v]) => ({
    id: makeEntryId(),
    key: k,
    value: v,
  }));
}

function entriesToRecord(entries: JsonEntry[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const e of entries) {
    if (!e.key) continue; // skip empty keys
    if (e.key in result) continue; // first instance wins; skip duplicates
    result[e.key] = e.value;
  }
  return result;
}

function JsonField({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  disabled: boolean;
}) {
  const [entries, setEntries] = useState<JsonEntry[]>(() =>
    recordToEntries(value)
  );

  // Track the last record we emitted so we can distinguish an external reset
  // (form.discard() / baseline change) from our own onChange round-trip.
  const lastEmittedRef = useRef<Record<string, string>>(value);

  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      // Incoming value differs from what we last emitted → external reset.
      lastEmittedRef.current = value;
      setEntries(recordToEntries(value));
    }
  }, [value]);

  // Duplicate-key detection — inline per-row hint
  const dupIds = useMemo(() => {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const e of entries) {
      if (!e.key) continue;
      if (seen.has(e.key)) dups.add(e.id);
      else seen.add(e.key);
    }
    return dups;
  }, [entries]);

  function emit(next: JsonEntry[]) {
    const record = entriesToRecord(next);
    lastEmittedRef.current = record;
    onChange(record);
  }

  function updateEntry(id: string, patch: Partial<Omit<JsonEntry, "id">>) {
    setEntries((prev) => {
      const next = prev.map((e) => (e.id === id ? { ...e, ...patch } : e));
      emit(next);
      return next;
    });
  }

  function removeEntry(id: string) {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id);
      emit(next);
      return next;
    });
  }

  function addEntry() {
    // Don't emit — empty key is skipped by entriesToRecord; emits on next keystroke.
    setEntries((prev) => [...prev, { id: makeEntryId(), key: "", value: "" }]);
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => (
        <div key={entry.id} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              variant="bordered"
              radius="md"
              placeholder="Key"
              value={entry.key}
              onValueChange={(k) => updateEntry(entry.id, { key: k })}
              isDisabled={disabled}
              isInvalid={dupIds.has(entry.id)}
              aria-label="Key"
              className="flex-1"
            />
            <Input
              size="sm"
              variant="bordered"
              radius="md"
              placeholder="Value"
              value={entry.value}
              onValueChange={(v) => updateEntry(entry.id, { value: v })}
              isDisabled={disabled}
              aria-label="Value"
              className="flex-1"
            />
            <Button
              size="sm"
              variant="light"
              radius="md"
              isIconOnly
              onPress={() => removeEntry(entry.id)}
              isDisabled={disabled}
              aria-label="Remove entry"
              className="text-danger/70 hover:text-danger shrink-0"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
          {dupIds.has(entry.id) && (
            <span className="text-[10.5px] text-danger ml-1">
              Duplicate key
            </span>
          )}
        </div>
      ))}
      <Button
        size="sm"
        variant="light"
        radius="md"
        startContent={<Plus className="h-3 w-3" />}
        onPress={addEntry}
        isDisabled={disabled}
        className="self-start"
      >
        Add entry
      </Button>
    </div>
  );
}

// ─── Per-field widget dispatcher ──────────────────────────────────────────────
// Every valueType renders its control INSIDE a FieldFrame — label, description,
// required asterisk, and error are always owned by the frame.

function FieldWidget({
  spec,
  form,
  disabled,
}: {
  spec: ConfigFieldSpec;
  form: UseConfigFormResult;
  disabled: boolean;
}) {
  const rawValue = form.getField(spec.key);
  const error = form.errors[spec.key];

  switch (spec.valueType) {
    case "boolean": {
      const value = rawValue === true || rawValue === "true";
      return (
        <FieldFrame spec={spec} error={error} layout="row">
          <Switch
            size="sm"
            isSelected={value}
            onValueChange={(v) => form.setField(spec.key, v)}
            isDisabled={disabled}
            aria-label={spec.label}
          />
        </FieldFrame>
      );
    }

    case "enum": {
      const value = typeof rawValue === "string" ? rawValue : "";
      return (
        <FieldFrame spec={spec} error={error}>
          <Select
            size="sm"
            variant="bordered"
            radius="md"
            selectedKeys={value ? new Set([value]) : new Set<string>()}
            onSelectionChange={(keys) => {
              const k = Array.from(keys as Set<string>)[0];
              if (k) form.setField(spec.key, k);
            }}
            isDisabled={disabled}
            isInvalid={!!error}
            isRequired={spec.required}
            aria-label={spec.label}
          >
            {(spec.enumValues ?? []).map((v) => (
              <SelectItem key={v}>{v}</SelectItem>
            ))}
          </Select>
        </FieldFrame>
      );
    }

    case "string-list": {
      const value = Array.isArray(rawValue) ? (rawValue as string[]) : [];
      return (
        <FieldFrame spec={spec} error={error}>
          <StringListField
            spec={spec}
            value={value}
            onChange={(v) => form.setField(spec.key, v)}
            error={error}
            disabled={disabled}
          />
        </FieldFrame>
      );
    }

    case "json": {
      const value =
        rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
          ? (rawValue as Record<string, string>)
          : {};
      return (
        <FieldFrame spec={spec} error={error}>
          <JsonField
            value={value}
            onChange={(v) => form.setField(spec.key, v)}
            disabled={disabled}
          />
        </FieldFrame>
      );
    }

    case "number": {
      const value =
        rawValue !== undefined && rawValue !== null ? String(rawValue) : "";
      return (
        <FieldFrame spec={spec} error={error}>
          <Input
            placeholder={spec.placeholder}
            type="number"
            size="sm"
            variant="bordered"
            radius="md"
            value={value}
            onValueChange={(v) =>
              form.setField(spec.key, v === "" ? undefined : Number(v))
            }
            isDisabled={disabled}
            isInvalid={!!error}
            isRequired={spec.required}
            aria-label={spec.label}
          />
        </FieldFrame>
      );
    }

    default: {
      // "string"
      const value = typeof rawValue === "string" ? rawValue : "";
      return (
        <FieldFrame spec={spec} error={error}>
          <Input
            placeholder={spec.placeholder}
            size="sm"
            variant="bordered"
            radius="md"
            value={value}
            onValueChange={(v) => form.setField(spec.key, v)}
            isDisabled={disabled}
            isInvalid={!!error}
            isRequired={spec.required}
            aria-label={spec.label}
          />
        </FieldFrame>
      );
    }
  }
}

// ─── ConfigForm ───────────────────────────────────────────────────────────────

export function ConfigForm({
  fields,
  form,
}: {
  fields: ConfigFieldSpec[];
  form: UseConfigFormResult;
}) {
  const disabled = form.saving;
  const normalFields = fields.filter((f) => !f.advanced);
  const advancedFields = fields.filter((f) => f.advanced);

  return (
    <div className="flex flex-col gap-4">
      {/* Normal fields */}
      <div className="flex flex-col gap-3">
        {normalFields.map((f) => (
          <FieldWidget key={f.key} spec={f} form={form} disabled={disabled} />
        ))}
      </div>

      {/* Advanced — collapsed by default */}
      {advancedFields.length > 0 && (
        <Accordion className="px-0" variant="light">
          <AccordionItem
            key="advanced"
            aria-label="Advanced settings"
            title={
              <span className="text-[12px] text-foreground/55">Advanced</span>
            }
          >
            <div className="flex flex-col gap-3 pt-1 pb-2">
              {advancedFields.map((f) => (
                <FieldWidget
                  key={f.key}
                  spec={f}
                  form={form}
                  disabled={disabled}
                />
              ))}
            </div>
          </AccordionItem>
        </Accordion>
      )}

      {/* Global error */}
      {form.errors._global && (
        <p className="text-[11.5px] text-danger">{form.errors._global}</p>
      )}

      {/* Save bar — visible when dirty or flashing */}
      {(form.dirty || form.savedFlash) && (
        <div className="flex items-center justify-between gap-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02] px-3 py-2">
          <span className="text-[11.5px]">
            {form.savedFlash ? (
              <span className="flex items-center gap-1.5 text-success">
                <Check className="h-3.5 w-3.5" aria-hidden />
                Saved
              </span>
            ) : (
              <span className="text-foreground/55">Unsaved changes</span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="light"
              radius="md"
              isDisabled={form.saving}
              onPress={form.discard}
            >
              Reset
            </Button>
            <Button
              size="sm"
              color="primary"
              radius="md"
              isLoading={form.saving}
              onPress={form.save}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
