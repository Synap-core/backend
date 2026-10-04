"use client";

/**
 * Renders the nodes of a Kratos RECOVERY or SETTINGS flow as one form.
 *
 * The login page keeps its own renderer (`app/login/LoginForm.tsx`): it skips
 * passkey triggers and posts federated methods, which neither of these flows
 * needs. What this one must get right instead:
 *
 *   - the primary submit posts the typed fields + hidden fields + `method`,
 *     and NEVER the value of another submit button. A recovery flow carries a
 *     "Resend code" submit whose name is `email`; Kratos treats any non-empty
 *     `email` as a resend (selfservice/strategy/code/strategy_recovery.go), so
 *     folding it into the code submit would resend instead of verifying.
 *   - secondary submits ("Resend code") post ONLY hidden fields + their own
 *     name/value + the method.
 */

import { Button, Input } from "@heroui/react";
import { AlertCircle } from "lucide-react";
import type { FormEvent } from "react";
import type { KratosFlow, KratosUiNode } from "../../lib/kratos-flow";

/** Hidden + typed field values for a flow — never a submit button's value. */
export function initialFieldValues(
  flow: KratosFlow,
  groups: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of flow.ui.nodes) {
    if (!inGroups(n, groups) || n.type !== "input") continue;
    const name = n.attributes?.name;
    const type = n.attributes?.type;
    if (typeof name !== "string" || type === "submit" || type === "button") {
      continue;
    }
    const v = n.attributes?.value;
    out[name] = typeof v === "string" ? v : "";
  }
  return out;
}

function inGroups(n: KratosUiNode, groups: readonly string[]): boolean {
  return n.group === "default" || groups.includes(n.group ?? "");
}

function submitNodes(flow: KratosFlow, groups: readonly string[]) {
  return flow.ui.nodes.filter(
    (n) =>
      inGroups(n, groups) &&
      n.type === "input" &&
      (n.attributes?.type === "submit" || n.attributes?.type === "button") &&
      typeof n.attributes?.name === "string"
  );
}

/** The `method` submit of the flow's group — what the primary button posts. */
export function primaryMethod(
  flow: KratosFlow,
  groups: readonly string[]
): string | null {
  const node = submitNodes(flow, groups).find(
    (n) => n.attributes?.name === "method"
  );
  const v = node?.attributes?.value;
  return typeof v === "string" ? v : null;
}

function labelFor(node: KratosUiNode): string {
  const meta = node.meta?.label?.text?.trim();
  if (meta) return meta;
  const name = String(node.attributes?.name ?? "");
  if (name === "email" || name === "traits.email") return "Email";
  if (name === "code") return "Code";
  if (name === "password") return "New password";
  return name;
}

interface KratosFieldsProps {
  flow: KratosFlow;
  groups: readonly string[];
  values: Record<string, string>;
  setValues: (
    updater: (prev: Record<string, string>) => Record<string, string>
  ) => void;
  /** Called with the exact body to post. */
  onSubmit: (body: Record<string, string>) => void;
  submitting: boolean;
  submitLabel: string;
  error?: string | null;
}

export function KratosFields({
  flow,
  groups,
  values,
  setValues,
  onSubmit,
  submitting,
  submitLabel,
  error,
}: KratosFieldsProps) {
  const method = primaryMethod(flow, groups);
  const fields = flow.ui.nodes.filter(
    (n) =>
      inGroups(n, groups) &&
      n.type === "input" &&
      n.attributes?.type !== "submit" &&
      n.attributes?.type !== "button" &&
      typeof n.attributes?.name === "string"
  );
  const secondary = submitNodes(flow, groups).filter(
    (n) => n.attributes?.name !== "method"
  );
  const hiddenOnly = () => {
    const out: Record<string, string> = {};
    for (const n of fields) {
      if (n.attributes?.type === "hidden") {
        const name = n.attributes.name as string;
        out[name] = values[name] ?? "";
      }
    }
    return out;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ ...values, ...(method ? { method } : {}) });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      {error ? (
        <div
          className="flex items-start gap-2 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {fields.map((node, idx) => {
        const attrs = node.attributes ?? {};
        const name = attrs.name as string;
        if (attrs.type === "hidden") {
          return (
            <input
              key={`${name}-${idx}`}
              type="hidden"
              name={name}
              value={values[name] ?? ""}
              readOnly
            />
          );
        }
        const fieldErrors = (node.messages ?? [])
          .filter((m) => m.type === "error")
          .map((m) => m.text);
        const type =
          attrs.type === "password"
            ? "password"
            : attrs.type === "email"
              ? "email"
              : "text";
        return (
          <Input
            key={`${name}-${idx}`}
            label={labelFor(node)}
            labelPlacement="outside"
            name={name}
            type={type}
            value={values[name] ?? ""}
            onValueChange={(v) => setValues((prev) => ({ ...prev, [name]: v }))}
            isRequired={attrs.required === true}
            isInvalid={fieldErrors.length > 0}
            errorMessage={fieldErrors.join(" ")}
            autoComplete={
              name === "password"
                ? "new-password"
                : name === "code"
                  ? "one-time-code"
                  : name.endsWith("email")
                    ? "email"
                    : undefined
            }
            inputMode={name === "code" ? "numeric" : undefined}
            size="sm"
            radius="md"
            variant="flat"
          />
        );
      })}

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          color="primary"
          radius="md"
          size="md"
          isDisabled={submitting}
          isLoading={submitting}
        >
          {submitLabel}
        </Button>
        {secondary.map((node, idx) => {
          const name = node.attributes?.name as string;
          const value =
            typeof node.attributes?.value === "string"
              ? node.attributes.value
              : "";
          return (
            <Button
              key={`${name}-${idx}`}
              type="button"
              variant="light"
              radius="md"
              size="md"
              isDisabled={submitting}
              onPress={() =>
                onSubmit({
                  ...hiddenOnly(),
                  ...(method ? { method } : {}),
                  [name]: value,
                })
              }
            >
              {labelFor(node)}
            </Button>
          );
        })}
      </div>
    </form>
  );
}
