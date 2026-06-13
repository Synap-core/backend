"use client";

/**
 * Native pod-admin login form.
 *
 * Served at `pod-admin.<root>` — a registrable suffix of the Kratos RP id — so
 * the WebAuthn passkey ceremony runs here with a matching origin (the Electron
 * renderer cannot; it delegates remote-pod login to this page).
 *
 * Passkey UX (the full flow):
 *   • Detect: a per-device hint records whether a passkey has been used here.
 *   • Default: if the hint is set AND the flow offers passkey, lead with passkey
 *     (user can fall back to password). Conditional-UI autofill is also armed so
 *     a present passkey surfaces in the email field.
 *   • Fallback: password always available.
 *   • Setup: after a password login where no passkey exists, offer to set one up
 *     (Kratos settings flow) — skippable.
 *
 * Login-flow mechanics (unchanged): create/fetch flow on mount; submit; on
 * `session_already_available` navigate (no reload loop); on CSRF/expiry recreate.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardBody, Input } from "@heroui/react";
import { ShieldCheck, AlertCircle, KeyRound } from "lucide-react";
import {
  collectErrorMessages,
  createLoginFlow,
  createSettingsFlow,
  extractInitialValues,
  fetchLoginFlow,
  FLOW_RESET_ERROR_IDS,
  hasPasskeyNodes,
  mergeHiddenValues,
  nodeValue,
  submitLoginFlow,
  submitSettingsFlow,
  type KratosFlow,
} from "../../lib/kratos-flow";
import {
  hasPasskeyHint,
  isConditionalUiSupported,
  isPasskeySupported,
  runPasskeyLogin,
  runPasskeyRegister,
  setPasskeyHint,
} from "../../lib/webauthn";

interface LoginFormProps {
  returnTo: string;
  initialFlowId: string | null;
}

type View = "password" | "passkey" | "setup";

export function LoginForm({ returnTo, initialFlowId }: LoginFormProps) {
  const router = useRouter();
  const [flow, setFlow] = useState<KratosFlow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("password");
  const passkeySupported = useRef(isPasskeySupported()).current;
  const conditionalAbort = useRef<AbortController | null>(null);

  const goReturn = useCallback(() => {
    if (returnTo.startsWith("/")) {
      router.replace(returnTo);
      router.refresh();
      return;
    }
    window.location.assign(returnTo);
  }, [returnTo, router]);

  const passkeyChallenge = flow ? nodeValue(flow, "passkey_challenge") : null;
  const passkeyAvailable = !!flow && passkeySupported && hasPasskeyNodes(flow);

  // Mount: load the flow; if a session already exists, route straight through.
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
        // Default to passkey when this device has used one and the flow offers it.
        if (
          hasPasskeyHint() &&
          isPasskeySupported() &&
          hasPasskeyNodes(loaded)
        ) {
          setView("passkey");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load sign-in");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialFlowId, goReturn]);

  const completePasskeySession = useCallback(() => {
    setPasskeyHint(true);
    goReturn();
  }, [goReturn]);

  // Submit a passkey assertion through the standard login-flow path.
  const submitPasskey = useCallback(
    async (assertion: string, challenge: string) => {
      if (!flow) return;
      const r = await submitLoginFlow(flow, {
        csrf_token: values.csrf_token ?? "",
        method: "passkey",
        passkey_challenge: challenge,
        passkey_login: assertion,
      });
      if (r.session) {
        completePasskeySession();
        return;
      }
      if (r.flow) {
        setFlow(r.flow);
        setValues((prev) => mergeHiddenValues(prev, r.flow!));
        const errs = collectErrorMessages(r.flow);
        setError(errs.length ? errs.join(" ") : "Passkey sign-in failed.");
        return;
      }
      if (r.structuralError) {
        if (r.structuralError.id === "session_already_available") {
          completePasskeySession();
          return;
        }
        setError(r.structuralError.message ?? "Passkey sign-in failed.");
      }
    },
    [flow, values.csrf_token, completePasskeySession]
  );

  // Explicit "Sign in with a passkey" button.
  const onPasskey = useCallback(async () => {
    if (!flow || !passkeyChallenge || passkeyBusy) return;
    setPasskeyBusy(true);
    setError(null);
    try {
      conditionalAbort.current?.abort();
      const assertion = await runPasskeyLogin(passkeyChallenge);
      await submitPasskey(assertion, passkeyChallenge);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      // User cancelled the OS prompt — stay quiet, don't show a scary error.
      if (name !== "NotAllowedError" && name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Passkey sign-in failed");
      }
    } finally {
      setPasskeyBusy(false);
    }
  }, [flow, passkeyChallenge, passkeyBusy, submitPasskey]);

  // Conditional UI (passkey autofill in the email field) — best-effort.
  useEffect(() => {
    if (!passkeyAvailable || !passkeyChallenge || view === "setup") return;
    let active = true;
    const ctrl = new AbortController();
    conditionalAbort.current = ctrl;
    void (async () => {
      if (!(await isConditionalUiSupported())) return;
      try {
        const assertion = await runPasskeyLogin(
          passkeyChallenge,
          "conditional",
          ctrl.signal
        );
        if (active) await submitPasskey(assertion, passkeyChallenge);
      } catch {
        /* autofill aborted/declined — ignore */
      }
    })();
    return () => {
      active = false;
      ctrl.abort();
    };
  }, [passkeyAvailable, passkeyChallenge, view, submitPasskey]);

  const onSubmitPassword = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!flow) return;
      setSubmitting(true);
      setError(null);
      try {
        const r = await submitLoginFlow(flow, values);
        if (r.session) {
          // Logged in with password. If this device has no passkey, offer to
          // set one up (skippable). Otherwise just go.
          if (passkeySupported && !hasPasskeyHint()) {
            setView("setup");
            return;
          }
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
    [flow, values, goReturn, passkeySupported]
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
            <ShieldCheck className="h-5 w-5 text-foreground/85" strokeWidth={2} />
          </span>

          <div className="flex flex-col gap-1.5">
            <h1 className="font-heading text-[20px] font-medium tracking-tight text-foreground">
              {view === "setup" ? "Set up a passkey" : "Sign in to Pod Admin"}
            </h1>
            <p className="text-[13.5px] leading-relaxed text-foreground/65">
              {view === "setup"
                ? "Add a passkey for faster, phishing-resistant sign-in next time."
                : "Operator access only. Session is scoped to this device."}
            </p>
          </div>

          {error ? (
            <div className="flex items-start gap-2 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {loading ? (
            <div className="rounded-medium bg-foreground/[0.04] p-4 text-[13px] text-foreground/55">
              Loading sign-in…
            </div>
          ) : view === "setup" ? (
            <SetupPasskeyStep
              csrfPlaceholder={values.csrf_token ?? ""}
              onDone={() => goReturn()}
            />
          ) : !flow ? (
            <ErrorPanel
              message={error ?? "Sign-in is unavailable."}
              onRetry={() => router.refresh()}
            />
          ) : view === "passkey" ? (
            <div className="flex flex-col gap-3">
              <Button
                color="primary"
                radius="md"
                size="md"
                startContent={<KeyRound className="h-4 w-4" />}
                isDisabled={passkeyBusy}
                isLoading={passkeyBusy}
                onPress={onPasskey}
              >
                {passkeyBusy ? "Waiting for passkey…" : "Sign in with a passkey"}
              </Button>
              <button
                type="button"
                className="text-[13px] text-foreground/55 underline-offset-2 hover:underline"
                onClick={() => setView("password")}
              >
                Use password instead
              </button>
            </div>
          ) : (
            <FlowFields
              flow={flow}
              values={values}
              setValues={setValues}
              onSubmit={onSubmitPassword}
              submitting={submitting}
              passkeyAvailable={passkeyAvailable}
              passkeyBusy={passkeyBusy}
              onPasskey={onPasskey}
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
  submitting: boolean;
  passkeyAvailable: boolean;
  passkeyBusy: boolean;
  onPasskey: () => void;
}

function FlowFields({
  flow,
  values,
  setValues,
  onSubmit,
  submitting,
  passkeyAvailable,
  passkeyBusy,
  onPasskey,
}: FlowFieldsProps) {
  const inputs = flow.ui.nodes.filter((n) => n.type === "input");

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      {inputs.map((node, idx) => {
        const attrs = node.attributes ?? {};
        const name = attrs.name;
        if (typeof name !== "string") return null;
        // Skip passkey machinery nodes — they're driven by the passkey button.
        if (node.group === "passkey" || node.group === "webauthn") return null;
        const type = (attrs.type as string) || "text";
        if (type === "submit") return null;
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
            type={type === "password" ? "password" : "text"}
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

      {passkeyAvailable ? (
        <Button
          type="button"
          variant="flat"
          radius="md"
          size="md"
          startContent={<KeyRound className="h-4 w-4" />}
          isDisabled={passkeyBusy}
          isLoading={passkeyBusy}
          onPress={onPasskey}
        >
          {passkeyBusy ? "Waiting for passkey…" : "Sign in with a passkey"}
        </Button>
      ) : null}
    </form>
  );
}

/** Post-password "set up a passkey?" step (skippable). */
function SetupPasskeyStep({
  csrfPlaceholder,
  onDone,
}: {
  csrfPlaceholder: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSetup = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const flow = await createSettingsFlow();
      const createData = nodeValue(flow, "passkey_create_data");
      if (!createData) {
        // Passkey settings node absent — nothing to enroll; just continue.
        setPasskeyHint(false);
        onDone();
        return;
      }
      const csrf = nodeValue(flow, "csrf_token") ?? csrfPlaceholder;
      const attestation = await runPasskeyRegister(createData);
      const r = await submitSettingsFlow(flow, {
        csrf_token: csrf,
        method: "passkey",
        passkey_settings_register: attestation,
      });
      if (r.success) {
        setPasskeyHint(true);
        onDone();
        return;
      }
      if (r.flow) {
        const errs = collectErrorMessages(r.flow);
        setErr(errs.length ? errs.join(" ") : "Could not add the passkey.");
        return;
      }
      setErr(r.structuralError?.message ?? "Could not add the passkey.");
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "NotAllowedError" || name === "AbortError") {
        // User cancelled the OS prompt — treat as skip.
        onDone();
        return;
      }
      setErr(e instanceof Error ? e.message : "Could not add the passkey.");
    } finally {
      setBusy(false);
    }
  }, [csrfPlaceholder, onDone]);

  return (
    <div className="flex flex-col gap-3">
      {err ? (
        <div className="flex items-start gap-2 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{err}</span>
        </div>
      ) : null}
      <Button
        color="primary"
        radius="md"
        size="md"
        startContent={<KeyRound className="h-4 w-4" />}
        isDisabled={busy}
        isLoading={busy}
        onPress={onSetup}
      >
        {busy ? "Setting up…" : "Set up a passkey"}
      </Button>
      <button
        type="button"
        className="text-[13px] text-foreground/55 underline-offset-2 hover:underline"
        onClick={onDone}
        disabled={busy}
      >
        Not now
      </button>
    </div>
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
      <div className="flex items-start gap-2 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{message}</span>
      </div>
      <Button size="sm" variant="flat" radius="md" onPress={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function autoCompleteFor(name: string): string | undefined {
  if (name === "password") return "current-password";
  if (name === "identifier" || name === "traits.email" || name === "email") {
    // "webauthn" token arms passkey autofill (Conditional UI) on the field.
    return "username webauthn";
  }
  if (name === "traits.name" || name === "name") return "name";
  return undefined;
}
