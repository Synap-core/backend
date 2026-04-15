/**
 * /admin/connect — Integration connect page
 *
 * Standalone page (no nav/sidebar) that generates a Hub Protocol API key
 * for a named integration and either:
 *   a) fires a deeplink (raycast://) automatically so the caller app receives
 *      the credentials without user copy-paste, OR
 *   b) shows the key once for manual copy-paste if no deeplink is provided.
 *
 * URL params:
 *   redirect_uri  — deeplink to fire after key creation (e.g. raycast://extensions/synap-core/synap/connect)
 *   integration   — "raycast" | "cli" | "openclaw" | "custom"  (default: "custom")
 *
 * Auth: Kratos session (same as rest of admin UI). User must be logged in.
 */

import { useState, useEffect, useCallback } from "react";
import { Button } from "@heroui/react";
import {
  IconCheck,
  IconCopy,
  IconAlertCircle,
  IconPlugConnected,
  IconX,
} from "@tabler/icons-react";
import { trpc } from "../lib/trpc";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../lib/notifications";
import {
  buildConnectDeeplink,
  buildFlowTraceUrl,
  extractFlowId,
  isAllowedConnectRedirectUri,
} from "@synap-core/external-connect-client";

// ─── Integration label map ───────────────────────────────────────────────────
const INTEGRATION_LABELS: Record<
  string,
  { label: string; description: string }
> = {
  raycast: {
    label: "Raycast",
    description: "Quick launcher and AI tools on macOS",
  },
  cli: { label: "Synap CLI", description: "Command-line and scripting access" },
  openclaw: {
    label: "OpenClaw",
    description: "AI agent with Hub Protocol + MCP tools",
  },
  custom: {
    label: "Custom integration",
    description: "Generic Hub Protocol access",
  },
};

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ConnectPage() {
  const params = new URLSearchParams(window.location.search);
  const redirectUri = params.get("redirect_uri") ?? "";
  const cpHandshakeToken = params.get("cp_handshake_token") ?? "";
  const integration = (params.get("integration") ?? "custom") as
    | "raycast"
    | "cli"
    | "openclaw"
    | "custom";

  const [step, setStep] = useState<
    "idle" | "generating" | "done" | "redirecting" | "error"
  >("idle");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [podUrl, setPodUrl] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isBootstrappingSession, setIsBootstrappingSession] = useState(false);
  const [sessionBootstrapped, setSessionBootstrapped] = useState(
    cpHandshakeToken.length === 0
  );
  const [strategy, setStrategy] = useState<"create_new" | "replace_existing">(
    "create_new"
  );
  const { data: allKeys } = trpc.apiKeys.list.useQuery();
  const integrationHub = `integration:${integration}`;
  const existingActiveIntegrationKeys = (allKeys ?? []).filter(
    (k) => k.isActive && k.hubId === integrationHub
  );

  const connectMutation = trpc.apiKeys.connectIntegration.useMutation({
    onSuccess: (data) => {
      // Use the current pod origin as canonical return URL for clients.
      // Server env PUBLIC_URL can drift in some deployments.
      const canonicalPodUrl = window.location.origin.replace(/\/$/, "");
      setApiKey(data.apiKey);
      setPodUrl(canonicalPodUrl);
      setWorkspaceId(data.workspaceId);
      setFlowId(data.registration?.flowId ?? null);

      if (redirectUri && isAllowedConnectRedirectUri(redirectUri)) {
        setStep("redirecting");
        const deeplink = buildConnectDeeplink(redirectUri, {
          apiKey: data.apiKey,
          podUrl: canonicalPodUrl,
          workspaceId: data.workspaceId,
        });
        // Small delay so the user sees the success state before the app switches
        setTimeout(() => {
          window.location.href = deeplink;
        }, 800);
      } else {
        setStep("done");
      }
    },
    onError: (err) => {
      setError(err.message);
      setFlowId(extractFlowId(err.message));
      setStep("error");
      showErrorNotification({ message: err.message });
    },
  });

  const handleGenerate = useCallback(() => {
    setStep("generating");
    setError("");
    setFlowId(null);
    connectMutation.mutate({ integration, strategy });
  }, [integration, strategy, connectMutation]);

  // Validate redirect_uri on mount
  useEffect(() => {
    if (redirectUri && !isAllowedConnectRedirectUri(redirectUri)) {
      setError(
        "Invalid redirect_uri: must be an approved integration deeplink"
      );
      setStep("error");
    }
  }, [redirectUri]);

  // If CP forwarded a handshake token, bootstrap a pod session first so
  // connectIntegration has a valid Kratos cookie in this pod origin.
  useEffect(() => {
    if (!cpHandshakeToken || sessionBootstrapped || isBootstrappingSession)
      return;
    let cancelled = false;
    setIsBootstrappingSession(true);
    setError("");

    void fetch("/api/handshake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token: cpHandshakeToken }),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Handshake failed (${res.status})`);
        }
        setSessionBootstrapped(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setStep("error");
        setError(
          err instanceof Error
            ? `Could not create pod session: ${err.message}`
            : "Could not create pod session"
        );
      })
      .finally(() => {
        if (!cancelled) setIsBootstrappingSession(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cpHandshakeToken, sessionBootstrapped, isBootstrappingSession]);

  function handleCopy() {
    if (!apiKey) return;
    void navigator.clipboard.writeText(apiKey).then(() => {
      setCopied(true);
      showSuccessNotification({ message: "Key copied to clipboard" });
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const integrationInfo =
    INTEGRATION_LABELS[integration] ?? INTEGRATION_LABELS.custom;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-2xl border border-divider bg-content1 shadow-xl">
        {/* Header */}
        <div className="border-b border-divider px-6 py-5">
          <div className="mb-1 flex items-center gap-2">
            <IconPlugConnected size={20} className="text-secondary" />
            <span className="text-xs font-semibold uppercase tracking-wide text-default-500">
              Data pod
            </span>
          </div>
          <h1 className="text-xl font-bold text-foreground">
            Connect {integrationInfo.label}
          </h1>
          <p className="mt-1 text-small text-default-500">
            {integrationInfo.description}
          </p>
        </div>

        <div className="px-6 py-5">
          {/* Idle — show generate button */}
          {step === "idle" && (
            <div className="flex flex-col gap-4">
              {isBootstrappingSession && (
                <div className="flex items-center gap-2 rounded-medium border border-divider bg-default-50 px-3 py-2 text-xs text-default-500">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-default-400 border-t-transparent" />
                  Verifying pod session…
                </div>
              )}
              <p className="text-small text-default-600">
                This will generate a Hub Protocol API key scoped for{" "}
                <strong>{integrationInfo.label}</strong> and{" "}
                {redirectUri
                  ? "send it directly to the app — no copy-paste needed."
                  : "display it here for you to copy."}
              </p>
              {existingActiveIntegrationKeys.length > 0 && (
                <div className="rounded-medium border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-800">
                  Found {existingActiveIntegrationKeys.length} active{" "}
                  {integrationInfo.label} key
                  {existingActiveIntegrationKeys.length > 1 ? "s" : ""} for your
                  account.
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={strategy === "create_new" ? "primary" : "outline"}
                  onPress={() => setStrategy("create_new")}
                >
                  Add new key
                </Button>
                <Button
                  variant={
                    strategy === "replace_existing" ? "primary" : "outline"
                  }
                  onPress={() => setStrategy("replace_existing")}
                >
                  Override existing
                </Button>
              </div>
              {redirectUri && (
                <div className="rounded-medium border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-800">
                  You must explicitly approve key creation below before any
                  credentials are issued.
                </div>
              )}
              {redirectUri && (
                <div className="rounded-medium border border-divider bg-default-50 px-3 py-2 font-mono text-xs text-default-500 break-all">
                  {redirectUri}
                </div>
              )}
              <Button
                variant="primary"
                className="w-full"
                onPress={handleGenerate}
                isDisabled={isBootstrappingSession || !sessionBootstrapped}
              >
                Generate &amp; connect
              </Button>
            </div>
          )}

          {/* Generating */}
          {step === "generating" && (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-small text-default-500">Generating key…</p>
            </div>
          )}

          {/* Redirecting to deeplink app */}
          {step === "redirecting" && (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success-100 text-success-600">
                <IconCheck size={24} />
              </div>
              <div>
                <p className="font-semibold text-foreground">Key created!</p>
                <p className="text-small text-default-500">
                  Opening {integrationInfo.label}…
                </p>
              </div>
            </div>
          )}

          {/* Done — show key for copy */}
          {step === "done" && apiKey && (
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-2 rounded-medium border border-warning-200 bg-warning-50 p-3 text-warning-800">
                <IconAlertCircle size={18} className="mt-0.5 shrink-0" />
                <div>
                  <p className="text-small font-semibold">Save this key</p>
                  <p className="text-xs opacity-90">
                    It will not be shown again.
                  </p>
                </div>
              </div>
              <pre className="overflow-x-auto rounded-medium border border-warning-200 bg-warning-50 p-3 font-mono text-xs text-warning-700 break-all whitespace-pre-wrap">
                {apiKey}
              </pre>
              <Button variant="outline" className="w-full" onPress={handleCopy}>
                <span className="inline-flex items-center gap-2">
                  {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  {copied ? "Copied!" : "Copy key"}
                </span>
              </Button>
              {podUrl && (
                <p className="text-xs text-default-400">
                  Pod: <code className="font-mono">{podUrl}</code>
                  {workspaceId && (
                    <>
                      {" · "}Workspace:{" "}
                      <code className="font-mono">{workspaceId}</code>
                    </>
                  )}
                </p>
              )}
            </div>
          )}

          {/* Error */}
          {step === "error" && (
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-2 rounded-medium border border-danger-200 bg-danger-50 p-3 text-danger-800">
                <IconX size={18} className="mt-0.5 shrink-0" />
                <div>
                  <p className="text-small font-semibold">Connection failed</p>
                  <p className="text-xs opacity-90">{error}</p>
                  {flowId && (
                    <p className="mt-1 font-mono text-[11px] opacity-80">
                      Flow ID: {flowId}
                    </p>
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                className="w-full"
                onPress={() => setStep("idle")}
              >
                Try again
              </Button>
              {flowId && (
                <Button
                  variant="tertiary"
                  className="w-full"
                  onPress={() => {
                    window.location.href = buildFlowTraceUrl(flowId);
                  }}
                >
                  Open flow trace
                </Button>
              )}
              <Button
                variant="ghost"
                className="w-full"
                onPress={() => {
                  window.location.href = "/pod-services";
                }}
              >
                Open pod monitoring
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
