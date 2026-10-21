"use client";

import { useCallback, useEffect, useState } from "react";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { Button, CardBody, Input, Tab, Tabs } from "@heroui/react";
import { AlertCircle, CheckCircle2, LogIn, UserPlus } from "lucide-react";
import {
  collectErrorMessages,
  createLoginFlow,
  extractInitialValues,
  FLOW_RESET_ERROR_IDS,
  mergeHiddenValues,
  passwordLoginBody,
  submitLoginFlow,
  whoami,
  type KratosFlow,
  type KratosSession,
} from "../../../lib/kratos-flow";
import { trpc, POD_URL } from "../../../lib/trpc";
import { formatRelative, formatTimestamp } from "../../../lib/format";
import { pairExit } from "../../../lib/open-in";
import {
  externalProps,
  PlacedFallback,
  usePlacedExit,
} from "../../../lib/exit-link";

type InvitePreview =
  | {
      expired: false;
      type: "workspace" | "pod";
      inviterName: string;
      role: string;
      email: string;
      expiresAt: Date;
      workspaceName?: string;
    }
  | { expired: true };

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "not-found" }
  | { status: "expired" }
  | {
      status: "ready";
      preview: Extract<InvitePreview, { expired: false }>;
      session: KratosSession | null;
    }
  /**
   * Joined. `signedIn`: this browser holds a pod session (sign-in path, or the
   * new account's automatic sign-in worked), so the console is one click away.
   */
  | { status: "done"; email: string; signedIn: boolean };

type AcceptTab = "register" | "login";

export function AcceptForm({
  token,
  podHost,
}: {
  token: string;
  podHost?: string;
}) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [tab, setTab] = useState<AcceptTab>("register");
  // Set when "Create account" found an account for this email already: the
  // person is moved to "Sign in" and told why.
  const [accountExists, setAccountExists] = useState(false);

  const previewQuery = trpc.workspaces.previewInvite.useQuery(
    { token },
    { retry: 1, staleTime: Infinity }
  );

  const acceptMutation = trpc.workspaces.acceptInvite.useMutation({
    onSuccess: () => {
      setState((prev) =>
        prev.status === "ready"
          ? { status: "done", email: prev.preview.email, signedIn: true }
          : prev
      );
    },
  });

  const onLoginSuccess = useCallback(async () => {
    try {
      await acceptMutation.mutateAsync({ token });
    } catch {
      // error shown via acceptMutation.error
    }
  }, [acceptMutation, token]);

  // Called by LoginPanel when it discovers an existing Kratos session during
  // flow init — bypasses AcceptForm's whoami() which may have returned null on
  // first render. We re-evaluate state with the real session so the email-match
  // guard runs before any acceptance attempt.
  const onSessionDetected = useCallback((session: KratosSession) => {
    setState((prev) => {
      if (prev.status !== "ready") return prev;
      return { ...prev, session };
    });
  }, []);

  useEffect(() => {
    if (previewQuery.isLoading) return;
    void (async () => {
      if (previewQuery.isError) {
        setState({
          status: "error",
          message: previewQuery.error?.message ?? "Could not load invite.",
        });
        return;
      }
      const preview = previewQuery.data;
      if (!preview) {
        setState({ status: "not-found" });
        return;
      }
      if (preview.expired) {
        setState({ status: "expired" });
        return;
      }
      const session = await whoami();
      setState({ status: "ready", preview, session });
    })();
  }, [
    previewQuery.isLoading,
    previewQuery.isError,
    previewQuery.error,
    previewQuery.data,
  ]);

  if (state.status === "loading")
    return (
      <Shell podHost={podHost}>
        <LoadingBody />
      </Shell>
    );
  if (state.status === "error")
    return (
      <Shell podHost={podHost}>
        <ErrorBody
          message={state.message}
          onRetry={() => {
            setState({ status: "loading" });
            void previewQuery.refetch();
          }}
        />
      </Shell>
    );
  if (state.status === "not-found")
    return (
      <Shell podHost={podHost}>
        <NotFoundBody />
      </Shell>
    );
  if (state.status === "expired")
    return (
      <Shell podHost={podHost}>
        <ExpiredBody />
      </Shell>
    );
  if (state.status === "done")
    return (
      <Shell podHost={podHost}>
        <DoneBody email={state.email} signedIn={state.signedIn} />
      </Shell>
    );

  const { preview, session } = state;

  // Logged-in but wrong account
  if (
    session &&
    session.identity.traits?.email?.toLowerCase() !==
      preview.email.toLowerCase()
  ) {
    return (
      <Shell podHost={podHost}>
        <WrongAccountBody inviteEmail={preview.email} />
      </Shell>
    );
  }

  // Logged-in + email matches → one-click accept
  if (session) {
    return (
      <Shell podHost={podHost}>
        <InviteHeader preview={preview} />
        {acceptMutation.error ? (
          <ErrorBanner message={acceptMutation.error.message} />
        ) : null}
        <Button
          color="primary"
          radius="md"
          size="md"
          isLoading={acceptMutation.isPending}
          onPress={() => acceptMutation.mutate({ token })}
        >
          Accept invite
        </Button>
      </Shell>
    );
  }

  // Not logged in → register or sign in
  return (
    <Shell podHost={podHost}>
      <InviteHeader preview={preview} />
      <Tabs
        aria-label="Accept options"
        variant="underlined"
        selectedKey={tab}
        onSelectionChange={(key) => setTab(key as AcceptTab)}
        classNames={{
          base: "w-full",
          tabList: "gap-4 border-b border-foreground/[0.08] pb-0",
        }}
      >
        <Tab
          key="register"
          title={
            <span className="flex items-center gap-1.5 text-[13px]">
              <UserPlus className="h-3.5 w-3.5" />
              Create account
            </span>
          }
        >
          <RegisterPanel
            token={token}
            inviteEmail={preview.email}
            onSuccess={(signedIn) => {
              const crmUrl = process.env.NEXT_PUBLIC_CRM_URL;
              if (crmUrl) {
                window.location.assign(
                  `${crmUrl}/login?podUrl=${encodeURIComponent(POD_URL)}`
                );
              } else {
                setState({ status: "done", email: preview.email, signedIn });
              }
            }}
            onAccountExists={() => {
              setAccountExists(true);
              setTab("login");
            }}
          />
        </Tab>
        <Tab
          key="login"
          title={
            <span className="flex items-center gap-1.5 text-[13px]">
              <LogIn className="h-3.5 w-3.5" />
              Sign in
            </span>
          }
        >
          {accountExists ? (
            <p className="mt-4 text-[13px] leading-relaxed text-foreground/70">
              This pod already has an account for this email. Sign in with it to
              accept. Forgot the password?{" "}
              <a
                href="/recovery"
                className="text-foreground/85 underline underline-offset-2"
              >
                Reset it
              </a>
              .
            </p>
          ) : null}
          <LoginPanel
            inviteEmail={preview.email}
            onSuccess={onLoginSuccess}
            onSessionDetected={onSessionDetected}
            acceptError={acceptMutation.error?.message ?? null}
            isAccepting={acceptMutation.isPending}
          />
        </Tab>
      </Tabs>
    </Shell>
  );
}

// ─── Register panel ──────────────────────────────────────────────────────────

/**
 * Sign the new account in, so the done screen can open the console as them.
 * `passwordLoginBody` posts only the hidden fields + the password method.
 * `false` when it did not work: the account exists and the invite
 * is accepted either way, the person signs in later.
 */
async function signInNewAccount(
  identifier: string,
  password: string
): Promise<boolean> {
  try {
    const started = await createLoginFlow();
    // A session already in this browser counts only if it is this account
    // (an inviter testing their own invite is signed in as themselves).
    if (started.existingSession) {
      const held = started.existingSession.identity.traits?.email;
      return held?.toLowerCase() === identifier.toLowerCase();
    }
    if (!started.flow) return false;
    const r = await submitLoginFlow(
      started.flow,
      passwordLoginBody(started.flow, identifier, password)
    );
    return Boolean(r.session);
  } catch {
    return false;
  }
}

function RegisterPanel({
  token,
  inviteEmail,
  onSuccess,
  onAccountExists,
}: {
  token: string;
  inviteEmail: string;
  /** `signedIn`: the new account's automatic sign-in worked. */
  onSuccess: (signedIn: boolean) => void;
  onAccountExists: () => void;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setSubmitting(true);
      try {
        const res = await fetch(`${POD_URL}/api/hub/setup/accept-invite`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: inviteEmail,
            password,
            name: name.trim() || undefined,
            inviteToken: token,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        if (res.status === 409 && data.code === "ACCOUNT_EXISTS") {
          onAccountExists();
          return;
        }
        if (!res.ok) {
          setError(data.error ?? `Failed (${res.status})`);
          return;
        }
        onSuccess(await signInNewAccount(inviteEmail, password));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Request failed");
      } finally {
        setSubmitting(false);
      }
    },
    [inviteEmail, password, name, token, onSuccess, onAccountExists]
  );

  return (
    <form className="mt-4 flex flex-col gap-4" onSubmit={onSubmit}>
      {/* Honest about what this makes (2026-10-21): an account on THIS pod
          with its own password. Joining with a Synap Cloud account is not
          offered to invitees yet. */}
      <p className="text-[13px] leading-relaxed text-foreground/70">
        This makes your account on this pod, with its own password.
      </p>
      {error ? <ErrorBanner message={error} /> : null}
      <Input
        label="Email"
        labelPlacement="outside"
        type="email"
        value={inviteEmail}
        isReadOnly
        size="sm"
        radius="md"
        variant="flat"
        classNames={{ input: "text-foreground/65" }}
      />
      <Input
        label="Display name"
        labelPlacement="outside"
        type="text"
        placeholder="Jane Smith"
        value={name}
        onValueChange={setName}
        autoComplete="name"
        size="sm"
        radius="md"
        variant="flat"
      />
      <Input
        label="Password"
        labelPlacement="outside"
        type="password"
        value={password}
        onValueChange={setPassword}
        autoComplete="new-password"
        isRequired
        size="sm"
        radius="md"
        variant="flat"
      />
      <Button
        type="submit"
        color="primary"
        radius="md"
        size="md"
        isLoading={submitting}
        isDisabled={!password}
      >
        {submitting ? "Creating account…" : "Create account & accept"}
      </Button>
    </form>
  );
}

// ─── Login panel ─────────────────────────────────────────────────────────────

function LoginPanel({
  inviteEmail,
  onSuccess,
  onSessionDetected,
  acceptError,
  isAccepting,
}: {
  inviteEmail: string;
  onSuccess: () => Promise<void>;
  onSessionDetected: (session: KratosSession) => void;
  acceptError: string | null;
  isAccepting: boolean;
}) {
  const [flow, setFlow] = useState<KratosFlow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await createLoginFlow();
        if (cancelled) return;
        if (r.existingSession) {
          // Notify parent to re-evaluate with the real session — DO NOT call
          // onSuccess() here because the email-match guard hasn't run yet.
          onSessionDetected(r.existingSession);
          return;
        }
        if (!r.flow) throw new Error("No flow returned");
        const initial = {
          ...extractInitialValues(r.flow),
          identifier: inviteEmail,
        };
        setFlow(r.flow);
        setValues(initial);
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Failed to load sign-in"
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteEmail, onSessionDetected]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!flow) return;
      setSubmitting(true);
      setError(null);
      try {
        const r = await submitLoginFlow(flow, values);
        if (r.session) {
          await onSuccess();
          return;
        }
        if (r.flow) {
          setFlow(r.flow);
          setValues((prev) => mergeHiddenValues(prev, r.flow!));
          const errs = collectErrorMessages(r.flow);
          if (errs.length) setError(errs.join(" "));
          return;
        }
        if (r.structuralError) {
          if (r.structuralError.id === "session_already_available") {
            await onSuccess();
            return;
          }
          if (
            r.structuralError.id &&
            FLOW_RESET_ERROR_IDS.has(r.structuralError.id)
          ) {
            const fresh = await createLoginFlow();
            if (fresh.flow) {
              setFlow(fresh.flow);
              setValues((prev) => mergeHiddenValues(prev, fresh.flow!));
              setError("Please sign in again.");
            }
            return;
          }
          setError(r.structuralError.message ?? "Sign-in failed.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign-in failed");
      } finally {
        setSubmitting(false);
      }
    },
    [flow, values, onSuccess]
  );

  if (loading) {
    return (
      <div className="mt-4 h-24 rounded-md bg-foreground/[0.04] shimmer-pulse" />
    );
  }

  return (
    <form className="mt-4 flex flex-col gap-4" onSubmit={onSubmit}>
      {error || acceptError ? (
        <ErrorBanner message={error ?? acceptError!} />
      ) : null}
      <Input
        label="Email"
        labelPlacement="outside"
        type="email"
        value={inviteEmail}
        isReadOnly
        size="sm"
        radius="md"
        variant="flat"
        classNames={{ input: "text-foreground/65" }}
      />
      <Input
        label="Password"
        labelPlacement="outside"
        type="password"
        value={values["password"] ?? ""}
        onValueChange={(v) => setValues((p) => ({ ...p, password: v }))}
        autoComplete="current-password"
        isRequired
        size="sm"
        radius="md"
        variant="flat"
      />
      {/* hidden fields (CSRF token, etc.) */}
      {flow?.ui.nodes
        .filter((n) => n.attributes?.type === "hidden")
        .map((n, i) => {
          const name = n.attributes?.name as string;
          return (
            <input
              key={`h-${i}`}
              type="hidden"
              name={name}
              value={values[name] ?? ""}
              readOnly
            />
          );
        })}
      <Button
        type="submit"
        color="primary"
        radius="md"
        size="md"
        isLoading={submitting || isAccepting}
        isDisabled={!values["password"]}
      >
        {submitting
          ? "Signing in…"
          : isAccepting
            ? "Accepting invite…"
            : "Sign in & accept"}
      </Button>
    </form>
  );
}

// ─── Shared sub-components ───────────────────────────────────────────────────

/* `podHost` is threaded rather than read from a context because this route is
   UNAUTHENTICATED — the invitee has no session yet, so there is no identity to
   show, only which pod is inviting them. That is the one fact that makes an
   invite email distinguishable from a phishing one. */
function Shell({
  children,
  podHost,
}: {
  children: React.ReactNode;
  podHost?: string;
}) {
  return (
    <ReceiverShell podHost={podHost} width="sm">
      <CardBody className="flex flex-col gap-5 p-8">{children}</CardBody>
    </ReceiverShell>
  );
}

function InviteHeader({
  preview,
}: {
  preview: Extract<InvitePreview, { expired: false }>;
}) {
  const scope =
    preview.type === "workspace" && preview.workspaceName
      ? `workspace "${preview.workspaceName}"`
      : "this pod";
  return (
    <>
      <span
        aria-hidden
        className="glass-icon flex h-12 w-12 items-center justify-center self-start"
        style={{ background: "rgba(99, 102, 241, 0.18)" }}
      >
        <UserPlus className="h-5 w-5 text-foreground/85" strokeWidth={2} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[20px] font-medium tracking-tight text-foreground">
          You've been invited
        </h1>
        <p className="text-[13.5px] leading-relaxed text-foreground/65">
          <span className="text-foreground/85 font-medium">
            {preview.inviterName}
          </span>{" "}
          invited you to join {scope} as{" "}
          <span className="text-foreground/85">{preview.role}</span>.
        </p>
        <InviteExpiry expiresAt={preview.expiresAt} />
      </div>
    </>
  );
}

/**
 * WHEN — the trust signal this page already fetched and never showed. A
 * genuine invite has a deadline; saying so is part of how it reads as one.
 * The API answers `expired: true` for a past deadline, but a page left open
 * can cross it, so the past tense is rendered too rather than "in 0m".
 */
function InviteExpiry({ expiresAt }: { expiresAt: Date | string }) {
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return null;
  const msLeft = at.getTime() - Date.now();
  const expired = msLeft <= 0;
  return (
    <p
      className={`text-[12.5px] ${expired ? "text-danger" : "text-foreground/65"}`}
    >
      {expired ? "Expired" : "Expires"}{" "}
      <time dateTime={at.toISOString()}>
        {msLeft > 0 && msLeft < 60_000
          ? "in under a minute"
          : formatRelative(at)}
      </time>{" "}
      · {formatTimestamp(at)}
    </p>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function LoadingBody() {
  return (
    <>
      <div className="h-12 w-12 rounded-xl bg-foreground/[0.06] shimmer-pulse" />
      <div className="flex flex-col gap-2">
        <div className="h-5 w-48 rounded bg-foreground/[0.06] shimmer-pulse" />
        <div className="h-4 w-64 rounded bg-foreground/[0.04] shimmer-pulse" />
      </div>
    </>
  );
}

function ErrorBody({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <>
      <AlertCircle className="h-10 w-10 text-warning" />
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[20px] font-medium text-foreground">
          Something went wrong
        </h1>
        <p className="text-[13.5px] text-foreground/65">{message}</p>
      </div>
      <Button size="sm" variant="flat" radius="md" onPress={onRetry}>
        Try again
      </Button>
    </>
  );
}

function NotFoundBody() {
  return (
    <>
      <AlertCircle className="h-10 w-10 text-foreground/30" />
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[20px] font-medium text-foreground">
          Invite not found
        </h1>
        <p className="text-[13.5px] text-foreground/65">
          This invite link is invalid or has already been used.
        </p>
      </div>
    </>
  );
}

function ExpiredBody() {
  return (
    <>
      <AlertCircle className="h-10 w-10 text-foreground/30" />
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[20px] font-medium text-foreground">
          Invite expired
        </h1>
        <p className="text-[13.5px] text-foreground/65">
          This invite link has expired. Ask the pod admin to send a new one.
        </p>
      </div>
    </>
  );
}

/**
 * Joined. One primary: "Open in Synap" (`pairExit`: the app opens THIS pod's
 * sign-in with the email filled in; a hint, never a secret), with the device's
 * install hatch beside it, and the console as the web way in.
 */
function DoneBody({ email, signedIn }: { email: string; signedIn: boolean }) {
  const exit = pairExit(POD_URL, email);
  return (
    <>
      <CheckCircle2 className="h-10 w-10 text-success" />
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[20px] font-medium text-foreground">
          You're in
        </h1>
        <p className="text-[13.5px] leading-relaxed text-foreground/65">
          In the Synap app, sign in as{" "}
          <span className="font-medium text-foreground/85">{email}</span> with
          this pod's password.
        </p>
      </div>
      {exit ? <OpenInSynap exit={exit} /> : null}
      <a
        href={signedIn ? "/" : "/login?return=/"}
        className="inline-flex min-h-10 items-center self-start text-[13px] text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
      >
        {signedIn ? "Continue in the browser" : "Sign in in the browser"}
      </a>
    </>
  );
}

function OpenInSynap({
  exit,
}: {
  exit: NonNullable<ReturnType<typeof pairExit>>;
}) {
  const placed = usePlacedExit(exit);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {placed.href !== null ? (
        <Button
          as="a"
          href={placed.href}
          {...externalProps(placed.href)}
          color="primary"
          radius="md"
          size="md"
        >
          Open in Synap
        </Button>
      ) : null}
      <PlacedFallback placed={placed} />
    </div>
  );
}

function WrongAccountBody({ inviteEmail }: { inviteEmail: string }) {
  return (
    <>
      <AlertCircle className="h-10 w-10 text-warning" />
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[20px] font-medium text-foreground">
          Wrong account
        </h1>
        <p className="text-[13.5px] text-foreground/65">
          This invite is for{" "}
          <span className="font-medium text-foreground/85">{inviteEmail}</span>.
          Sign out and sign in with that account to accept it.
        </p>
      </div>
    </>
  );
}
