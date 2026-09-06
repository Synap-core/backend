"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, CardBody, CardHeader, Spinner, addToast } from "@heroui/react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Plug,
  X,
} from "lucide-react";
import {
  buildConnectDeeplink,
  buildFlowTraceUrl,
  extractFlowId,
  isAllowedConnectRedirectUri,
  DEFAULT_CONNECT_REDIRECT_PREFIXES,
  type IntegrationKind,
} from "@synap-core/external-connect-client";
import { ReceiverShell } from "../_lib/receiver-shell";
import { trpc } from "../../lib/trpc";
import { publicPodUrl } from "../../lib/public-pod-url";

const POD_URL = publicPodUrl();

const INTEGRATION_INFO: Record<
  IntegrationKind,
  { label: string; description: string }
> = {
  raycast: {
    label: "Raycast",
    description: "Quick-launcher and AI tools on macOS",
  },
  cli: {
    label: "Synap CLI",
    description: "Command-line and scripting access",
  },
  openclaw: {
    label: "OpenClaw",
    description: "AI agent with Hub Protocol + MCP tools",
  },
  custom: {
    label: "Custom integration",
    description: "Generic Hub Protocol access",
  },
};

type Step =
  | { kind: "idle" }
  | { kind: "generating" }
  | { kind: "redirecting"; apiKey: string }
  | { kind: "done"; apiKey: string; podUrl: string; workspaceId: string | null }
  | { kind: "error"; message: string; flowId: string | null }
  | { kind: "issuer-assertion-failed"; detail: string };

interface ConnectFormProps {
  /** The pod this key would be minted on. Anchors the page against phishing. */
  podHost?: string;
  /** Who the reader is signed in as, when known. */
  identity?: string;
  integration: IntegrationKind;
  redirectUri: string;
  issuerAssertion: string;
  /** Agent signal. "claude-web" → CP-MCP consent-code path (no plaintext key). */
  agentType?: string | null;
  /** Extra https redirect prefixes the pod owner allowlisted (CP origin, etc.). */
  extraRedirectPrefixes?: string[];
}

export function ConnectForm({
  integration,
  redirectUri,
  issuerAssertion,
  agentType = null,
  extraRedirectPrefixes = [],
  podHost,
  identity,
}: ConnectFormProps) {
  // CP-MCP consent-code path: claude.ai → CP → this page. We record consent as a
  // one-time code and hand ONLY the code to the CP callback — the claude-web agent
  // key is minted server-to-server at redeem, never delivered through the browser.
  const isMcpConnect = agentType === "claude-web";

  const info = INTEGRATION_INFO[integration];
  const connectLabel = isMcpConnect ? "Claude" : info.label;
  const connectDescription = isMcpConnect
    ? "Let Claude (claude.ai) reach this pod's tools over MCP"
    : info.description;

  const hasRedirect = redirectUri.length > 0;
  // The claude-web callback is an https origin; extend the default allowlist with
  // the pod-owner-controlled https origins passed from the server (never mutate
  // the shared DEFAULT_CONNECT_REDIRECT_PREFIXES fork).
  const allowedPrefixes = [
    ...DEFAULT_CONNECT_REDIRECT_PREFIXES,
    ...extraRedirectPrefixes,
  ];
  const redirectIsAllowed =
    !hasRedirect || isAllowedConnectRedirectUri(redirectUri, allowedPrefixes);

  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [strategy, setStrategy] = useState<"create_new" | "replace_existing">(
    "create_new"
  );
  const [copied, setCopied] = useState(false);
  const [sessionReady, setSessionReady] = useState(
    issuerAssertion.length === 0
  );
  const [bootstrapping, setBootstrapping] = useState(false);

  // Validate redirect_uri early — fail fast so the operator doesn't
  // approve a key that we can't deliver.
  useEffect(() => {
    if (hasRedirect && !redirectIsAllowed) {
      setStep({
        kind: "error",
        message:
          `Invalid redirect_uri (${redirectUri}) — not in this pod's allowlist. ` +
          `Allowed prefixes: ${allowedPrefixes.join(", ")}. ` +
          `For a control-plane (CP-MCP) callback, set CONNECT_ALLOWED_HTTPS_ORIGINS ` +
          `on the pod-admin deployment to the CP origin and restart.`,
        flowId: null,
      });
    }
  }, [hasRedirect, redirectIsAllowed]);

  // An approved issuer may forward a one-shot assertion. Exchange it directly
  // with this Pod; the Pod resolves the issuer from the assertion itself.
  useEffect(() => {
    if (!issuerAssertion || sessionReady || bootstrapping) return;
    let cancelled = false;
    setBootstrapping(true);
    void fetch(`${POD_URL}/api/federation/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ assertion: issuerAssertion }),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          // ASSERTION_REPLAYED (409): the one-shot assertion was already
          // consumed (page reloaded, or it was exchanged before). This page
          // only renders behind a valid pod session (middleware), so a replay
          // is NON-FATAL — proceed and let the authenticated steps below surface
          // a real 401 if the session is actually gone. Hard-failing here just
          // strands a signed-in user on a stale link.
          if (res.status === 409 && text.includes("ASSERTION_REPLAYED")) {
            setSessionReady(true);
            return;
          }
          throw new Error(
            text || `Issuer assertion exchange failed (${res.status})`
          );
        }
        setSessionReady(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStep({
          kind: "issuer-assertion-failed",
          detail: err instanceof Error ? err.message : "unknown",
        });
      })
      .finally(() => {
        if (!cancelled) setBootstrapping(false);
      });
    return () => {
      cancelled = true;
    };
    // `bootstrapping` is intentionally NOT a dependency: including it made
    // setBootstrapping(true) re-run this effect, whose cleanup set cancelled=true
    // and orphaned the in-flight exchange — freezing the UI on "Verifying pod
    // session…" forever. The synchronous guard above still prevents a double-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issuerAssertion, sessionReady]);

  const existingActive = trpc.apiKeys.list.useQuery(undefined, {
    enabled: sessionReady,
  });
  const existingForIntegration = (existingActive.data ?? []).filter(
    (k) => k.isActive && k.hubId === `integration:${integration}`
  );

  const connectMutation = trpc.apiKeys.connectIntegration.useMutation({
    onSuccess: (data) => {
      // Use the server-returned podUrl (PUBLIC_URL) — not window.location.origin,
      // which would return the pod-admin subdomain instead of the API domain.
      const podUrl = data.podUrl.replace(/\/$/, "");

      if (hasRedirect && redirectIsAllowed) {
        setStep({ kind: "redirecting", apiKey: data.apiKey });
        const deeplink = buildConnectDeeplink(redirectUri, {
          apiKey: data.apiKey,
          podUrl,
          workspaceId: data.workspaceId ?? undefined,
        });
        // Short delay so the user sees the success state before the
        // browser switches to the deeplink target.
        window.setTimeout(() => {
          window.location.href = deeplink;
        }, 700);
        return;
      }

      setStep({
        kind: "done",
        apiKey: data.apiKey,
        podUrl,
        workspaceId: data.workspaceId,
      });
    },
    onError: (err) => {
      setStep({
        kind: "error",
        message: err.message,
        flowId: extractFlowId(err.message),
      });
      addToast({
        title: "Couldn't mint integration key",
        description: err.message,
        color: "danger",
      });
    },
  });

  // CP-MCP consent-code mint: records consent, returns a one-time code, and we
  // top-level-navigate to the CP callback with ONLY the code (never a key).
  const beginMcpConnectMutation = trpc.apiKeys.beginMcpConnect.useMutation({
    onSuccess: (data) => {
      if (!hasRedirect || !redirectIsAllowed) {
        setStep({
          kind: "error",
          message:
            "This MCP connection has no valid callback URL to return to. " +
            "Make sure the control plane is in the pod's CONNECT_ALLOWED_HTTPS_ORIGINS.",
          flowId: null,
        });
        return;
      }
      let target: string;
      try {
        const u = new URL(redirectUri);
        u.searchParams.set("code", data.code);
        target = u.toString();
      } catch {
        setStep({
          kind: "error",
          message: "Invalid redirect_uri.",
          flowId: null,
        });
        return;
      }
      setStep({ kind: "redirecting", apiKey: "" });
      window.setTimeout(() => {
        window.location.href = target;
      }, 500);
    },
    onError: (err) => {
      setStep({
        kind: "error",
        message: err.message,
        flowId: extractFlowId(err.message),
      });
      addToast({
        title: "Couldn't authorize MCP connection",
        description: err.message,
        color: "danger",
      });
    },
  });

  const handleGenerate = useCallback(() => {
    setStep({ kind: "generating" });
    if (isMcpConnect) {
      // Scopes are omitted — the redeem side defaults to the functional
      // claude-web MCP scope set (hub-protocol + mcp read/write).
      beginMcpConnectMutation.mutate({ agentType: "claude-web" });
      return;
    }
    connectMutation.mutate({ integration, strategy });
  }, [
    connectMutation,
    beginMcpConnectMutation,
    isMcpConnect,
    integration,
    strategy,
  ]);

  const handleCopy = useCallback(async () => {
    if (step.kind !== "done") return;
    try {
      await navigator.clipboard.writeText(step.apiKey);
      setCopied(true);
      addToast({ title: "Key copied to clipboard", color: "success" });
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      addToast({ title: "Couldn't copy — select manually", color: "danger" });
    }
  }, [step]);

  return (
    // `sm`: one decision — mint this key, or don't. There is no object to read.
    <ReceiverShell podHost={podHost} identity={identity} width="sm">
      <CardHeader className="flex flex-col items-start gap-3 px-7 pt-7 pb-0">
        <span
          aria-hidden
          className="
            flex h-11 w-11 items-center justify-center
            rounded-lg
            bg-primary/10 ring-1 ring-inset ring-primary/20
            text-primary
          "
        >
          <Plug className="h-5 w-5" strokeWidth={2} />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/65">
            Data pod
          </p>
          <h1 className="font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
            Connect {connectLabel}
          </h1>
          <p className="text-[13px] leading-relaxed text-foreground/65">
            {connectDescription}
          </p>
        </div>
      </CardHeader>

      <CardBody className="flex flex-col gap-5 px-7 pb-7 pt-5">
        {step.kind === "idle" && (
          <IdleStep
            integration={integration}
            label={connectLabel}
            description={connectDescription}
            isMcpConnect={isMcpConnect}
            redirectUri={hasRedirect ? redirectUri : null}
            redirectIsAllowed={redirectIsAllowed}
            existingCount={isMcpConnect ? 0 : existingForIntegration.length}
            strategy={strategy}
            onStrategy={setStrategy}
            onGenerate={handleGenerate}
            disabled={
              !sessionReady ||
              bootstrapping ||
              (hasRedirect && !redirectIsAllowed)
            }
            bootstrapping={bootstrapping}
          />
        )}

        {step.kind === "generating" && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Spinner size="md" color="primary" />
            <p className="text-[13px] text-foreground/65">
              Minting integration key…
            </p>
          </div>
        )}

        {step.kind === "redirecting" && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <span
              aria-hidden
              className="
                flex h-12 w-12 items-center justify-center
                rounded-full
                bg-success/10 ring-1 ring-inset ring-success/20
                text-success
              "
            >
              <Check className="h-6 w-6" strokeWidth={2.2} />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-[14px] font-medium text-foreground">
                Key created
              </p>
              <p className="text-[12.5px] text-foreground/65">
                Opening {connectLabel}…
              </p>
            </div>
          </div>
        )}

        {step.kind === "done" && (
          <DoneStep
            apiKey={step.apiKey}
            podUrl={step.podUrl}
            workspaceId={step.workspaceId}
            copied={copied}
            onCopy={handleCopy}
          />
        )}

        {step.kind === "error" && (
          <ErrorStep
            message={step.message}
            flowId={step.flowId}
            onRetry={() => setStep({ kind: "idle" })}
          />
        )}

        {step.kind === "issuer-assertion-failed" && (
          <IssuerAssertionFailedStep
            detail={step.detail}
            connectLabel={connectLabel}
            // The one-shot SSO assertion is stale (expired — they last 5
            // minutes — or already consumed). It is NON-FATAL: this page only
            // renders behind a valid pod session, so we let the operator
            // PROCEED with that session rather than reload the same dead
            // assertion (which just fails again — the retry loop).
            onProceed={() => {
              setStep({ kind: "idle" });
              setSessionReady(true);
            }}
            // Escape hatch for the rare genuine no-session case: manual login,
            // then middleware returns here.
            onSignIn={() => window.location.assign(window.location.href)}
          />
        )}
      </CardBody>
    </ReceiverShell>
  );
}

// ─── Step components ────────────────────────────────────────────────────────

interface IdleStepProps {
  integration: IntegrationKind;
  label: string;
  description: string;
  isMcpConnect: boolean;
  redirectUri: string | null;
  redirectIsAllowed: boolean;
  existingCount: number;
  strategy: "create_new" | "replace_existing";
  onStrategy: (s: "create_new" | "replace_existing") => void;
  onGenerate: () => void;
  disabled: boolean;
  bootstrapping: boolean;
}

function IdleStep({
  label,
  isMcpConnect,
  redirectUri,
  redirectIsAllowed,
  existingCount,
  strategy,
  onStrategy,
  onGenerate,
  disabled,
  bootstrapping,
}: IdleStepProps) {
  return (
    <div className="flex flex-col gap-4">
      {bootstrapping && (
        <InlineNotice
          tone="muted"
          icon={<Spinner size="sm" />}
          message="Verifying pod session…"
        />
      )}

      <p className="text-[13px] leading-relaxed text-foreground/65">
        {isMcpConnect ? (
          <>
            This authorizes{" "}
            <span className="font-medium text-foreground">{label}</span> to
            reach this pod over MCP. No key is shown or copied — it is delivered
            securely to the control plane.
          </>
        ) : (
          <>
            This mints a Hub Protocol API key scoped for{" "}
            <span className="font-medium text-foreground">{label}</span> and{" "}
            {redirectUri && redirectIsAllowed
              ? "delivers it directly to the integration — no copy-paste."
              : "shows it once here for you to copy."}
          </>
        )}
      </p>

      {existingCount > 0 && (
        <InlineNotice
          tone="warning"
          icon={<KeyRound className="h-3.5 w-3.5" />}
          message={`You already have ${existingCount} active ${label} key${existingCount > 1 ? "s" : ""}. Pick a strategy below.`}
        />
      )}

      {existingCount > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            radius="md"
            variant={strategy === "create_new" ? "solid" : "flat"}
            color={strategy === "create_new" ? "primary" : "default"}
            onPress={() => onStrategy("create_new")}
          >
            Add new key
          </Button>
          <Button
            size="sm"
            radius="md"
            variant={strategy === "replace_existing" ? "solid" : "flat"}
            color={strategy === "replace_existing" ? "primary" : "default"}
            onPress={() => onStrategy("replace_existing")}
          >
            Replace existing
          </Button>
        </div>
      )}

      {redirectUri && (
        <div
          className="
            rounded-lg
            bg-foreground/[0.03] ring-1 ring-inset ring-foreground/10
            px-3.5 py-2.5
          "
        >
          <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/45">
            Will deliver to
          </p>
          <p className="break-all font-mono text-[12px] text-foreground/85">
            {redirectUri}
          </p>
          {!redirectIsAllowed && (
            <p className="mt-2 text-[12px] text-danger">
              Not in the redirect allowlist — generation is disabled.
            </p>
          )}
        </div>
      )}

      <Button
        color="primary"
        radius="md"
        size="md"
        onPress={onGenerate}
        isDisabled={disabled}
        startContent={<KeyRound className="h-3.5 w-3.5" />}
        className="font-medium"
      >
        {isMcpConnect ? "Allow" : "Generate & connect"}
      </Button>
    </div>
  );
}

interface DoneStepProps {
  apiKey: string;
  podUrl: string;
  workspaceId: string | null;
  copied: boolean;
  onCopy: () => void;
}

function DoneStep({
  apiKey,
  podUrl,
  workspaceId,
  copied,
  onCopy,
}: DoneStepProps) {
  return (
    <div className="flex flex-col gap-4">
      <InlineNotice
        tone="warning"
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
        title="Save this key now"
        message="It is shown once and cannot be retrieved later."
      />

      <pre
        className="
          overflow-x-auto whitespace-pre-wrap break-all
          rounded-lg
          bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10
          px-3.5 py-3
          font-mono text-[12px] text-foreground
        "
      >
        {apiKey}
      </pre>

      <Button
        variant="flat"
        radius="md"
        size="md"
        onPress={onCopy}
        startContent={
          copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )
        }
      >
        {copied ? "Copied" : "Copy key"}
      </Button>

      <div className="flex flex-col gap-1 text-[12px] text-foreground/55">
        <p>
          <span className="text-foreground/40">Pod: </span>
          <code className="font-mono text-foreground/75">{podUrl}</code>
        </p>
        {workspaceId && (
          <p>
            <span className="text-foreground/40">Workspace: </span>
            <code className="font-mono text-foreground/75">{workspaceId}</code>
          </p>
        )}
      </div>
    </div>
  );
}

interface ErrorStepProps {
  message: string;
  flowId: string | null;
  onRetry: () => void;
}

function ErrorStep({ message, flowId, onRetry }: ErrorStepProps) {
  return (
    <div className="flex flex-col gap-4">
      <div
        className="
          flex items-start gap-2.5
          rounded-lg
          bg-danger/10 ring-1 ring-inset ring-danger/30
          px-3.5 py-3
        "
      >
        <X
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger"
          strokeWidth={2.2}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">
            Connection failed
          </p>
          <p className="mt-0.5 text-[12.5px] text-foreground/65">{message}</p>
          {flowId && (
            <p className="mt-1 font-mono text-[11px] text-foreground/45">
              Flow ID: {flowId}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Button
          color="primary"
          radius="md"
          size="md"
          onPress={onRetry}
          className="font-medium"
        >
          Try again
        </Button>
        {flowId && (
          <Button
            as="a"
            href={buildFlowTraceUrl(flowId)}
            variant="flat"
            radius="md"
            size="sm"
            endContent={<ExternalLink className="h-3 w-3" />}
          >
            Open flow trace
          </Button>
        )}
      </div>
    </div>
  );
}

interface IssuerAssertionFailedStepProps {
  detail: string;
  connectLabel: string;
  onProceed: () => void;
  onSignIn: () => void;
}

function IssuerAssertionFailedStep({
  detail,
  connectLabel,
  onProceed,
  onSignIn,
}: IssuerAssertionFailedStepProps) {
  // Classify the failure so the message names the real cause instead of a
  // generic "didn't work". Expiry (assertions live 5 min), replay (already
  // consumed), and stale-key signature failures all mean the SAME thing: the
  // one-shot link is spent — but the operator is already signed in here.
  const d = detail.toLowerCase();
  const isStaleLink =
    d.includes("expired") ||
    d.includes("replay") ||
    d.includes("signature") ||
    d.includes("assertion");

  return (
    <div className="flex flex-col gap-4">
      <div
        className="
          flex items-start gap-2.5
          rounded-lg
          bg-warning/10 ring-1 ring-inset ring-warning/30
          px-3.5 py-3
        "
      >
        <AlertCircle
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
          strokeWidth={2.2}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">
            {isStaleLink
              ? "This connection link expired"
              : "The sign-in link didn't work"}
          </p>
          <p className="mt-0.5 text-[12.5px] text-foreground/65">
            {isStaleLink ? (
              <>
                Connection links are valid for about 5 minutes. You&apos;re
                still signed in to this pod — continue to finish connecting{" "}
                {connectLabel}, or start again from {connectLabel} for a fresh
                link.
              </>
            ) : (
              <>Sign in manually to finish connecting {connectLabel}.</>
            )}
          </p>
          {detail && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11px] text-foreground/45 hover:text-foreground/65">
                Technical details
              </summary>
              <p className="mt-1 font-mono text-[11px] text-foreground/55">
                {detail}
              </p>
            </details>
          )}
        </div>
      </div>

      {isStaleLink ? (
        <div className="flex flex-col gap-2">
          <Button
            color="primary"
            radius="md"
            size="md"
            onPress={onProceed}
            className="font-medium"
          >
            Continue
          </Button>
          <Button variant="flat" radius="md" size="sm" onPress={onSignIn}>
            Sign in manually instead
          </Button>
        </div>
      ) : (
        <Button
          color="primary"
          radius="md"
          size="md"
          onPress={onSignIn}
          className="font-medium"
        >
          Sign in
        </Button>
      )}
    </div>
  );
}

// ─── Shared bits ────────────────────────────────────────────────────────────

interface InlineNoticeProps {
  tone: "muted" | "warning";
  icon: React.ReactNode;
  title?: string;
  message: string;
}

function InlineNotice({ tone, icon, title, message }: InlineNoticeProps) {
  const wrapperClass =
    tone === "warning"
      ? "bg-warning/10 ring-warning/30"
      : "bg-foreground/[0.03] ring-foreground/10";
  const iconWrapperClass =
    tone === "warning" ? "text-warning" : "text-foreground/55";
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg ring-1 ring-inset ${wrapperClass} px-3.5 py-2.5`}
    >
      <span className={`mt-0.5 shrink-0 ${iconWrapperClass}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        {title && (
          <p className="text-[12.5px] font-medium text-foreground">{title}</p>
        )}
        <p
          className={`text-[12.5px] ${title ? "text-foreground/65" : "text-foreground/85"}`}
        >
          {message}
        </p>
      </div>
    </div>
  );
}
