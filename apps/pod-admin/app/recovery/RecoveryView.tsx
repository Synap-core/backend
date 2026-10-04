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
  ArrowLeft,
  Cloud,
  KeyRound,
  LifeBuoy,
  Mail,
  Server,
} from "lucide-react";
import {
  RECOVERY_DOOR_COPY,
  RECOVERY_NO_DOORS_COPY,
  operatorResetCommand,
  operatorResetMessage,
  type RecoveryDoors,
} from "@synap-core/types/account-recovery";
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
  recoveryCallDetail,
  redeemFailureMessage,
  visibleDoors,
  type RecoveryDoorKind,
} from "../../lib/account-recovery";
import { initialFieldValues, KratosFields } from "../_lib/kratos-fields";
import { CopyButton, ErrorNote, errorDetail } from "../_lib/copy-button";

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
            Back to sign in
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
  detail,
  onRetry,
  actionLabel = "Try again",
}: {
  message: string;
  detail?: string | null;
  onRetry: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ErrorNote message={message} detail={detail} />
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
  | { kind: "failed"; detail: string }
  | { kind: "ready"; doors: RecoveryDoors };

/** Icons are this surface's; the words are the shared RECOVERY_DOOR_COPY. */
const DOOR_META: Record<
  RecoveryDoorKind,
  { icon: typeof KeyRound; copy: { title: string; body: string } }
> = {
  code: { icon: KeyRound, copy: RECOVERY_DOOR_COPY.recoveryCode },
  email: { icon: Mail, copy: RECOVERY_DOOR_COPY.email },
  cloud: { icon: Cloud, copy: RECOVERY_DOOR_COPY.cloud },
};

type DoorError = { message: string; detail?: string };

function RecoveryHub() {
  const router = useRouter();
  const [state, setState] = useState<HubState>({ kind: "loading" });
  const [open, setOpen] = useState<RecoveryDoorKind | null>(null);
  const [busy, setBusy] = useState<RecoveryDoorKind | null>(null);
  const [doorError, setDoorError] = useState<DoorError | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await recoveryApi.doors();
    setState(
      r.ok
        ? { kind: "ready", doors: r.data }
        : { kind: "failed", detail: recoveryCallDetail(r) }
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
      else setDoorError({ message: "Couldn't start email recovery. Try again." });
    } catch (err) {
      setDoorError({ message: "Couldn't start email recovery. Try again.", detail: errorDetail(err) });
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
        setDoorError({ message: "Synap Cloud sign-in isn't available on this pod right now." });
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
      setDoorError({ message: "Synap Cloud sign-in couldn't start. Try again." });
    } catch (err) {
      setDoorError({ message: "Synap Cloud sign-in couldn't start. Try again.", detail: errorDetail(err) });
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
        <LoadFailed
          message="Couldn't check how this pod recovers accounts."
          detail={state.detail}
          onRetry={() => void load()}
        />
      </>
    );
  }

  const doors = visibleDoors(state.doors);
  if (doors.length === 0) return <NoDoors />;

  return (
    <>
      <Header title="Can't sign in?">Pick a way back in.</Header>
      {doorError ? <ErrorNote message={doorError.message} detail={doorError.detail} /> : null}
      <ul className="flex flex-col gap-2">
        {doors.map((door) => {
          const {
            icon: Icon,
            copy: { title, body: hint },
          } = DOOR_META[door];
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

/**
 * EXPLAIN — no door works here, so say who can help and hand the reader the
 * message to send them. Exported for the render test.
 */
export function NoDoors() {
  const host = typeof window === "undefined" ? null : window.location.host;
  return (
    <div className="flex flex-col gap-4" role="status">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-medium bg-foreground/[0.06] text-foreground/75"
        >
          <Server className="h-5 w-5" strokeWidth={2} />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-[18px] font-medium leading-snug tracking-tight text-foreground">
            {RECOVERY_NO_DOORS_COPY.title}
          </h1>
          <p className="text-[13.5px] leading-relaxed text-foreground/70">
            {RECOVERY_NO_DOORS_COPY.body}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton
          text={operatorResetMessage("", host)}
          label="Copy message for them"
          size="md"
        />
        <CopyButton
          text={operatorResetCommand("")}
          label="Copy reset command"
          variant="light"
          size="md"
        />
      </div>
      <code className="rounded-medium bg-foreground/[0.06] px-3 py-2 font-mono text-[12px] text-foreground/85">
        {operatorResetCommand("")}
      </code>
    </div>
  );
}

function RedeemForm() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<DoorError | null>(null);

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
    const view = redeemFailureMessage(r.error);
    setError({ message: view.message, detail: view.failed ? recoveryCallDetail(r) : undefined });
    setSubmitting(false);
  };

  return (
    <form className="flex flex-col gap-3 pt-1" onSubmit={submit}>
      {error ? <ErrorNote message={error.message} detail={error.detail} /> : null}
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
  | { kind: "failed"; detail: string }
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
          else setError("Recovery didn't go through. Try again.");
        } else setError("Recovery didn't go through. Try again.");
      } catch {
        setError("Couldn't reach this pod. Try again.");
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
          setState({ kind: "failed", detail: errorDetail(err) });
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
        <LoadFailed
          message="Couldn't load this recovery."
          detail={state.detail}
          onRetry={() => window.location.reload()}
        />
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
