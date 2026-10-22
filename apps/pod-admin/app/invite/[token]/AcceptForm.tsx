"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { CopyButton } from "../../_lib/copy-button";
import { Button, CardBody, Input, Tab, Tabs } from "@heroui/react";
import { AlertCircle, CheckCircle2, LogIn, UserPlus } from "lucide-react";
import {
  collectErrorMessages,
  createLoginFlow,
  extractInitialValues,
  FLOW_RESET_ERROR_IDS,
  mergeHiddenValues,
  passwordLoginBody,
  signOutInPlace,
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
import {
  acceptInviteRefusal,
  createAccountRefusal,
  inviteLine,
  inviteTitle,
  joinedHeadline,
  type AcceptRefusal,
  type InviteSubject,
} from "./invite-outcome";

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

type OpenInvite = Extract<InvitePreview, { expired: false }>;

type PageState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "not-found" }
  | { status: "expired" }
  | {
      status: "ready";
      preview: OpenInvite;
      session: KratosSession | null;
    }
  /**
   * Joined. `signedIn`: this browser holds a pod session (sign-in path, or the
   * new account's automatic sign-in worked), so the console is one click away.
   */
  | {
      status: "done";
      subject: InviteSubject;
      email: string;
      signedIn: boolean;
    };

type AcceptTab = "register" | "login";

/** The pod's own host (the API), not the console host this page is served on. */
function podApiHost(): string | undefined {
  try {
    return POD_URL ? new URL(POD_URL).host : undefined;
  } catch {
    return undefined;
  }
}

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
  // What failed and can be retried in place (the terminal refusals change the
  // page state instead).
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const previewQuery = trpc.workspaces.previewInvite.useQuery(
    { token },
    { retry: 1, staleTime: Infinity }
  );

  const acceptMutation = trpc.workspaces.acceptInvite.useMutation();

  const done = useCallback((preview: OpenInvite, signedIn: boolean) => {
    setState({
      status: "done",
      subject: preview,
      email: preview.email,
      signedIn,
    });
  }, []);

  /** One place a refusal becomes what the page shows. */
  const refuse = useCallback(
    async (refusal: AcceptRefusal, preview: OpenInvite) => {
      switch (refusal.kind) {
        case "not-found":
          setState({ status: "not-found" });
          return;
        case "expired":
          setState({ status: "expired" });
          return;
        case "wrong-account":
          setState({ status: "ready", preview, session: await whoami() });
          return;
        case "account-exists":
          setAccountExists(true);
          setTab("login");
          return;
        case "retry":
          setAcceptError(refusal.message);
          return;
      }
    },
    []
  );

  const accept = useCallback(
    async (preview: OpenInvite) => {
      setAcceptError(null);
      try {
        await acceptMutation.mutateAsync({ token });
        done(preview, true);
      } catch (err) {
        await refuse(acceptInviteRefusal(err), preview);
      }
    },
    [acceptMutation, token, done, refuse]
  );

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
        setState({ status: "error" });
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
  }, [previewQuery.isLoading, previewQuery.isError, previewQuery.data]);

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
        <DoneBody
          subject={state.subject}
          email={state.email}
          signedIn={state.signedIn}
        />
      </Shell>
    );

  const { preview, session } = state;

  // Signed in, but as someone the invite does not name.
  const sessionEmail = session?.identity.traits?.email;
  if (session && sessionEmail?.toLowerCase() !== preview.email.toLowerCase()) {
    return (
      <Shell podHost={podHost}>
        <WrongAccountBody
          inviteEmail={preview.email}
          signedInAs={sessionEmail}
          onSignedOut={() =>
            setState({ status: "ready", preview, session: null })
          }
        />
      </Shell>
    );
  }

  // Signed in as the invited person → one-click accept
  if (session) {
    return (
      <Shell podHost={podHost}>
        <InviteHeader preview={preview} />
        {acceptError ? <ErrorBanner message={acceptError} /> : null}
        <Button
          color="primary"
          radius="md"
          size="md"
          isLoading={acceptMutation.isPending}
          onPress={() => void accept(preview)}
        >
          Accept and join
        </Button>
      </Shell>
    );
  }

  // Not signed in → create an account or sign in
  const returnHere = `/invite/${encodeURIComponent(token)}`;
  return (
    <Shell podHost={podHost}>
      <InviteHeader preview={preview} />
      <Tabs
        aria-label="How to accept"
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
            onSuccess={(signedIn) => done(preview, signedIn)}
            onRefused={(refusal) => void refuse(refusal, preview)}
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
            <p
              role="status"
              className="mt-4 text-[13px] leading-relaxed text-foreground/70"
            >
              This pod already has an account for this email. Sign in with it to
              join. Forgot the password?{" "}
              <a
                href={`/recovery?return=${encodeURIComponent(returnHere)}`}
                className="text-foreground/85 underline underline-offset-2"
              >
                Reset it
              </a>
              .
            </p>
          ) : null}
          <LoginPanel
            inviteEmail={preview.email}
            focusPassword={accountExists}
            onSuccess={() => accept(preview)}
            onSessionDetected={onSessionDetected}
            acceptError={acceptError}
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

/** The pod's own rule (`/setup/accept-invite`), said before it is broken. */
const MIN_PASSWORD = 8;

function RegisterPanel({
  token,
  inviteEmail,
  onSuccess,
  onRefused,
}: {
  token: string;
  inviteEmail: string;
  /** `signedIn`: the new account's automatic sign-in worked. */
  onSuccess: (signedIn: boolean) => void;
  onRefused: (refusal: AcceptRefusal) => void;
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
      let res: Response;
      try {
        res = await fetch(`${POD_URL}/api/hub/setup/accept-invite`, {
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
      } catch {
        const refusal = createAccountRefusal(null, null);
        if (refusal.kind === "retry") setError(refusal.message);
        setSubmitting(false);
        return;
      }
      try {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
            code?: string;
          } | null;
          const refusal = createAccountRefusal(res.status, body);
          if (refusal.kind === "retry") setError(refusal.message);
          else onRefused(refusal);
          return;
        }
        onSuccess(await signInNewAccount(inviteEmail, password));
      } finally {
        setSubmitting(false);
      }
    },
    [inviteEmail, password, name, token, onSuccess, onRefused]
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
        label="Display name (optional)"
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
        description={`At least ${MIN_PASSWORD} characters.`}
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
        isDisabled={password.length < MIN_PASSWORD}
      >
        {submitting ? "Creating account…" : "Create account and join"}
      </Button>
    </form>
  );
}

// ─── Login panel ─────────────────────────────────────────────────────────────

const SIGN_IN_UNREACHABLE =
  "We could not reach this pod's sign-in. Check your connection and try again.";

function LoginPanel({
  inviteEmail,
  focusPassword,
  onSuccess,
  onSessionDetected,
  acceptError,
  isAccepting,
}: {
  inviteEmail: string;
  /** Put the cursor in the password (the person was just sent here). */
  focusPassword: boolean;
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
      } catch {
        if (!cancelled) setError(SIGN_IN_UNREACHABLE);
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
        const r = await submitLoginFlow(
          flow,
          passwordLoginBody(flow, inviteEmail, values["password"] ?? "")
        );
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
          setError(
            r.structuralError.message ??
              "Signing in did not work. Check your password and try again."
          );
        }
      } catch {
        setError(SIGN_IN_UNREACHABLE);
      } finally {
        setSubmitting(false);
      }
    },
    [flow, values, inviteEmail, onSuccess]
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
        autoFocus={focusPassword}
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
        isLoading={submitting || isAccepting}
        isDisabled={!values["password"]}
      >
        {submitting
          ? "Signing in…"
          : isAccepting
            ? "Joining…"
            : "Sign in and join"}
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

function InviteHeader({ preview }: { preview: OpenInvite }) {
  return (
    <>
      <span
        aria-hidden
        className="glass-icon flex h-12 w-12 items-center justify-center self-start bg-primary/15"
      >
        <UserPlus className="h-5 w-5 text-foreground/85" strokeWidth={2} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[20px] font-medium tracking-tight text-foreground">
          {inviteTitle(preview)}
        </h1>
        <p className="text-[13.5px] leading-relaxed text-foreground/65">
          {inviteLine(preview)}
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
    <div
      role="alert"
      className="flex items-start gap-2 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30"
    >
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

function ErrorBody({ onRetry }: { onRetry: () => void }) {
  return (
    <>
      <AlertCircle className="h-10 w-10 text-warning" />
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[20px] font-medium text-foreground">
          We could not load this invitation
        </h1>
        <p className="text-[13.5px] text-foreground/65">
          This pod did not answer. Check your connection and try again.
        </p>
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
          This invitation is no longer valid
        </h1>
        <p className="text-[13.5px] text-foreground/65">
          It was already used or withdrawn. Ask the person who invited you to
          send a new one.
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
          This invitation has expired
        </h1>
        <p className="text-[13.5px] text-foreground/65">
          Ask the person who invited you to send a new one.
        </p>
      </div>
    </>
  );
}

/**
 * Joined. One primary: "Open in Synap" (`pairExit`: the app opens THIS pod's
 * sign-in with the email filled in; a hint, never a secret), with the device's
 * install hatch beside it. Focus moves to the headline so a screen reader
 * hears the outcome.
 */
function DoneBody({
  subject,
  email,
  signedIn,
}: {
  subject: InviteSubject;
  email: string;
  signedIn: boolean;
}) {
  const exit = pairExit(POD_URL, email);
  const host = podApiHost();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <>
      <CheckCircle2 aria-hidden className="h-10 w-10 text-success" />
      <div className="flex flex-col gap-1.5">
        <h1
          ref={heading}
          tabIndex={-1}
          className="font-heading text-[20px] font-medium text-foreground outline-none"
        >
          {joinedHeadline(subject, host)}
        </h1>
        <p className="text-[13.5px] leading-relaxed text-foreground/65">
          {exit ? "In the Synap app, sign" : "Sign"} in to {host ?? "this pod"}{" "}
          as <span className="font-medium text-foreground/85">{email}</span>{" "}
          with this pod&apos;s password.
        </p>
      </div>
      {exit ? <OpenInSynap exit={exit} /> : null}
      {POD_URL ? <PodAddress origin={new URL(POD_URL).origin} /> : null}
      <a
        href={signedIn ? "/" : "/login?return=/"}
        className="inline-flex min-h-10 items-center self-start text-[13px] text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
      >
        {signedIn ? "Open this pod's console" : "Sign in to this pod's console"}
      </a>
    </>
  );
}

/**
 * The pod's address, to paste where the app asks for it: an installed app
 * that predates `synap://pair` opens without it, and a phone without the app
 * needs it once installed.
 */
function PodAddress({ origin }: { origin: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[12.5px] text-foreground/65">
        If the app asks for this pod&apos;s address:
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-[12px] leading-5 text-foreground/85">
          {origin}
        </span>
        <CopyButton
          text={origin}
          label="Copy"
          variant="light"
          ariaLabel="Copy this pod's address"
        />
      </div>
    </div>
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

function WrongAccountBody({
  inviteEmail,
  signedInAs,
  onSignedOut,
}: {
  inviteEmail: string;
  signedInAs?: string;
  onSignedOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await signOutInPlace();
      onSignedOut();
    } catch {
      setError("We could not sign you out. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <AlertCircle className="h-10 w-10 text-warning" />
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[20px] font-medium text-foreground">
          This invitation is for {inviteEmail}
        </h1>
        <p className="text-[13.5px] text-foreground/65">
          {signedInAs ? (
            <>
              You are signed in as{" "}
              <span className="font-medium text-foreground/85">
                {signedInAs}
              </span>
              .{" "}
            </>
          ) : null}
          Sign out to join as {inviteEmail}.
        </p>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      <Button
        color="primary"
        radius="md"
        size="md"
        isLoading={busy}
        onPress={() => void signOut()}
      >
        Sign out and continue
      </Button>
    </>
  );
}
