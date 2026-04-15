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

// ─── Allowed deeplink prefixes ────────────────────────────────────────────────
const ALLOWED_REDIRECT_PREFIXES = [
  "raycast://extensions/synap-core/synap/",
  "synap://", // future: desktop app deeplinks
];

function isAllowedRedirectUri(uri: string): boolean {
  return ALLOWED_REDIRECT_PREFIXES.some((prefix) => uri.startsWith(prefix));
}

function buildDeeplink(
  redirectUri: string,
  apiKey: string,
  podUrl: string,
  workspaceId: string | null
): string {
  const context = JSON.stringify({ apiKey, podUrl, workspaceId });
  return `${redirectUri}?context=${encodeURIComponent(context)}`;
}

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
  const [copied, setCopied] = useState(false);

  const connectMutation = (trpc as any).apiKeys.connectIntegration.useMutation({
    onSuccess: (data) => {
      setApiKey(data.apiKey);
      setPodUrl(data.podUrl);
      setWorkspaceId(data.workspaceId);

      if (redirectUri && isAllowedRedirectUri(redirectUri)) {
        setStep("redirecting");
        const deeplink = buildDeeplink(
          redirectUri,
          data.apiKey,
          data.podUrl,
          data.workspaceId
        );
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
      setStep("error");
      showErrorNotification({ message: err.message });
    },
  });

  const handleGenerate = useCallback(() => {
    setStep("generating");
    setError("");
    connectMutation.mutate({ integration });
  }, [integration, connectMutation]);

  // Validate redirect_uri on mount
  useEffect(() => {
    if (redirectUri && !isAllowedRedirectUri(redirectUri)) {
      setError(
        `Invalid redirect_uri: must start with one of ${ALLOWED_REDIRECT_PREFIXES.join(", ")}`
      );
      setStep("error");
    }
  }, [redirectUri]);

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
              <p className="text-small text-default-600">
                This will generate a Hub Protocol API key scoped for{" "}
                <strong>{integrationInfo.label}</strong> and{" "}
                {redirectUri
                  ? "send it directly to the app — no copy-paste needed."
                  : "display it here for you to copy."}
              </p>
              {redirectUri && (
                <div className="rounded-medium border border-divider bg-default-50 px-3 py-2 font-mono text-xs text-default-500 break-all">
                  {redirectUri}
                </div>
              )}
              <Button
                variant="primary"
                className="w-full"
                onPress={handleGenerate}
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
                </div>
              </div>
              <Button
                variant="outline"
                className="w-full"
                onPress={() => setStep("idle")}
              >
                Try again
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
