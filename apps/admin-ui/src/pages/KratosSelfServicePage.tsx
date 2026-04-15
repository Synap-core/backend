/**
 * /admin/kratos — Ory Kratos self-service UI (login, registration, recovery, …)
 *
 * Kratos browser flows redirect here with ?flow=<id>. The Data Pod admin SPA
 * is served from the API origin; this page must work without the separate
 * synap-app (localhost:3000) that older kratos.yml templates referenced.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input } from "@heroui/react";
import { IconAlertCircle } from "@tabler/icons-react";
import { API_URL } from "../lib/trpc";

type UiNode = {
  type: string;
  group?: string;
  messages?: { type: string; text: string }[];
  attributes?: Record<string, string | boolean | number | undefined>;
};

type KratosUi = {
  action: string;
  method: string;
  nodes: UiNode[];
};

type KratosFlow = {
  id: string;
  type?: string;
  ui: KratosUi;
  return_to?: string;
};

const FLOW_KINDS = [
  "login",
  "registration",
  "recovery",
  "verification",
  "settings",
] as const;

function kratosPublicPrefix(): string {
  const base = API_URL.replace(/\/$/, "");
  return `${base}/.ory/kratos/public`;
}

/** Rewrite Kratos action URL to hit the API proxy origin (dev: VITE_API_URL). */
function resolveActionUrl(action: string): string {
  const base = API_URL.replace(/\/$/, "");
  if (!base) {
    try {
      const u = new URL(action);
      return `${window.location.origin}${u.pathname}${u.search}`;
    } catch {
      return action;
    }
  }
  try {
    const u = new URL(action);
    const api = new URL(base);
    return `${api.origin}${u.pathname}${u.search}`;
  } catch {
    return action;
  }
}

async function fetchFlowById(flowId: string): Promise<KratosFlow> {
  const prefix = kratosPublicPrefix();
  let lastErr: string | null = null;
  for (const kind of FLOW_KINDS) {
    const res = await fetch(
      `${prefix}/self-service/${kind}/flows?id=${encodeURIComponent(flowId)}`,
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      }
    );
    if (res.ok) {
      return (await res.json()) as KratosFlow;
    }
    lastErr = await res.text().catch(() => res.statusText);
  }
  throw new Error(lastErr ?? "Could not load this sign-in link.");
}

export default function KratosSelfServicePage() {
  const flowId = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    return sp.get("flow");
  }, []);

  const [flow, setFlow] = useState<KratosFlow | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!flowId) {
      setError("Missing ?flow=… parameter from the identity server.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const f = await fetchFlowById(flowId);
        if (cancelled) return;
        setFlow(f);
        const initial: Record<string, string> = {};
        for (const n of f.ui.nodes) {
          const name = n.attributes?.name;
          if (n.type === "input" && typeof name === "string") {
            const v = n.attributes?.value;
            if (typeof v === "string" && v) initial[name] = v;
          }
        }
        setValues(initial);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load flow");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flowId]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!flow) return;
      setSubmitting(true);
      setError(null);
      try {
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(values)) {
          body[k] = v;
        }
        const action = resolveActionUrl(flow.ui.action);
        const res = await fetch(action, {
          method: (flow.ui.method || "POST").toUpperCase(),
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          redirect: "manual",
          body: JSON.stringify(body),
        });

        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("Location");
          if (loc) {
            window.location.assign(loc);
            return;
          }
        }

        const data = (await res.json().catch(() => null)) as
          | KratosFlow
          | { session?: unknown }
          | null;

        if (res.ok && data && "session" in data && data.session) {
          window.location.assign(
            flow.return_to || `${window.location.origin}/admin/`
          );
          return;
        }

        if (data && "ui" in data && data.ui?.nodes) {
          const next = data as KratosFlow;
          setFlow(next);
          setValues((prev) => {
            const nextVals = { ...prev };
            for (const n of next.ui.nodes) {
              const nm = n.attributes?.name;
              if (
                typeof nm === "string" &&
                n.attributes?.type === "hidden" &&
                typeof n.attributes?.value === "string"
              ) {
                nextVals[nm] = n.attributes.value;
              }
            }
            return nextVals;
          });
          const msgs = next.ui.nodes
            .flatMap((n) => n.messages ?? [])
            .filter((m) => m.type === "error")
            .map((m) => m.text);
          setError(
            msgs.length ? msgs.join(" ") : "Check the form and try again."
          );
          return;
        }

        setError(`Request failed (${res.status})`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Submit failed");
      } finally {
        setSubmitting(false);
      }
    },
    [flow, values]
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
  const title =
    flow.type === "registration"
      ? "Create account"
      : flow.type === "recovery"
        ? "Account recovery"
        : flow.type === "settings"
          ? "Account settings"
          : "Sign in";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <form
        className="w-full max-w-md rounded-2xl border border-divider bg-content1 p-6 shadow-xl"
        onSubmit={onSubmit}
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
            if (type === "submit") {
              return null;
            }
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
                    setValues((prev) => ({
                      ...prev,
                      [name]: ev.target.value,
                    }))
                  }
                  autoComplete={
                    name === "password"
                      ? "current-password"
                      : name === "traits.email"
                        ? "email"
                        : undefined
                  }
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
