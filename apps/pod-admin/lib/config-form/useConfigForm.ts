"use client";

/**
 * useConfigForm — headless state machine for dynamic config forms.
 *
 * ZERO UI imports. Extractable to a shared package.
 *
 * Features:
 * - get/set via dotted keys (nested object traversal)
 * - per-field validation on save (required, number coercion, enum membership)
 * - dirty = deep-compare vs baseline
 * - 2 s savedFlash after successful save
 * - errors._global for thrown errors
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConfigFieldSpec } from "./types";

// ─── Dotted-key helpers ───────────────────────────────────────────────────────

function getIn(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setIn(
  obj: Record<string, unknown>,
  key: string,
  value: unknown
): Record<string, unknown> {
  const parts = key.split(".");
  if (parts.length === 1) return { ...obj, [key]: value };
  const [head, ...rest] = parts;
  const nested =
    typeof obj[head] === "object" && obj[head] !== null
      ? (obj[head] as Record<string, unknown>)
      : {};
  return { ...obj, [head]: setIn(nested, rest.join("."), value) };
}

// ─── Deep equality ────────────────────────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false;
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (
      !deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k]
      )
    )
      return false;
  }
  return true;
}

// ─── Public contract ──────────────────────────────────────────────────────────

export interface UseConfigFormOptions {
  fields: ConfigFieldSpec[];
  initial: Record<string, unknown>;
  onSave: (values: Record<string, unknown>) => Promise<void>;
}

export interface UseConfigFormResult {
  values: Record<string, unknown>;
  setField: (key: string, value: unknown) => void;
  getField: (key: string) => unknown;
  dirty: boolean;
  errors: Record<string, string>;
  saving: boolean;
  savedFlash: boolean;
  save: () => Promise<void>;
  discard: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useConfigForm({
  fields,
  initial,
  onSave,
}: UseConfigFormOptions): UseConfigFormResult {
  const [baseline, setBaseline] = useState<Record<string, unknown>>(initial);
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    []
  );

  const dirty = !deepEqual(values, baseline);

  const getField = useCallback((key: string) => getIn(values, key), [values]);

  const setField = useCallback((key: string, value: unknown) => {
    setValues((prev) => setIn(prev, key, value));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      delete next._global;
      return next;
    });
  }, []);

  const discard = useCallback(() => {
    setValues(baseline);
    setErrors({});
  }, [baseline]);

  const save = useCallback(async () => {
    const newErrors: Record<string, string> = {};

    for (const f of fields) {
      const val = getIn(values, f.key);

      if (f.required) {
        if (val === undefined || val === null || val === "") {
          newErrors[f.key] = `${f.label} is required.`;
        }
      }

      if (
        f.valueType === "number" &&
        val !== undefined &&
        val !== null &&
        val !== ""
      ) {
        const n = Number(val);
        if (Number.isNaN(n)) {
          newErrors[f.key] = `${f.label} must be a valid number.`;
        }
      }

      if (
        f.valueType === "enum" &&
        val !== undefined &&
        val !== null &&
        val !== ""
      ) {
        if (f.enumValues && !f.enumValues.includes(val as string)) {
          newErrors[f.key] =
            `${f.label} must be one of: ${f.enumValues.join(", ")}.`;
        }
      }
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setSaving(true);
    try {
      await onSave(values);
      setBaseline(values);
      setSavedFlash(true);
      flashTimerRef.current = setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      setErrors({
        _global: err instanceof Error ? err.message : "Save failed.",
      });
    } finally {
      setSaving(false);
    }
  }, [fields, values, onSave]);

  return {
    values,
    setField,
    getField,
    dirty,
    errors,
    saving,
    savedFlash,
    save,
    discard,
  };
}
