"use client";

/**
 * "Can't sign in?" — the recovery hub and the Kratos recovery flow renderer.
 *
 * Two screens, chosen by the URL:
 *   - no `?flow=` → the HUB: only the doors that work on THIS pod
 *     (`GET /api/account-recovery/doors`). None → EXPLAIN (the operator
 *     command). Doors read failed → LoadFailed with Retry, never "nothing
 *     works".
 *   - `?flow=` → the recovery FLOW (email → code). `#code=` in the fragment
 *     (a redeemed recovery code) is submitted for the reader and scrubbed from
 *     the address bar; success leaves for the privileged settings page.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardBody, Input } from "@heroui/react";
import {
  AlertCircle,
  ArrowLeft,
  Cloud,
  KeyRound,
  LifeBuoy,
  Mail,
  Server,
} from "lucide-react";
import type { RecoveryDoors } from "@synap-core/types/account-recovery";
import {
  createBrowserFlow,
  createLoginFlow,
  fetchFlow,
  FlowLoadError,
  submitSelfServiceFlow,
  type KratosFlow,
} from "../../lib/kratos-flow";
import {
  readRecoveryFragment,
  recoveryApi,
  visibleDoors,
  type RecoveryDoorKind,
} from "../../lib/account-recovery";
import { initialFieldValues, KratosFields } from "../_lib/kratos-fields";

const RECOVERY_GROUPS = ["code", "link"] as const;

export function RecoveryView({ initialFlowId }: { initialFlowId: string | null }) {
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
            className="glass-icon flex h-12 w-12 items-center justify-center self-start bg-primary/15"
          >
            <LifeBuoy className="h-5 w-5 text-foreground/85" strokeWidth={2} />
          </span>
          {initialFlowId ? (
            <RecoveryFlowLoader flowId={initialFlowId} />
          ) : (
            <RecoveryHub />
          )}
          <a
            href="/login"
            className="inline-flex items-center gap-1.5 self-start text-[12.5px] text-foreground/60 hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to sign-in
          </a>
        </CardBody>
      </Card>
    </main>
  );
}

function Header({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="font-heading text-[20px] font-medium tracking-tight text-foreground">
        {title}
      </h1>
      {children ? (
        <p className="text-[13.5px] leading-relaxed text-foreground/65">
          {children}
        </p>
      ) : null}
    </div>
  );
}

/** LoadFailed: what failed + the one way to try again. */
function LoadFailed({
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
        className="min-h-11 self-start"
        onPress={onRetry}
      >
        {actionLabel}
      </Button>
    </div>
  );
}

// ─── Hub ────────────────────────────────────────────────────────────────

type HubState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; doors: RecoveryDoors };

const DOOR_COPY: Record<
  RecoveryDoorKind,
  { icon: typeof KeyRound; title: string; hint: string }
> = {
  code: {
    icon: KeyRound,
    title: "Use a recovery code",
    hint: "One of the codes you saved for this pod",
  },
  email: {
    icon: Mail,
    title: "Email me a code",
    hint: "Sent to your account email",
  },
  cloud: {
    icon: Cloud,
    title: "Continue with Synap Cloud",
    hint: "The owner lets Synap Cloud recover accounts here",
  },
};

function RecoveryHub() {
  const router = useRouter();
  const [state, setState] = useState<HubState>({ kind: "loading" });
  const [open, setOpen] = useState<RecoveryDoorKind | null>(null);
  const [busy, setBusy] = useState<RecoveryDoorKind | null>(null);
  const [doorError, setDoorError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await recoveryApi.doors();
    setState(
      r.ok
        ? { kind: "ready", doors: r.data }
        : {
            kind: "failed",
            message: `Couldn't check how this pod recovers accounts. ${r.message}`,
          }
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startEmail = async () => {
    setBusy("email");
    setDoorError(null);
    try {
      const r = await createBrowserFlow("recovery");
      if ("flow" in r) router.replace(`/recovery?flow=${encodeURIComponent(r.flow.id)}`);
      else if ("existingSession" in r) router.replace("/settings/security");
      else setDoorError("Couldn't start email recovery. Try again.");
    } catch (err) {
      setDoorError(err instanceof Error ? err.message : "Couldn't start email recovery.");
    } finally {
      setBusy(null);
    }
  };

  const startCloud = async () => {
    setBusy("cloud");
    setDoorError(null);
    try {
      const r = await createLoginFlow(`${window.location.origin}/settings/security`);
      if (r.existingSession) {
        router.replace("/settings/security");
        return;
      }
      const flow = r.flow;
      const csrf = flow?.ui.nodes.find((n) => n.attributes?.name === "csrf_token")
        ?.attributes?.value;
      const hasCloud = flow?.ui.nodes.some(
        (n) => n.group === "oidc" && n.attributes?.value === "cp"
      );
      if (!flow || !hasCloud) {
        setDoorError("Synap Cloud sign-in isn't available on this pod right now.");
        return;
      }
      const sent = await submitSelfServiceFlow(flow, {
        csrf_token: typeof csrf === "string" ? csrf : "",
        method: "oidc",
        provider: "cp",
      });
      if (sent.kind === "redirect") {
        window.location.assign(sent.to);
        return;
      }
      setDoorError("Synap Cloud sign-in couldn't start. Try again.");
    } catch (err) {
      setDoorError(err instanceof Error ? err.message : "Synap Cloud sign-in couldn't start.");
    } finally {
      setBusy(null);
    }
  };

  if (state.kind === "loading") {
    return (
      <>
        <Header title="Can't sign in?" />
        <div className="flex flex-col gap-2" aria-busy>
          {[0, 1].map((i) => (
            <div key={i} className="h-14 rounded-medium bg-foreground/[0.05] shimmer-pulse" />
          ))}
        </div>
      </>
    );
  }
  if (state.kind === "failed") {
    return (
      <>
        <Header title="Can't sign in?" />
        <LoadFailed message={state.message} onRetry={() => void load()} />
      </>
    );
  }

  const doors = visibleDoors(state.doors);
  if (doors.length === 0) {
    // EXPLAIN — nothing the reader can do here; say why and who can.
    return (
      <div className="flex flex-col gap-4" role="status">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-medium bg-foreground/[0.06] text-foreground/75"
          >
            <Server className="h-5 w-5" strokeWidth={2} />
          </span>
          <h1 className="font-heading text-[18px] font-medium leading-snug tracking-tight text-foreground">
            This pod has no self-service recovery set up.
          </h1>
        </div>
        <div className="flex flex-col gap-2 text-[13.5px] leading-relaxed text-foreground/70">
          <p>Ask the pod&apos;s operator to reset your password. On the pod&apos;s server they run:</p>
          <code className="rounded-medium bg-foreground/[0.06] px-3 py-2 font-mono text-[12px] text-foreground/85">
            synap users reset-password &lt;your email&gt;
          </code>
        </div>
      </div>
    );
  }

  return (
    <>
      <Header title="Can't sign in?">Pick a way back in.</Header>
      {doorError ? (
        <div
          className="flex items-start gap-2 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{doorError}</span>
        </div>
      ) : null}
      <ul className="flex flex-col gap-2">
        {doors.map((door) => {
          const { icon: Icon, title, hint } = DOOR_COPY[door];
          const expanded = open === door;
          return (
            <li
              key={door}
              className="rounded-medium bg-foreground/[0.03] ring-1 ring-inset ring-foreground/10"
            >
              <button
                type="button"
                aria-expanded={door === "code" ? expanded : undefined}
                disabled={busy !== null}
                onClick={() => {
                  if (door === "code") setOpen(expanded ? null : "code");
                  else if (door === "email") void startEmail();
                  else void startCloud();
                }}
                className="flex w-full items-center gap-3 rounded-medium px-3 py-3 text-left transition-colors hover:bg-foreground/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
              >
                <Icon className="h-4 w-4 shrink-0 text-foreground/70" strokeWidth={2} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13.5px] font-medium text-foreground">{title}</span>
                  <span className="text-[12px] text-foreground/55">{hint}</span>
                </span>
                {busy === door ? (
                  <span className="text-[12px] text-foreground/55">Opening…</span>
                ) : null}
              </button>
              {door === "code" && expanded ? (
                <div className="px-3 pb-3">
                  <RedeemForm />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function RedeemForm() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const r = await recoveryApi.redeem(email.trim(), code);
    if (r.ok) {
      // Same page, new URL: the flow loader completes the recovery.
      window.location.assign(r.data.continueUrl);
      return;
    }
    setError(r.message);
    setSubmitting(false);
  };

  return (
    <form className="flex flex-col gap-3 pt-1" onSubmit={submit}>
      {error ? (
        <div
          className="flex items-start gap-2 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      <Input
        label="Account email"
        labelPlacement="outside"
        type="email"
        autoComplete="email"
        value={email}
        onValueChange={setEmail}
        isRequired
        size="sm"
        radius="md"
        variant="flat"
      />
      <Input
        label="Recovery code"
        labelPlacement="outside"
        placeholder="XXXX-XXXX-XXXX-XXXX"
        autoComplete="one-time-code"
        autoCapitalize="characters"
        spellCheck="false"
        value={code}
        onValueChange={setCode}
        isRequired
        size="sm"
        radius="md"
        variant="flat"
        classNames={{ input: "font-mono tracking-wide" }}
      />
      <p className="text-[12px] text-foreground/55">
        The code is used up, and your other devices are signed out.
      </p>
      <Button
        type="submit"
        color="primary"
        radius="md"
        size="md"
        className="self-start"
        isDisabled={submitting || !email.trim() || !code.trim()}
        isLoading={submitting}
      >
        Recover account
      </Button>
    </form>
  );
}

// ─── Flow ───────────────────────────────────────────────────────────────

type FlowState =
  | { kind: "loading"; finishing: boolean }
  | { kind: "expired" }
  | { kind: "failed"; message: string }
  | { kind: "flow"; flow: KratosFlow };

function RecoveryFlowLoader({ flowId }: { flowId: string }) {
  const [state, setState] = useState<FlowState>({ kind: "loading", finishing: false });
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback((flow: KratosFlow) => {
    setState({ kind: "flow", flow });
    setValues(initialFieldValues(flow, RECOVERY_GROUPS));
    const errors = (flow.ui.messages ?? [])
      .filter((m) => m.type === "error")
      .map((m) => m.text);
    setError(errors.length ? errors.join(" ") : null);
  }, []);

  const submit = useCallback(
    async (flow: KratosFlow, body: Record<string, string>) => {
      setSubmitting(true);
      setError(null);
      try {
        const r = await submitSelfServiceFlow(flow, body);
        if (r.kind === "redirect") {
          // Recovered: Kratos issued a privileged session and a settings flow.
          setState({ kind: "loading", finishing: true });
          window.location.assign(r.to);
          return;
        }
        if (r.kind === "flow") show(r.flow);
        else if (r.kind === "error") {
          if (r.error.id === "self_service_flow_expired") setState({ kind: "expired" });
          else setError(r.error.message ?? "Recovery failed.");
        } else setError("Recovery failed. Try again.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Recovery failed.");
      } finally {
        setSubmitting(false);
      }
    },
    [show]
  );

  useEffect(() => {
    let cancelled = false;
    // Read the one-time code once, then scrub it from the address bar.
    const code = readRecoveryFragment(window.location.hash);
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    void (async () => {
      try {
        const flow = await fetchFlow("recovery", flowId);
        if (cancelled) return;
        if (code) {
          setState({ kind: "loading", finishing: true });
          const hidden = initialFieldValues(flow, RECOVERY_GROUPS);
          await submit(flow, { ...hidden, method: "code", code });
          return;
        }
        show(flow);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof FlowLoadError && (err.status === 410 || err.status === 404 || err.id === "self_service_flow_expired")) {
          setState({ kind: "expired" });
        } else {
          setState({
            kind: "failed",
            message: err instanceof Error ? err.message : "Couldn't load this recovery.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flowId, show, submit]);

  if (state.kind === "loading") {
    return (
      <>
        <Header title={state.finishing ? "Recovering your account…" : "Can't sign in?"} />
        <div className="h-24 rounded-medium bg-foreground/[0.05] shimmer-pulse" aria-busy />
      </>
    );
  }
  if (state.kind === "expired") {
    return (
      <>
        <Header title="This recovery link expired.">
          Links last 15 minutes and work once. Start again to get a new one.
        </Header>
        <Button
          color="primary"
          radius="md"
          className="self-start"
          onPress={() => window.location.assign("/recovery")}
        >
          Start again
        </Button>
      </>
    );
  }
  if (state.kind === "failed") {
    return (
      <>
        <Header title="Can't sign in?" />
        <LoadFailed message={state.message} onRetry={() => window.location.reload()} />
      </>
    );
  }
  return (
    <RecoveryFlowPanel
      flow={state.flow}
      values={values}
      setValues={setValues}
      submitting={submitting}
      error={error}
      onSubmit={(body) => void submit(state.flow, body)}
    />
  );
}

/** The Kratos recovery flow form. Exported for the render test. */
export function RecoveryFlowPanel({
  flow,
  values,
  setValues,
  submitting,
  error,
  onSubmit,
}: {
  flow: KratosFlow;
  values: Record<string, string>;
  setValues: (u: (prev: Record<string, string>) => Record<string, string>) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: (body: Record<string, string>) => void;
}) {
  const codeStep = flow.state === "sent_email" || flow.ui.nodes.some((n) => n.attributes?.name === "code");
  return (
    <>
      {codeStep ? (
        <Header title="Enter your code">
          Enter the 6-digit code to continue. Then set a new password.
        </Header>
      ) : (
        <Header title="Email me a code">
          Enter your account email. If it belongs to an account here, a code is on its way.
        </Header>
      )}
      <KratosFields
        flow={flow}
        groups={RECOVERY_GROUPS}
        values={values}
        setValues={setValues}
        onSubmit={onSubmit}
        submitting={submitting}
        submitLabel={codeStep ? "Recover account" : "Send code"}
        error={error}
      />
    </>
  );
}
