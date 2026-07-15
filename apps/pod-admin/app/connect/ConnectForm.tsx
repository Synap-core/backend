"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Spinner,
  addToast,
} from "@heroui/react";
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
  type IntegrationKind,
} from "@synap-core/external-connect-client";
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
  integration: IntegrationKind;
  redirectUri: string;
  issuerAssertion: string;
}

export function ConnectForm({
  integration,
  redirectUri,
  issuerAssertion,
}: ConnectFormProps) {
  const info = INTEGRATION_INFO[integration];
  const hasRedirect = redirectUri.length > 0;
  const redirectIsAllowed =
    !hasRedirect || isAllowedConnectRedirectUri(redirectUri);

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
          "Invalid redirect_uri — must be a whitelisted integration deeplink (raycast://, synap://, or 127.0.0.1 loopback).",
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
  }, [issuerAssertion, sessionReady, bootstrapping]);

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

  const handleGenerate = useCallback(() => {
    setStep({ kind: "generating" });
    connectMutation.mutate({ integration, strategy });
  }, [connectMutation, integration, strategy]);

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
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <Card
        radius="lg"
        shadow="none"
        className="
          w-full max-w-md
          bg-foreground/[0.04]
          ring-1 ring-inset ring-foreground/10
        "
      >
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
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/45">
              Data pod
            </p>
            <h1 className="font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
              Connect {info.label}
            </h1>
            <p className="text-[13px] leading-relaxed text-foreground/65">
              {info.description}
            </p>
          </div>
        </CardHeader>

        <CardBody className="flex flex-col gap-5 px-7 pb-7 pt-5">
          {step.kind === "idle" && (
            <IdleStep
              integration={integration}
              redirectUri={hasRedirect ? redirectUri : null}
              redirectIsAllowed={redirectIsAllowed}
              existingCount={existingForIntegration.length}
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
                  Opening {info.label}…
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
              integrationLabel={info.label}
              onContinue={() => {
                // Operator will be bounced to /login by middleware if
                // they still have no session. After login, return=...
                // bring them right back to this URL with the same params.
                window.location.assign(window.location.href);
              }}
            />
          )}
        </CardBody>
      </Card>
    </main>
  );
}

// ─── Step components ────────────────────────────────────────────────────────

interface IdleStepProps {
  integration: IntegrationKind;
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
  integration,
  redirectUri,
  redirectIsAllowed,
  existingCount,
  strategy,
  onStrategy,
  onGenerate,
  disabled,
  bootstrapping,
}: IdleStepProps) {
  const info = INTEGRATION_INFO[integration];
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
        This mints a Hub Protocol API key scoped for{" "}
        <span className="font-medium text-foreground">{info.label}</span> and{" "}
        {redirectUri && redirectIsAllowed
          ? "delivers it directly to the integration — no copy-paste."
          : "shows it once here for you to copy."}
      </p>

      {existingCount > 0 && (
        <InlineNotice
          tone="warning"
          icon={<KeyRound className="h-3.5 w-3.5" />}
          message={`You already have ${existingCount} active ${info.label} key${existingCount > 1 ? "s" : ""}. Pick a strategy below.`}
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
        Generate &amp; connect
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
  integrationLabel: string;
  onContinue: () => void;
}

function IssuerAssertionFailedStep({
  detail,
  integrationLabel,
  onContinue,
}: IssuerAssertionFailedStepProps) {
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
            The sign-in link didn&apos;t work
          </p>
          <p className="mt-0.5 text-[12.5px] text-foreground/65">
            Sign in manually to finish connecting {integrationLabel}.
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

      <Button
        color="primary"
        radius="md"
        size="md"
        onPress={onContinue}
        className="font-medium"
      >
        Sign in
      </Button>
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
