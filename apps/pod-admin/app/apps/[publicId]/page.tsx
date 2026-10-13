"use client";

/**
 * /apps/[public_id] — the detail page for ONE Application (App Connect v1).
 *
 * The row in "Connected" (`/my-connections`) opens here. This is where an
 * app's full identity lives: its stable `public_id` (the `client_id` its grant
 * carries) with copy, what it may touch (its grants, in the words every grant
 * surface uses), when it was created and last used, and its one danger door:
 * Revoke while it is live, Remove for good once it is revoked.
 *
 * Read + one action. Auth is the pod_admin middleware's self-service allowlist
 * (`/apps/*` in proxy.ts); the data comes from the same-origin proxy
 * (`/api/apps?publicId=…` → `apps.get`), which is self-scoped server-side, so a
 * public id that is not the caller's returns 404 rather than someone else's app.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Button, Card, CardBody, Chip, Spinner, addToast } from "@heroui/react";
import { ArrowLeft, Ban, Trash2 } from "lucide-react";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import { CopyButton } from "../../_lib/copy-button";
import { PageHeader } from "../../(admin)/components/page-header";
import { formatRelative } from "../../../lib/format";
import { chipColor, type AppDetailRow } from "../_lib/app-view";
import { appHolderAccess, appMode } from "@synap-core/types/apps/app-view";
import {
  resolveAppConnection,
  resolveAppEndConsequence,
  resolveConnectionAction,
} from "@synap-core/types/membrane";
import { summarizeAppConnectRequest } from "@synap-core/types/proposals/intent";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";

type LoadState = "loading" | "ready" | "missing" | "error";

/** The app's one danger act: Remove for good once revoked, Revoke before. */
type EndAct = "revoke" | "remove";

/** What ending this app does, from the ONE membrane sentence. */
function endConsequence(app: AppDetailRow, action: EndAct) {
  return resolveAppEndConsequence({
    state: resolveAppConnection(app).state,
    action,
    hasKey: (app.keys ?? []).some((k) => k.isActive && !k.revokedAt),
    hasReach: app.grants.length > 0,
  });
}

export default function AppDetailPage() {
  const params = useParams<{ publicId: string }>();
  const publicId = params?.publicId ?? "";
  const router = useRouter();

  const [app, setApp] = useState<AppDetailRow | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<EndAct | null>(null);
  const [ending, setEnding] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const res = await fetch(
        `/api/apps?publicId=${encodeURIComponent(publicId)}`,
        { cache: "no-store" }
      );
      if (res.status === 404) {
        setState("missing");
        return;
      }
      if (res.status === 401) {
        // Expired session — send to login and come straight back.
        window.location.assign(
          `/login?return=${encodeURIComponent(window.location.pathname)}`
        );
        return;
      }
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(b?.error ?? `Couldn't load this app (${res.status}).`);
        setState("error");
        return;
      }
      const b = (await res.json()) as { app?: AppDetailRow };
      if (!b.app) {
        setState("missing");
        return;
      }
      setApp(b.app);
      setState("ready");
    } catch {
      setError("Couldn't load this app. Try again.");
      setState("error");
    }
  }, [publicId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function doEnd(action: EndAct) {
    if (!app) return;
    const failed = `Couldn't ${resolveConnectionAction(action).label.toLowerCase()}`;
    setEnding(true);
    try {
      const res = await fetch("/api/apps", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicId: app.public_id, action }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        addToast({
          title: failed,
          description: b?.error ?? "Try again.",
          color: "danger",
        });
        return;
      }
      addToast({
        title: resolveConnectionAction(action).pastLabel,
        color: "default",
      });
      // Revoked: it now lives under "Revoked apps". Removed: it is gone.
      router.push("/my-connections");
    } catch {
      addToast({
        title: failed,
        description: "Network error.",
        color: "danger",
      });
    } finally {
      setEnding(false);
      setConfirming(null);
    }
  }

  return (
    <div className="mx-auto max-w-[900px] px-4 sm:px-6 py-10">
      <Button
        as={Link}
        href="/my-connections"
        variant="light"
        size="sm"
        className="-ml-2 min-h-10 text-foreground/65"
        startContent={<ArrowLeft size={15} />}
      >
        Connected
      </Button>

      {state === "loading" ? (
        <div className="mt-6 flex min-h-48 items-center justify-center">
          <Spinner label="Loading this app" />
        </div>
      ) : state === "missing" ? (
        <Notice
          title="This app isn't yours — or it no longer exists."
          body="Apps are shown only to the person who registered them. If you expected it here, check that you're signed in as the right account."
        />
      ) : state === "error" ? (
        <Notice
          title={error ?? "Couldn't load this app."}
          body=""
          onRetry={() => void load()}
        />
      ) : app ? (
        <AppDetail app={app} onEnd={setConfirming} ending={ending} />
      ) : null}

      <ConfirmModal
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && void doEnd(confirming)}
        title={`${resolveConnectionAction(confirming ?? "revoke").label} "${app?.name ?? "this app"}"?`}
        consequence={
          <p>
            {app ? endConsequence(app, confirming ?? "revoke").confirm : null}
          </p>
        }
        confirmLabel={resolveConnectionAction(confirming ?? "revoke").label}
        isPending={ending}
      />
    </div>
  );
}

function AppDetail({
  app,
  onEnd,
  ending,
}: {
  app: AppDetailRow;
  onEnd: (action: EndAct) => void;
  ending: boolean;
}) {
  const view = resolveAppConnection(app);
  const lines = appHolderAccess(app).lines;
  const revoked = view.state === "revoked";
  const endAct: EndAct = revoked ? "remove" : "revoke";
  const asked = app.pending_request
    ? summarizeAppConnectRequest({
        appName: app.name,
        requests: app.pending_request.requests,
      })
    : null;

  return (
    <div className="mt-6">
      <PageHeader
        title={<span className="break-words">{app.name}</span>}
        description={app.description}
        actions={
          <Chip
            size="sm"
            variant="flat"
            color={chipColor(view.tone)}
            className="shrink-0"
          >
            {view.label}
          </Chip>
        }
      />

      {view.state === "asking" && asked && app.pending_request ? (
        <section
          className="mb-6 rounded-lg border border-foreground/10 bg-content1 px-4 py-3"
          aria-labelledby="asks"
        >
          <h2 id="asks" className="text-sm font-medium text-foreground">
            Asks for
          </h2>
          <ul className="mt-2 flex flex-col gap-1">
            {asked.lines.map((l) => (
              <li
                key={l.workspaceId}
                className="text-[13px] text-foreground/80"
              >
                {l.text}
              </li>
            ))}
          </ul>
          <Button
            as={Link}
            href={`/proposal/${encodeURIComponent(app.pending_request.proposal_id)}`}
            color="primary"
            size="sm"
            className="mt-3 min-h-10"
          >
            {resolveConnectionAction("review").label}
          </Button>
        </section>
      ) : null}

      <Card shadow="none" className="border border-foreground/10 bg-content1">
        <CardBody className="gap-4 p-4">
          <div>
            <p className="text-xs font-medium text-foreground/50">
              {resolveObjectNoun("application")} id
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="break-all font-mono text-[12px] leading-5 text-foreground/75">
                {app.public_id}
              </span>
              <CopyButton text={app.public_id} label="Copy" size="sm" />
            </div>
            <p className="mt-1.5 text-[11.5px] text-foreground/45">
              This id is the <span className="font-mono">client_id</span> its
              access is granted to. Share it with the app, never with anyone
              else.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Access" value={appMode(app.mode)} />
            <Field
              label="Added"
              value={
                app.created_at ? formatRelative(app.created_at) : "Unknown"
              }
            />
            <Field
              label="Last used"
              value={
                app.last_used_at
                  ? formatRelative(app.last_used_at)
                  : "Never used"
              }
            />
            {revoked ? (
              <Field
                label="Revoked"
                value={app.revoked_at ? formatRelative(app.revoked_at) : "Yes"}
              />
            ) : null}
          </div>
        </CardBody>
      </Card>

      <section className="mt-6" aria-labelledby="reach">
        <h2 id="reach" className="mb-2 text-sm font-medium text-foreground">
          What it may touch
        </h2>
        {revoked ? (
          <p className="text-[12.5px] text-foreground/65">
            Access removed. Revoking an app revokes its key, so nothing it held
            works any more.
          </p>
        ) : lines.length === 0 ? (
          <p className="text-[12.5px] text-foreground/65">
            No access yet. The app has registered but nothing has been approved
            for it.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {lines.map((line, i) => (
              <li
                key={i}
                className="rounded-lg border border-foreground/10 bg-content1 px-4 py-3"
              >
                <p className="text-[13px] text-foreground/85">
                  {line.summary.what}
                </p>
                <p className="mt-1 text-[11.5px] text-foreground/55">
                  {line.summary.where.length > 0
                    ? line.summary.where.join(" · ")
                    : "Anywhere"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-8 border-t border-foreground/10 pt-5">
        <Button
          color="danger"
          variant="flat"
          size="sm"
          className="min-h-10"
          startContent={revoked ? <Trash2 size={14} /> : <Ban size={14} />}
          isLoading={ending}
          onPress={() => onEnd(endAct)}
        >
          {resolveConnectionAction(endAct).label}
        </Button>
        <p className="mt-2 max-w-2xl text-[11.5px] text-foreground/50">
          {endConsequence(app, endAct).note}
          {revoked ? null : <> It moves under &ldquo;Revoked apps&rdquo;.</>}
        </p>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-foreground/50">{label}</p>
      <p className="mt-1 text-[12.5px] text-foreground/75">{value}</p>
    </div>
  );
}

function Notice({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="mt-6 rounded-lg border border-foreground/10 px-4 py-5"
      role="alert"
    >
      <p className="text-sm text-foreground/85">{title}</p>
      {body ? (
        <p className="mt-1 max-w-2xl text-[12.5px] leading-5 text-foreground/55">
          {body}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-3">
        {onRetry ? (
          <Button
            size="sm"
            variant="flat"
            className="min-h-10"
            onPress={onRetry}
          >
            Retry
          </Button>
        ) : null}
        <Button
          as={Link}
          href="/my-connections"
          size="sm"
          variant="light"
          className="min-h-10"
        >
          Back to Connected
        </Button>
      </div>
    </div>
  );
}
