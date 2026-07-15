"use client";

/**
 * Native pod-admin login form.
 *
 * Replaces the redirect to legacy admin-ui's `/admin/kratos` SPA. That flow
 * had a known reload loop on `session_already_available` because its
 * `defaultOnSuccess` reloaded the same URL with `?return=` intact, which
 * re-triggered the form on mount and re-created a flow against an existing
 * session.
 *
 * Behavior here:
 *   • On mount: create a fresh login flow (or fetch one by `?flow=`).
 *     If Kratos says "session already exists", route straight to `returnTo`.
 *   • On submit: post the flow. Success → navigate to `returnTo`. Validation
 *     → re-render with messages. Structural error (CSRF / expired) →
 *     transparently recreate the flow. `session_already_available` →
 *     navigate to `returnTo` (do NOT reload the login page).
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardBody, Input } from "@heroui/react";
import { ShieldCheck, AlertCircle } from "lucide-react";
import {
  collectErrorMessages,
  createLoginFlow,
  extractInitialValues,
  fetchLoginFlow,
  FLOW_RESET_ERROR_IDS,
  mergeHiddenValues,
  submitLoginFlow,
  type KratosFlow,
} from "../../lib/kratos-flow";

interface LoginFormProps {
  returnTo: string;
  initialFlowId: string | null;
}

export function LoginForm({ returnTo, initialFlowId }: LoginFormProps) {
  const router = useRouter();
  const [flow, setFlow] = useState<KratosFlow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use router.replace for in-app navigation (preserves the Next.js bundle)
  // and a hard navigate as fallback when the destination is outside the app.
  const goReturn = useCallback(() => {
    if (returnTo.startsWith("/")) {
      router.replace(returnTo);
      router.refresh();
      return;
    }
    window.location.assign(returnTo);
  }, [returnTo, router]);

  // Mount: create or fetch a flow. If Kratos signals an existing session,
  // skip the form entirely and route to `returnTo` — middleware will see the
  // session on the next request.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        let loaded: KratosFlow;
        if (initialFlowId) {
          loaded = await fetchLoginFlow(initialFlowId);
        } else {
          const r = await createLoginFlow();
          if (r.existingSession) {
            if (!cancelled) goReturn();
            return;
          }
          if (!r.flow) throw new Error("Kratos returned no flow");
          loaded = r.flow;
        }
        if (cancelled) return;
        setFlow(loaded);
        setValues(extractInitialValues(loaded));
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load sign-in"
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialFlowId, goReturn]);

  const submitFlow = useCallback(
    async (submittedValues: Record<string, string>) => {
      if (!flow) return;
      setSubmitting(true);
      setError(null);
      try {
        const r = await submitLoginFlow(flow, submittedValues);
        if (r.session) {
          goReturn();
          return;
        }
        if (r.flow) {
          setFlow(r.flow);
          setValues((prev) => mergeHiddenValues(prev, r.flow!));
          const errors = collectErrorMessages(r.flow);
          if (errors.length) setError(errors.join(" "));
          return;
        }
        if (r.structuralError) {
          // Already authenticated → navigate, do NOT recreate a flow on the
          // same URL (that's the legacy admin-ui's loop bug).
          if (r.structuralError.id === "session_already_available") {
            goReturn();
            return;
          }
          if (
            r.structuralError.id &&
            FLOW_RESET_ERROR_IDS.has(r.structuralError.id)
          ) {
            const fresh = await createLoginFlow();
            if (fresh.existingSession) {
              goReturn();
              return;
            }
            if (fresh.flow) {
              setFlow(fresh.flow);
              setValues((prev) => mergeHiddenValues(prev, fresh.flow!));
              setError("Please sign in again.");
              return;
            }
          }
          setError(r.structuralError.message ?? "Sign-in failed.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign-in failed");
      } finally {
        setSubmitting(false);
      }
    },
    [flow, goReturn]
  );

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void submitFlow(values);
    },
    [submitFlow, values]
  );

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <Card
        radius="lg"
        shadow="none"
        className="w-full max-w-md bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10"
      >
        <CardBody className="flex flex-col gap-5 p-8">
          <span
            aria-hidden
            className="glass-icon flex h-12 w-12 items-center justify-center self-start"
            style={{ background: "rgba(34, 197, 94, 0.18)" }}
          >
            <ShieldCheck
              className="h-5 w-5 text-foreground/85"
              strokeWidth={2}
            />
          </span>

          <div className="flex flex-col gap-1.5">
            <h1 className="font-heading text-[20px] font-medium tracking-tight text-foreground">
              Sign in to this Pod
            </h1>
            <p className="text-[13.5px] leading-relaxed text-foreground/65">
              Your session is scoped to this Pod and this device.
            </p>
          </div>

          {loading ? (
            <div className="rounded-medium bg-foreground/[0.04] p-4 text-[13px] text-foreground/55">
              Loading sign-in…
            </div>
          ) : flow ? (
            <FlowFields
              flow={flow}
              values={values}
              setValues={setValues}
              onSubmit={onSubmit}
              onSubmitMethod={(name, value) =>
                void submitFlow({ ...values, [name]: value })
              }
              submitting={submitting}
              error={error}
            />
          ) : (
            <ErrorPanel
              message={error ?? "Sign-in is unavailable."}
              onRetry={() => router.refresh()}
            />
          )}
        </CardBody>
      </Card>
    </main>
  );
}

interface FlowFieldsProps {
  flow: KratosFlow;
  values: Record<string, string>;
  setValues: (
    updater: (prev: Record<string, string>) => Record<string, string>
  ) => void;
  onSubmit: (e: React.FormEvent) => void;
  onSubmitMethod: (name: string, value: string) => void;
  submitting: boolean;
  error: string | null;
}

function FlowFields({
  flow,
  values,
  setValues,
  onSubmit,
  onSubmitMethod,
  submitting,
  error,
}: FlowFieldsProps) {
  // Connection handoff is available to every Pod member, not only operators.
  // Render every Pod-configured Kratos method (password, passkey, OIDC, …)
  // rather than silently stranding members who do not use a password.
  const inputs = flow.ui.nodes.filter((n) => n.type === "input");

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      {error ? (
        <div
          className="flex items-start gap-2 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {inputs.map((node, idx) => {
        const attrs = node.attributes ?? {};
        const name = attrs.name;
        if (typeof name !== "string") return null;
        const type = (attrs.type as string) || "text";
        if (type === "button" || type === "submit") {
          // Password remains the ordinary form submission below. Other Kratos
          // method triggers carry their exact name/value pair to the flow.
          if (
            node.group === "password" ||
            (name === "method" && attrs.value === "password")
          ) {
            return null;
          }
          const value = typeof attrs.value === "string" ? attrs.value : "";
          const label =
            typeof attrs.label === "string"
              ? attrs.label
              : node.group === "webauthn" || name.includes("passkey")
                ? "Sign in with passkey"
                : value
                  ? `Continue with ${value}`
                  : "Continue";
          return (
            <Button
              key={`${name}-${idx}`}
              type="button"
              variant="flat"
              radius="md"
              isDisabled={submitting}
              onPress={() => onSubmitMethod(name, value)}
            >
              {label}
            </Button>
          );
        }
        if (type === "hidden") {
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
        const label =
          typeof attrs.label === "string"
            ? attrs.label
            : name === "identifier"
              ? "Email"
              : name
                  .replace(/^traits\./, "")
                  .replace(/_/g, " ")
                  .replace(/\b\w/g, (c) => c.toUpperCase());
        return (
          <Input
            key={`${name}-${idx}`}
            label={String(label)}
            labelPlacement="outside"
            name={name}
            type={
              type === "password"
                ? "password"
                : type === "email"
                  ? "email"
                  : "text"
            }
            value={values[name] ?? ""}
            onValueChange={(v) => setValues((prev) => ({ ...prev, [name]: v }))}
            isRequired={attrs.required === true}
            autoComplete={autoCompleteFor(name)}
            size="sm"
            radius="md"
            variant="flat"
          />
        );
      })}

      <Button
        type="submit"
        color="primary"
        radius="md"
        size="md"
        className="mt-2"
        isDisabled={submitting}
        isLoading={submitting}
      >
        {submitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

function ErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-start gap-2 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30"
        role="alert"
      >
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{message}</span>
      </div>
      <Button
        size="sm"
        variant="flat"
        radius="md"
        className="min-h-11"
        onPress={onRetry}
      >
        Try again
      </Button>
    </div>
  );
}

function autoCompleteFor(name: string): string | undefined {
  if (name === "password") return "current-password";
  if (name === "identifier" || name === "traits.email" || name === "email") {
    return "email";
  }
  if (name === "traits.name" || name === "name") return "name";
  return undefined;
}
