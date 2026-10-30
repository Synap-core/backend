"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { CopyButton } from "../../_lib/copy-button";
import { Button, CardBody, Input, Tab, Tabs } from "@heroui/react";
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  KeyRound,
  UserPlus,
} from "lucide-react";
import {
  resolveSignInWayLabel,
  type SignInWay,
} from "@synap-core/types/vocabulary";
import {
  collectErrorMessages,
  createBrowserFlow,
  createLoginFlow,
  extractInitialValues,
  FLOW_RESET_ERROR_IDS,
  mergeHiddenValues,
  passwordLoginBody,
  signOutInPlace,
  submitLoginFlow,
  submitSelfServiceFlow,
  whoami,
  type KratosFlow,
  type KratosSession,
} from "../../../lib/kratos-flow";
import { createPasskey, isPasskeySupported } from "../../../lib/passkey";
import {
  joinWithPasskey,
  joinWithSynapCloud,
  type JoinDeps,
  type JoinOutcome,
} from "./join-ways";
import { trpc, POD_URL } from "../../../lib/trpc";
import { formatRelative, formatTimestamp } from "../../../lib/format";
import { joinedDoors, type JoinedDoor } from "../../../lib/open-in";
import { ExitLink, externalProps, useIsPhone } from "../../../lib/exit-link";
import { inviteT } from "./copy";
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
   * `way`: how the account was made here (absent: an existing account).
   */
  | {
      status: "done";
      subject: InviteSubject;
      email: string;
      signedIn: boolean;
      way?: SignInWay;
    };

/** Join (make the account) or sign in with an account this pod already has. */
type AcceptMode = "join" | "sign-in";

/** The real Kratos calls behind the passkey and Synap Cloud ways. */
const JOIN_DEPS: JoinDeps = {
  createFlow: (returnTo) => createBrowserFlow("registration", returnTo),
  submit: submitSelfServiceFlow,
  createPasskey,
};

/**
 * Synap Cloud leaves this page and comes back to it (`?joined=synap_cloud`)
 * after the pod accepted the invite, which is then gone. What the Done screen
 * names (the space, the email) is kept for that return in this tab only.
 * Best-effort: without storage the person lands signed in on the console.
 */
const CLOUD_RETURN_KEY = (token: string) => `synap:invite-join:${token}`;
const JOINED_PARAM = "joined";

function rememberCloudJoin(token: string, subject: OpenInvite): void {
  try {
    sessionStorage.setItem(
      CLOUD_RETURN_KEY(token),
      JSON.stringify({
        type: subject.type,
        inviterName: subject.inviterName,
        role: subject.role,
        workspaceName: subject.workspaceName,
        email: subject.email,
      })
    );
  } catch {
    /* storage unavailable: see above */
  }
}

function recallCloudJoin(
  token: string
): (InviteSubject & { email: string }) | null {
  try {
    const raw = sessionStorage.getItem(CLOUD_RETURN_KEY(token));
    sessionStorage.removeItem(CLOUD_RETURN_KEY(token));
    return raw ? (JSON.parse(raw) as InviteSubject & { email: string }) : null;
  } catch {
    return null;
  }
}

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
  cloudSignIn,
}: {
  token: string;
  podHost?: string;
  /** The pod offers "Continue with Synap Cloud" (discovery, read server-side). */
  cloudSignIn: boolean;
}) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [mode, setMode] = useState<AcceptMode>("join");
  const joinedVia = useSearchParams().get(JOINED_PARAM);
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

  const done = useCallback(
    (preview: OpenInvite, signedIn: boolean, way?: SignInWay) => {
      setState({
        status: "done",
        subject: preview,
        email: preview.email,
        signedIn,
        ...(way ? { way } : {}),
      });
    },
    []
  );

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
          setMode("sign-in");
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
      // Back from Synap Cloud: the pod accepted the invite (so it is gone)
      // and signed this browser in as the invited person.
      if (!preview && joinedVia === "synap_cloud") {
        const joined = recallCloudJoin(token);
        const session = joined ? await whoami() : null;
        const email = session?.identity.traits?.email;
        if (joined && email?.toLowerCase() === joined.email.toLowerCase()) {
          setState({
            status: "done",
            subject: joined,
            email: joined.email,
            signedIn: true,
            way: "synap_cloud",
          });
          return;
        }
      }
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
    previewQuery.data,
    joinedVia,
    token,
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
          way={state.way}
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

  // Not signed in → make the account here (one of three ways) or sign in.
  const returnHere = `/invite/${encodeURIComponent(token)}`;
  return (
    <Shell podHost={podHost}>
      <InviteHeader preview={preview} />
      {mode === "join" ? (
        <JoinWays
          token={token}
          preview={preview}
          cloudSignIn={cloudSignIn}
          onJoined={(signedIn, way) => done(preview, signedIn, way)}
          onRefused={(refusal) => void refuse(refusal, preview)}
          onSignedIn={async () =>
            setState({ status: "ready", preview, session: await whoami() })
          }
        />
      ) : (
        <>
          {accountExists ? (
            <p
              role="status"
              className="text-[13px] leading-relaxed text-foreground/70"
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
        </>
      )}
      <QuietSwitch
        label={
          mode === "join"
            ? "Already have an account on this pod? Sign in"
            : "No account here yet? Join instead"
        }
        onPress={() => setMode(mode === "join" ? "sign-in" : "join")}
      />
    </Shell>
  );
}

function QuietSwitch({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="inline-flex min-h-10 items-center self-start text-[13px] text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
    >
      {label}
    </button>
  );
}

// ─── Join ways ───────────────────────────────────────────────────────────────

/**
 * The three ways to make the account (decision B2), as chips with a default:
 * a passkey on a device that can make one, else a password. Synap Cloud only
 * when the pod offers it. Labels come from the vocabulary door.
 */
function JoinWays({
  token,
  preview,
  cloudSignIn,
  onJoined,
  onRefused,
  onSignedIn,
}: {
  token: string;
  preview: OpenInvite;
  cloudSignIn: boolean;
  onJoined: (signedIn: boolean, way: SignInWay) => void;
  onRefused: (refusal: AcceptRefusal) => void;
  onSignedIn: () => Promise<void>;
}) {
  // Known only in the browser; null until then (no flash of a wrong default).
  const [passkeyOk, setPasskeyOk] = useState<boolean | null>(null);
  const [chosen, setChosen] = useState<SignInWay | null>(null);
  useEffect(() => setPasskeyOk(isPasskeySupported()), []);

  const ways: SignInWay[] = [
    ...(passkeyOk ? (["passkey"] as const) : []),
    "password",
    ...(cloudSignIn ? (["synap_cloud"] as const) : []),
  ];
  const way: SignInWay =
    chosen && ways.includes(chosen)
      ? chosen
      : passkeyOk
        ? "passkey"
        : "password";

  const panel = (w: SignInWay) =>
    w === "passkey" ? (
      <PasskeyPanel
        token={token}
        inviteEmail={preview.email}
        onJoined={() => onJoined(true, "passkey")}
        onSignedIn={onSignedIn}
      />
    ) : w === "synap_cloud" ? (
      <CloudPanel token={token} preview={preview} onSignedIn={onSignedIn} />
    ) : (
      <RegisterPanel
        token={token}
        inviteEmail={preview.email}
        onSuccess={(signedIn) => onJoined(signedIn, "password")}
        onRefused={onRefused}
      />
    );

  if (passkeyOk === null) {
    return (
      <div className="h-40 rounded-md bg-foreground/[0.04] shimmer-pulse" />
    );
  }
  return (
    <div className="flex flex-col">
      {ways.length > 1 ? (
        <Tabs
          aria-label="How to join"
          variant="solid"
          radius="full"
          size="sm"
          selectedKey={way}
          onSelectionChange={(key) => setChosen(key as SignInWay)}
          classNames={{ panel: "px-0 pb-0 pt-2" }}
        >
          {ways.map((w) => (
            <Tab key={w} title={resolveSignInWayLabel(w)}>
              {panel(w)}
            </Tab>
          ))}
        </Tabs>
      ) : (
        panel(way)
      )}
    </div>
  );
}

/** The page's own address with `?joined=<way>`: where Kratos sends the browser back. */
function joinReturnTo(token: string, way: SignInWay): string {
  const url = new URL(
    `/invite/${encodeURIComponent(token)}`,
    window.location.origin
  );
  url.searchParams.set(JOINED_PARAM, way);
  return url.toString();
}

/** What a join attempt that did not finish here means for the panel. */
async function settle(
  outcome: JoinOutcome,
  on: {
    joined: () => void;
    signedIn: () => Promise<void>;
    error: (message: string) => void;
  }
): Promise<void> {
  switch (outcome.kind) {
    case "joined":
      on.joined();
      return;
    case "redirect":
      window.location.assign(outcome.to);
      return;
    case "signed-in":
      await on.signedIn();
      return;
    case "refused":
      on.error(outcome.message);
      return;
    case "cancelled":
      return;
  }
}

const JOIN_UNREACHABLE =
  "We could not reach this pod's sign-in. Check your connection and try again.";

function PasskeyPanel({
  token,
  inviteEmail,
  onJoined,
  onSignedIn,
}: {
  token: string;
  inviteEmail: string;
  onJoined: () => void;
  onSignedIn: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const outcome = await joinWithPasskey(
        {
          token,
          email: inviteEmail,
          ...(name.trim() ? { name: name.trim() } : {}),
          returnTo: joinReturnTo(token, "passkey"),
        },
        JOIN_DEPS
      );
      await settle(outcome, {
        joined: onJoined,
        signedIn: onSignedIn,
        error: setError,
      });
    } catch {
      setError(JOIN_UNREACHABLE);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      {error ? <ErrorBanner message={error} /> : null}
      <Input
        label="Email"
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
        type="text"
        placeholder="Jane Smith"
        value={name}
        onValueChange={setName}
        autoComplete="name"
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
        startContent={submitting ? null : <KeyRound className="h-4 w-4" />}
      >
        {resolveSignInWayLabel("passkey", "action")}
      </Button>
    </form>
  );
}

function CloudPanel({
  token,
  preview,
  onSignedIn,
}: {
  token: string;
  preview: OpenInvite;
  onSignedIn: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const go = async () => {
    setError(null);
    setLeaving(true);
    rememberCloudJoin(token, preview);
    try {
      const outcome = await joinWithSynapCloud(
        { token, returnTo: joinReturnTo(token, "synap_cloud") },
        JOIN_DEPS
      );
      await settle(outcome, {
        joined: () => undefined,
        signedIn: onSignedIn,
        error: setError,
      });
      // The browser is leaving for Synap Cloud: keep the button busy.
      if (outcome.kind !== "redirect") setLeaving(false);
    } catch {
      setError(JOIN_UNREACHABLE);
      setLeaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBanner message={error} /> : null}
      <p className="text-[13px] leading-relaxed text-foreground/70">
        Use the Synap Cloud account for{" "}
        <span className="font-medium text-foreground/85">{preview.email}</span>.
      </p>
      <Button
        color="primary"
        radius="md"
        size="md"
        isLoading={leaving}
        onPress={() => void go()}
      >
        {resolveSignInWayLabel("synap_cloud", "action")}
      </Button>
    </div>
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
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      {error ? <ErrorBanner message={error} /> : null}
      <Input
        label="Email"
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
        {submitting
          ? "Creating account…"
          : resolveSignInWayLabel("password", "action")}
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
      <div className="h-24 rounded-md bg-foreground/[0.04] shimmer-pulse" />
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      {error || acceptError ? (
        <ErrorBanner message={error ?? acceptError!} />
      ) : null}
      <Input
        label="Email"
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

/** How the person signs in next time, said on the Done screen. */
const SIGN_IN_WITH: Record<SignInWay, string> = {
  passkey: "with your passkey",
  password: "with this pod's password",
  synap_cloud: "with Synap Cloud",
};

/**
 * Joined. What a client has leads (`joinedDoors`): this pod's console home,
 * then the company's own apps when the reader may list them, then the phone.
 * The desktop app is not offered: it is the operator's workbench, not part of
 * a client's offer (decision 7c832a88). Focus moves to the headline so a
 * screen reader hears the outcome.
 */
function DoneBody({
  subject,
  email,
  signedIn,
  way,
}: {
  subject: InviteSubject;
  email: string;
  signedIn: boolean;
  way?: SignInWay;
}) {
  const t = inviteT();
  const onPhone = useIsPhone();
  const host = podApiHost();
  /* The company's apps, when this reader may list them (a pod admin). A
     member is refused (FORBIDDEN): that is the answer "not yours to list",
     not a failure. Any other failure says so, with Try again. */
  const apps = trpc.apps.adminPodApps.useQuery(undefined, {
    enabled: signedIn,
    retry: false,
    staleTime: 60_000,
  });
  const appsCode = apps.error?.data?.code;
  const appsFailed =
    apps.isError && appsCode !== "FORBIDDEN" && appsCode !== "UNAUTHORIZED";
  const doors = joinedDoors({
    podUrl: POD_URL,
    email,
    signedIn,
    onPhone,
    apps: apps.data ?? [],
  });
  const appDoors = doors.filter(
    (d): d is Extract<JoinedDoor, { kind: "app" }> => d.kind === "app"
  );
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
          Sign in to {host ?? "this pod"} as{" "}
          <span className="font-medium text-foreground/85">{email}</span>
          {way ? ` ${SIGN_IN_WITH[way]}` : ""}.
        </p>
      </div>
      {way === "synap_cloud" ? <LinkCloudStep /> : null}
      {doors.map((door) =>
        door.kind === "console" ? (
          <Button
            key="console"
            as="a"
            href={door.href}
            color="primary"
            radius="md"
            size="md"
            className="self-start"
          >
            {door.signIn ? t("done.signIn") : t("done.home")}
          </Button>
        ) : null
      )}
      {appDoors.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[12.5px] font-medium text-foreground/75">
            {t("done.apps")}
          </p>
          <ul className="flex flex-col gap-1">
            {appDoors.map((door) => (
              <li key={door.href}>
                <a
                  href={door.href}
                  {...externalProps(door.href)}
                  className="inline-flex min-h-10 items-center text-[13px] text-primary underline-offset-2 hover:underline"
                >
                  {door.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {appsFailed ? (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <p className="text-[12.5px] text-foreground/70">
            {t("done.appsFailed")}
          </p>
          <Button
            size="sm"
            variant="flat"
            radius="md"
            isLoading={apps.isFetching}
            onPress={() => void apps.refetch()}
          >
            {t("done.appsRetry")}
          </Button>
        </div>
      ) : null}
      {way === "synap_cloud" ? <AddPasskeyInvite /> : null}
      {doors.map((door) =>
        door.kind === "phone" ? (
          <div key="phone" className="flex flex-col gap-1">
            <p className="text-[12.5px] text-foreground/65">
              {t("done.phoneHint")}
            </p>
            <ExitLink
              exit={door.exit}
              label={
                door.opens === "app" ? t("done.phoneOpen") : t("done.phoneGet")
              }
            />
          </div>
        ) : null
      )}
      {POD_URL ? <PodAddress origin={new URL(POD_URL).origin} /> : null}
    </>
  );
}

/**
 * The end of a Synap Cloud join (decision 2, 2026-10-23): Synap Cloud records
 * this pod among the person's pods only through the identity-link door, so
 * the Done screen leads with it. `/link-cloud` runs the CP's claim-access
 * hop; Synap Cloud asks once, then brings the person back.
 */
function LinkCloudStep() {
  const cloud = resolveSignInWayLabel("synap_cloud");
  return (
    <div className="flex flex-col items-start gap-2 rounded-medium p-3 ring-1 ring-inset ring-primary/30">
      <p className="flex items-start gap-2 text-[13px] leading-relaxed text-foreground/75">
        <Cloud aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        Last step: link your {cloud} account, so this pod shows in it.
      </p>
      <Button
        as="a"
        href="/link-cloud"
        size="sm"
        radius="md"
        color="primary"
        variant="flat"
      >
        Link {cloud}
      </Button>
    </div>
  );
}

/**
 * An INVITE, never a requirement: a person who joined with Synap Cloud only
 * has no way into this pod without it (and cannot confirm a sensitive change
 * with it, B1 step-up). Settings › Security › Passkeys makes one.
 */
function AddPasskeyInvite() {
  return (
    <div className="flex flex-col items-start gap-2 rounded-medium p-3 ring-1 ring-inset ring-foreground/10">
      <p className="flex items-start gap-2 text-[13px] leading-relaxed text-foreground/75">
        <KeyRound aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        Add a passkey to this pod, so you can sign in here without Synap Cloud.
      </p>
      <Button
        as="a"
        href="/settings/security#passkeys"
        size="sm"
        radius="md"
        variant="flat"
      >
        Add a passkey to this pod
      </Button>
    </div>
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
