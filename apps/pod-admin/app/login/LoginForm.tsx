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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardBody, Input } from "@heroui/react";
import {
  ShieldCheck,
  AlertCircle,
  KeyRound,
  Lock,
  UserPlus,
} from "lucide-react";
import {
  collectErrorMessages,
  createLoginFlow,
  extractInitialValues,
  fetchSelfServiceFlow,
  FLOW_RESET_ERROR_IDS,
  mergeHiddenValues,
  pageForFlow,
  submitLoginFlow,
  type KratosFlow,
} from "../../lib/kratos-flow";
import {
  classifySignInFlow,
  isStateMessage,
  type SelfServiceFlowKind,
  type SignInState,
} from "../../lib/sign-in-state";

interface LoginFormProps {
  returnTo: string;
  initialFlowId: string | null;
  /** Re-authenticate an existing session (Kratos `refresh=true`). */
  refresh?: boolean;
}

export function LoginForm({
  returnTo,
  initialFlowId,
  refresh = false,
}: LoginFormProps) {
  const router = useRouter();
  const [flow, setFlow] = useState<KratosFlow | null>(null);
  const [flowKind, setFlowKind] = useState<SelfServiceFlowKind>("login");
  // Kratos replaces the account-linking banner with the password error after a
  // wrong password, on the SAME flow id — keep the explanation on screen.
  const [linking, setLinking] = useState<{
    flowId: string;
    email: string | null;
  } | null>(null);
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
        let kind: SelfServiceFlowKind = "login";
        if (initialFlowId) {
          // A refused Cloud first sign-in returns here with a REGISTRATION
          // flow id; fetchSelfServiceFlow resolves either kind.
          const r = await fetchSelfServiceFlow(initialFlowId);
          // A recovery / settings id (older kratos.yml) belongs on its own page.
          const elsewhere = pageForFlow(r.kind, initialFlowId);
          if (elsewhere) {
            if (!cancelled) router.replace(elsewhere);
            return;
          }
          loaded = r.flow;
          kind = r.kind as SelfServiceFlowKind;
        } else {
          // Return the browser HERE after a federated (oidc) round-trip — this
          // page's mount then detects the fresh session and routes on.
          const r = await createLoginFlow(window.location.href, { refresh });
          if (r.existingSession) {
            if (!cancelled) goReturn();
            return;
          }
          if (!r.flow) throw new Error("Kratos returned no flow");
          loaded = r.flow;
        }
        if (cancelled) return;
        setFlow(loaded);
        setFlowKind(kind);
        setValues(extractInitialValues(loaded));
        const errors = collectErrorMessages(loaded, isStateMessage);
        if (errors.length) setError(errors.join(" "));
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
  }, [initialFlowId, goReturn, refresh, router]);

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
        if (r.redirectBrowserTo) {
          // Federated "Continue with Synap Cloud": leave for the Control Plane.
          // The CP round-trips back to the pod's Kratos callback, which sets the
          // session cookie and returns to this page's `return_to` — where mount
          // detects the session and routes on.
          window.location.assign(r.redirectBrowserTo);
          return;
        }
        if (r.flow) {
          setFlow(r.flow);
          setValues((prev) => mergeHiddenValues(prev, r.flow!));
          const errors = collectErrorMessages(r.flow, isStateMessage);
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
            const fresh = await createLoginFlow(window.location.href, {
              refresh,
            });
            if (fresh.existingSession) {
              goReturn();
              return;
            }
            if (fresh.flow) {
              setFlow(fresh.flow);
              setFlowKind("login");
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
    [flow, goReturn, refresh]
  );

  const classified = useMemo<SignInState>(
    () => (flow ? classifySignInFlow(flow, flowKind) : { kind: "none" }),
    [flow, flowKind]
  );
  useEffect(() => {
    if (flow && classified.kind === "account_link") {
      setLinking({ flowId: flow.id, email: classified.email });
    }
  }, [flow, classified]);
  const signIn: SignInState =
    classified.kind === "none" && flow && linking?.flowId === flow.id
      ? { kind: "account_link", email: linking.email }
      : classified;

  // The flow is answered by a state panel, not the form.
  const stateView =
    signIn.kind === "access_required" ||
    signIn.kind === "self_registration_disabled" ||
    (flowKind === "registration" && flow !== null);

  // Start over on a fresh login flow (drops `?flow=`; the mount effect re-runs).
  const backToSignIn = useCallback(() => {
    setError(null);
    router.replace(
      returnTo === "/"
        ? "/login"
        : `/login?return=${encodeURIComponent(returnTo)}`
    );
  }, [returnTo, router]);

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

          {loading ? (
            <SignInHeader refresh={refresh} />
          ) : signIn.kind === "access_required" ? (
            <RefusalPanel
              icon={<Lock className="h-5 w-5" strokeWidth={2} />}
              title="You don't have access to this pod yet."
              onBack={backToSignIn}
            >
              <p>
                The pod owner has to let you in. Open the Synap app (Relay or
                the desktop app) and choose this pod to send a request, or ask
                the owner to invite you.
              </p>
              {signIn.email ? (
                <p className="text-foreground/55">
                  Synap Cloud account:{" "}
                  <span className="font-medium text-foreground/80">
                    {signIn.email}
                  </span>
                </p>
              ) : null}
            </RefusalPanel>
          ) : signIn.kind === "self_registration_disabled" ? (
            <RefusalPanel
              icon={<UserPlus className="h-5 w-5" strokeWidth={2} />}
              title="New accounts on this pod are created by invitation or with Synap Cloud."
              onBack={backToSignIn}
            />
          ) : flowKind === "registration" && flow ? (
            // pod-admin renders no sign-up form; any other registration error
            // keeps the plain banner with a way back.
            <ErrorPanel
              message={error ?? "Sign-in is unavailable."}
              actionLabel="Back to sign-in"
              onRetry={backToSignIn}
            />
          ) : (
            <SignInHeader refresh={refresh} />
          )}

          {loading ? (
            <div className="rounded-medium bg-foreground/[0.04] p-4 text-[13px] text-foreground/55">
              Loading sign-in…
            </div>
          ) : stateView ? null : flow ? (
            <FlowFields
              flow={flow}
              values={values}
              setValues={setValues}
              onSubmit={onSubmit}
              onSubmitMethod={(method, name, value) => {
                // A method trigger (federated "Continue with Synap Cloud" =
                // oidc) must post ONLY its own method + the hidden fields
                // (csrf_token) — never the empty identifier/password inputs, or
                // Kratos routes to the PASSWORD method and rejects it with
                // "identifier/password missing" (the error in the screenshot).
                const hidden: Record<string, string> = {};
                for (const n of flow?.ui.nodes ?? []) {
                  const nm = n.attributes?.name;
                  if (
                    typeof nm === "string" &&
                    n.attributes?.type === "hidden"
                  ) {
                    const v = n.attributes.value;
                    hidden[nm] = typeof v === "string" ? v : "";
                  }
                }
                void submitFlow({ ...hidden, method, [name]: value });
              }}
              submitting={submitting}
              error={error}
              linking={signIn.kind === "account_link" ? signIn : null}
            />
          ) : (
            <ErrorPanel
              message={error ?? "Sign-in is unavailable."}
              onRetry={() => router.refresh()}
            />
          )}

          {/* The one door to every way back in that works on this pod. */}
          {!loading && !refresh ? (
            <a
              href="/recovery"
              className="self-start text-[12.5px] text-foreground/60 underline-offset-4 hover:text-foreground hover:underline"
            >
              Can&apos;t sign in?
            </a>
          ) : null}
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
  onSubmitMethod: (method: string, name: string, value: string) => void;
  submitting: boolean;
  error: string | null;
  /** Kratos account linking: explain WHICH password, and how to reset it. */
  linking: { email: string | null } | null;
}

function SignInHeader({ refresh = false }: { refresh?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="font-heading text-[20px] font-medium tracking-tight text-foreground">
        {refresh ? "Confirm it's you" : "Sign in to this Pod"}
      </h1>
      <p className="text-[13.5px] leading-relaxed text-foreground/65">
        {refresh
          ? "Sign in again to change your security settings."
          : "Your session is scoped to this Pod and this device."}
      </p>
    </div>
  );
}

/**
 * An EXPLAIN state: the user cannot fix this from the form, so say why and
 * what to do, with one way back. Not an error banner — nothing failed.
 */
function RefusalPanel({
  icon,
  title,
  children,
  onBack,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-4" role="status">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-medium bg-foreground/[0.06] text-foreground/75"
        >
          {icon}
        </span>
        <h1 className="font-heading text-[18px] font-medium leading-snug tracking-tight text-foreground">
          {title}
        </h1>
      </div>
      {children ? (
        <div className="flex flex-col gap-2 text-[13.5px] leading-relaxed text-foreground/70">
          {children}
        </div>
      ) : null}
      <Button
        size="sm"
        variant="flat"
        radius="md"
        className="min-h-11 self-start"
        onPress={onBack}
      >
        Back to sign-in
      </Button>
    </div>
  );
}

function AccountLinkNotice({ email }: { email: string | null }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-medium bg-primary/10 p-3 text-[13px] leading-relaxed text-foreground/80 ring-1 ring-inset ring-primary/25"
      role="status"
    >
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          This pod already has an account for{" "}
          <span className="font-medium text-foreground">
            {email ?? "your email"}
          </span>
          . Enter that account&apos;s pod password once to connect your Synap
          Cloud sign-in. You won&apos;t need it again.
        </p>
      </div>
      <p className="pl-6 text-foreground/60">
        Forgot your pod password? Ask the pod owner to reset it. On the
        pod&apos;s server, the operator runs{" "}
        <code className="font-mono text-[12px] text-foreground/80">
          synap users reset-password {email ?? "<email>"}
        </code>
        .
      </p>
    </div>
  );
}

/**
 * Human name for an oidc provider button. Prefers the provider `label` Kratos
 * carries in `node.meta.label.text` (e.g. "Synap Cloud", set in the pod's
 * kratos.yml), and maps the built-in `cp` provider id to "Synap Cloud" so the
 * button reads correctly even before a config refresh — never the raw id.
 */
function providerButtonLabel(node: KratosFlow["ui"]["nodes"][number]): string {
  const value =
    typeof node.attributes?.value === "string" ? node.attributes.value : "";
  const metaText = node.meta?.label?.text?.trim();
  const name =
    metaText && metaText.toLowerCase() !== value.toLowerCase()
      ? metaText
      : value.toLowerCase() === "cp"
        ? "Synap Cloud"
        : value || "Synap Cloud";
  // Kratos' meta text is sometimes already a full CTA ("Sign in with …") —
  // don't double-prefix it.
  return /^(sign in|continue|log in)/i.test(name)
    ? name
    : `Continue with ${name}`;
}

function FlowFields({
  flow,
  values,
  setValues,
  onSubmit,
  onSubmitMethod,
  submitting,
  error,
  linking,
}: FlowFieldsProps) {
  // Connection handoff is available to every Pod member, not only operators.
  // Render every Pod-configured Kratos method (password, passkey, OIDC, …)
  // rather than silently stranding members who do not use a password.
  const inputs = flow.ui.nodes.filter((n) => n.type === "input");

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      {linking ? <AccountLinkNotice email={linking.email} /> : null}
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
          //
          // Skip WebAuthn/passkey triggers: pod-admin has no WebAuthn ceremony
          // (no navigator.credentials, no @synap-core/auth-ui), so clicking one
          // POSTs the password-shaped form and Kratos rejects it with
          // "identifier missing, password missing". The codebase rule is that an
          // enabled but non-functional trigger is worse than an absent option;
          // the real fix (wiring runPasskeyLogin from @synap-core/auth-ui) is a
          // follow-up.
          if (
            node.group === "password" ||
            (name === "method" && attrs.value === "password") ||
            node.group === "webauthn" ||
            node.group === "passkey" ||
            name.includes("passkey")
          ) {
            return null;
          }
          const value = typeof attrs.value === "string" ? attrs.value : "";
          // Federated method (oidc) — carry the flow's method so the submit
          // routes to it, and render the provider's human name ("Synap Cloud")
          // rather than the raw provider id ("cp").
          const method = node.group ?? "oidc";
          return (
            <Button
              key={`${name}-${idx}`}
              type="button"
              variant="flat"
              radius="md"
              isDisabled={submitting}
              onPress={() => onSubmitMethod(method, name, value)}
            >
              {providerButtonLabel(node)}
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
        {submitting
          ? "Signing in…"
          : linking
            ? "Connect and sign in"
            : "Sign in"}
      </Button>
    </form>
  );
}

function ErrorPanel({
  message,
  onRetry,
  actionLabel = "Try again",
}: {
  message: string;
  onRetry: () => void;
  actionLabel?: string;
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
        {actionLabel}
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
