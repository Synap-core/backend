/**
 * /admin/kratos — Ory Kratos self-service UI (login, registration, recovery, …)
 *
 * Driven by one of two query params:
 *   ?flow=<id>   — render the existing flow (Kratos redirects here with this
 *                  when a legacy browser flow is active).
 *   ?kind=<kind> — create a new flow of the given kind and render it inline.
 *
 * When neither is present, defaults to creating a login flow. This lets
 * AuthProvider render <KratosSelfServicePage /> inline on 401 without any
 * full-page redirect through Kratos's /browser endpoint.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input } from "@heroui/react";
import { IconAlertCircle } from "@tabler/icons-react";
import {
  collectErrorMessages,
  createFlow,
  extractInitialValues,
  fetchFlowById,
  submitFlow,
  FLOW_RESET_ERROR_IDS,
  type FlowKind,
  type KratosFlow,
  type KratosSession,
  FLOW_KINDS,
} from "../lib/kratos";

function isFlowKind(value: string | null): value is FlowKind {
  return value !== null && (FLOW_KINDS as string[]).includes(value);
}

interface KratosSelfServicePageProps {
  /** Override query-param driven kind — used when rendering inline (e.g. AuthProvider). */
  initialKind?: FlowKind;
  /** Called when a session is established. Defaults to reloading the page. */
  onSuccess?: (session: KratosSession) => void;
}

export default function KratosSelfServicePage({
  initialKind,
  onSuccess,
}: KratosSelfServicePageProps = {}) {
  const { flowId, kind } = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    const rawKind = sp.get("kind");
    return {
      flowId: sp.get("flow"),
      kind: initialKind ?? (isFlowKind(rawKind) ? rawKind : "login"),
    };
  }, [initialKind]);

  const [flow, setFlow] = useState<KratosFlow | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  // Load (or create) the flow on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        let loaded: KratosFlow;
        if (flowId) {
          loaded = await fetchFlowById(flowId);
        } else {
          const { flow: created, existingSession } = await createFlow(kind);
          if (existingSession) {
            if (!cancelled) {
              (onSuccess ?? defaultOnSuccess)(existingSession);
            }
            return;
          }
          if (!created) {
            throw new Error("Kratos returned no flow");
          }
          loaded = created;
        }
        if (cancelled) return;
        setFlow(loaded);
        setValues(extractInitialValues(loaded));
      } catch (err) {
        if (!cancelled) {
          // Enhanced error handling with specific messages
          const errMsg =
            err instanceof Error ? err.message : "Failed to load auth flow";

          // Provide more helpful error messages based on common issues
          let displayError = errMsg;
          if (errMsg.includes("flow_expired") || errMsg.includes("expired")) {
            displayError = "Your session has expired. Please try again.";
          } else if (
            errMsg.includes("flow_not_found") ||
            errMsg.includes("404")
          ) {
            displayError = "Authentication flow not found. Please try again.";
          } else if (
            errMsg.includes("service_unavailable") ||
            errMsg.includes("503")
          ) {
            displayError =
              "Authentication service is temporarily unavailable. Please try again later.";
          } else if (errMsg.includes("400")) {
            displayError =
              "Unable to start authentication. Please refresh and try again.";
          }

          setError(displayError);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flowId, kind, onSuccess]);

  const onSubmitForm = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!flow) return;
      setSubmitting(true);
      setError(null);
      try {
        const {
          flow: nextFlow,
          session,
          structuralError,
        } = await submitFlow(flow, values);
        if (session) {
          (onSuccess ?? defaultOnSuccess)(session);
          return;
        }
        if (nextFlow) {
          setFlow(nextFlow);
          setValues((prev) => mergeHiddenValues(prev, nextFlow));
          const msgs = collectErrorMessages(nextFlow);
          setError(
            msgs.length ? msgs.join(" ") : "Check the form and try again."
          );
          return;
        }
        if (structuralError) {
          // Kratos rejected with a structural error (no flow body). For
          // unrecoverable ones (CSRF drift, expired flow) we transparently
          // recreate the flow and keep the user's entered credentials so they
          // can retry without friction.
          if (
            structuralError.id &&
            FLOW_RESET_ERROR_IDS.has(structuralError.id)
          ) {
            if (structuralError.id === "session_already_available") {
              // We're already logged in — reload to land authenticated.
              (onSuccess ?? defaultOnSuccess)({
                id: "existing",
                active: true,
                identity: { id: "existing" },
              } as KratosSession);
              return;
            }
            try {
              const { flow: fresh } = await createFlow(kind);
              if (fresh) {
                setFlow(fresh);
                setValues((prev) => mergeHiddenValues(prev, fresh));
                // Clear the error and show a clearer message
                setError("Please sign in again.");
                return;
              }
            } catch (createErr) {
              // More specific error handling for recreate failures
              const createErrMsg =
                createErr instanceof Error
                  ? createErr.message
                  : "Unknown error";

              if (createErrMsg.includes("session_already_available")) {
                // Should have been caught earlier, but handle it
                (onSuccess ?? defaultOnSuccess)({
                  id: "existing",
                  active: true,
                  identity: { id: "existing" },
                } as KratosSession);
                return;
              }

              // Pass through the recreate error
              setError(`Could not refresh session: ${createErrMsg}`);
              return;
            }
          }
          setError(
            structuralError.message ||
              structuralError.reason ||
              `Kratos error: ${structuralError.id ?? "unknown"}`
          );
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Submit failed");
      } finally {
        setSubmitting(false);
      }
    },
    [flow, values, kind, onSuccess]
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6 text-default-500">
        Loading…
      </div>
    );
  }

  if (error && !flow) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md rounded-2xl border border-danger-200 bg-danger-50 p-6 text-danger-900">
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <IconAlertCircle size={20} />
            Sign-in unavailable
          </div>
          <p className="text-sm opacity-90">{error}</p>
        </div>
      </div>
    );
  }

  if (!flow) return null;

  const nodes = flow.ui.nodes.filter((n) => n.type === "input");
  const title = flowTitle(flow.type ?? kind);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <form
        className="w-full max-w-md rounded-2xl border border-divider bg-content1 p-6 shadow-xl"
        onSubmit={onSubmitForm}
      >
        <h1 className="text-xl font-bold text-foreground">{title}</h1>
        <p className="mt-1 text-small text-default-500">
          Data Pod admin — session is stored for this site only.
        </p>

        {error ? (
          <div className="mt-4 rounded-medium border border-danger-200 bg-danger-50 p-3 text-sm text-danger-800">
            {error}
          </div>
        ) : null}

        <div className="mt-6 flex flex-col gap-4">
          {nodes.map((node, idx) => {
            const attrs = node.attributes ?? {};
            const name = attrs.name;
            if (typeof name !== "string") return null;
            const type = (attrs.type as string) || "text";
            const label =
              typeof attrs.label === "string"
                ? attrs.label
                : name
                    .replace(/_/g, " ")
                    .replace(/\b\w/g, (c) => c.toUpperCase());
            if (type === "hidden") {
              return (
                <input
                  key={`${name}-${idx}`}
                  type="hidden"
                  name={name}
                  value={values[name] ?? ""}
                  readOnly
                />
              );
            }
            if (type === "submit") return null;
            return (
              <div key={`${name}-${idx}`} className="flex flex-col gap-1">
                <label className="text-sm font-medium text-default-700">
                  {String(label)}
                  {attrs.required === true ? (
                    <span className="text-danger-500"> *</span>
                  ) : null}
                </label>
                <Input
                  className="border-default-200 bg-background text-foreground"
                  type={type === "password" ? "password" : "text"}
                  name={name}
                  value={values[name] ?? ""}
                  onChange={(ev) =>
                    setValues((prev) => ({ ...prev, [name]: ev.target.value }))
                  }
                  autoComplete={autoCompleteFor(name)}
                />
              </div>
            );
          })}
        </div>

        <Button
          type="submit"
          variant="primary"
          className="mt-6 w-full"
          isDisabled={submitting}
        >
          {submitting ? "Please wait…" : "Continue"}
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultOnSuccess(_session: KratosSession) {
  // Preserve the current URL path so the user lands where they were trying to go.
  const target = new URL(window.location.href);
  target.searchParams.delete("flow");
  target.searchParams.delete("kind");
  // A full reload re-runs AuthProvider's whoami which will now see the session.
  window.location.replace(target.toString());
}

function flowTitle(kind: FlowKind): string {
  switch (kind) {
    case "registration":
      return "Create account";
    case "recovery":
      return "Account recovery";
    case "settings":
      return "Account settings";
    case "verification":
      return "Verify your account";
    case "login":
    default:
      return "Sign in";
  }
}

function autoCompleteFor(name: string): string | undefined {
  if (name === "password") return "current-password";
  if (name === "traits.email" || name === "email") return "email";
  if (name === "traits.name" || name === "name") return "name";
  return undefined;
}

/**
 * After a flow refresh (validation error), the hidden CSRF token rotates.
 * Preserve user-entered values but pick up any new hidden defaults.
 */
function mergeHiddenValues(
  prev: Record<string, string>,
  nextFlow: KratosFlow
): Record<string, string> {
  const merged = { ...prev };
  for (const n of nextFlow.ui.nodes) {
    const name = n.attributes?.name;
    if (typeof name !== "string") continue;
    if (
      n.attributes?.type === "hidden" &&
      typeof n.attributes.value === "string"
    ) {
      merged[name] = n.attributes.value;
    }
  }
  return merged;
}
