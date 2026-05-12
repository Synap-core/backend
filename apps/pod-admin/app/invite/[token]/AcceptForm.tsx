"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, CardBody, Input, Tab, Tabs } from "@heroui/react";
import { AlertCircle, CheckCircle2, LogIn, UserPlus } from "lucide-react";
import {
  collectErrorMessages,
  createLoginFlow,
  extractInitialValues,
  FLOW_RESET_ERROR_IDS,
  mergeHiddenValues,
  submitLoginFlow,
  whoami,
  type KratosFlow,
  type KratosSession,
} from "../../../lib/kratos-flow";
import { trpc, POD_URL } from "../../../lib/trpc";

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
  | { status: "done" };

export function AcceptForm({ token }: { token: string }) {
  const [state, setState] = useState<PageState>({ status: "loading" });

  const previewQuery = trpc.workspaces.previewInvite.useQuery(
    { token },
    { retry: 1, staleTime: Infinity }
  );

  const acceptMutation = trpc.workspaces.acceptInvite.useMutation({
    onSuccess: () => {
      window.location.assign("/");
    },
  });

  const onLoginSuccess = useCallback(async () => {
    try {
      await acceptMutation.mutateAsync({ token });
    } catch {
      // error shown via acceptMutation.error
    }
  }, [acceptMutation, token]);

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
      <Shell>
        <LoadingBody />
      </Shell>
    );
  if (state.status === "error")
    return (
      <Shell>
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
      <Shell>
        <NotFoundBody />
      </Shell>
    );
  if (state.status === "expired")
    return (
      <Shell>
        <ExpiredBody />
      </Shell>
    );
  if (state.status === "done")
    return (
      <Shell>
        <DoneBody />
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
      <Shell>
        <WrongAccountBody inviteEmail={preview.email} />
      </Shell>
    );
  }

  // Logged-in + email matches → one-click accept
  if (session) {
    return (
      <Shell>
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
    <Shell>
      <InviteHeader preview={preview} />
      <Tabs
        aria-label="Accept options"
        variant="underlined"
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
            onSuccess={() => window.location.assign("/login?return=/")}
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
          <LoginPanel
            inviteEmail={preview.email}
            onSuccess={onLoginSuccess}
            acceptError={acceptMutation.error?.message ?? null}
            isAccepting={acceptMutation.isPending}
          />
        </Tab>
      </Tabs>
    </Shell>
  );
}

// ─── Register panel ──────────────────────────────────────────────────────────

function RegisterPanel({
  token,
  inviteEmail,
  onSuccess,
}: {
  token: string;
  inviteEmail: string;
  onSuccess: () => void;
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
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setError(data.error ?? `Failed (${res.status})`);
          return;
        }
        onSuccess();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Request failed");
      } finally {
        setSubmitting(false);
      }
    },
    [inviteEmail, password, name, token, onSuccess]
  );

  return (
    <form className="mt-4 flex flex-col gap-4" onSubmit={onSubmit}>
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
        classNames={{ input: "text-foreground/55" }}
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
  acceptError,
  isAccepting,
}: {
  inviteEmail: string;
  onSuccess: () => Promise<void>;
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
          void onSuccess();
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
  }, [inviteEmail, onSuccess]);

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
        classNames={{ input: "text-foreground/55" }}
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <Card
        radius="lg"
        shadow="none"
        className="w-full max-w-md bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10"
      >
        <CardBody className="flex flex-col gap-5 p-8">{children}</CardBody>
      </Card>
    </main>
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
      </div>
    </>
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
        <p className="text-[13.5px] text-foreground/55">{message}</p>
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
        <p className="text-[13.5px] text-foreground/55">
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
        <p className="text-[13.5px] text-foreground/55">
          This invite link has expired. Ask the pod admin to send a new one.
        </p>
      </div>
    </>
  );
}

function DoneBody() {
  return (
    <>
      <CheckCircle2 className="h-10 w-10 text-success" />
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-[20px] font-medium text-foreground">
          Invite accepted
        </h1>
        <p className="text-[13.5px] text-foreground/55">Redirecting…</p>
      </div>
    </>
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
        <p className="text-[13.5px] text-foreground/55">
          This invite is for{" "}
          <span className="font-medium text-foreground/85">{inviteEmail}</span>.
          Sign out and sign in with that account to accept it.
        </p>
      </div>
    </>
  );
}
