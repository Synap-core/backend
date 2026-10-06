"use client";

/**
 * /apps/[public_id] — the detail page for ONE Application (App Connect v1).
 *
 * The row in "Connected" (`/my-connections`) opens here. This is where an
 * app's full identity lives: its stable `public_id` (the `client_id` its grant
 * carries) with copy, what it may touch (its grants, in the words every grant
 * surface uses), when it was created and last used, and the Revoke door.
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
import { ArrowLeft, Ban } from "lucide-react";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import { CopyButton } from "../../_lib/copy-button";
import { formatRelative } from "../../(admin)/trust-keys/_lib/format";
import { appMode, appState, grantLines, type AppRow } from "../_lib/app-view";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";

type LoadState = "loading" | "ready" | "missing" | "error";

export default function AppDetailPage() {
  const params = useParams<{ publicId: string }>();
  const publicId = params?.publicId ?? "";
  const router = useRouter();

  const [app, setApp] = useState<AppRow | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);

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
      const b = (await res.json()) as { app?: AppRow };
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

  async function doRevoke() {
    if (!app) return;
    setRevoking(true);
    try {
      const res = await fetch("/api/apps", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicId: app.public_id }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        addToast({
          title: "Couldn't revoke",
          description: b?.error ?? "Try again.",
          color: "danger",
        });
        return;
      }
      addToast({ title: "App revoked", color: "default" });
      // The revoked app now lives under "Revoked apps" on the list.
      router.push("/my-connections");
    } catch {
      addToast({
        title: "Couldn't revoke",
        description: "Network error.",
        color: "danger",
      });
    } finally {
      setRevoking(false);
      setConfirmRevoke(false);
    }
  }

  return (
    <div className="mx-auto max-w-[900px] px-6 py-10">
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
        <AppDetail
          app={app}
          onRevoke={() => setConfirmRevoke(true)}
          revoking={revoking}
        />
      ) : null}

      <ConfirmModal
        isOpen={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        onConfirm={() => void doRevoke()}
        title={`Revoke "${app?.name ?? "this app"}"?`}
        consequence={
          <>
            <p>This app loses access to this Pod and its key stops working.</p>
            <p className="mt-2 text-foreground/65">
              You can connect it again later — it will need a fresh approval.
            </p>
          </>
        }
        confirmLabel="Revoke app"
        isPending={revoking}
      />
    </div>
  );
}

function AppDetail({
  app,
  onRevoke,
  revoking,
}: {
  app: AppRow;
  onRevoke: () => void;
  revoking: boolean;
}) {
  const state = appState(app);
  const lines = grantLines(app);
  const revoked = Boolean(app.revoked_at);

  return (
    <div className="mt-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words font-heading text-[22px] font-medium tracking-tight text-foreground">
            {app.name}
          </h1>
          {app.description ? (
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-foreground/60">
              {app.description}
            </p>
          ) : null}
        </div>
        <Chip size="sm" variant="flat" color={state.color} className="shrink-0">
          {state.label}
        </Chip>
      </header>

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
                <p className="text-[13px] text-foreground/85">{line.what}</p>
                <p className="mt-1 text-[11.5px] text-foreground/55">
                  {line.where.length > 0 ? line.where.join(" · ") : "Anywhere"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!revoked ? (
        <div className="mt-8 border-t border-foreground/10 pt-5">
          <Button
            color="danger"
            variant="flat"
            size="sm"
            className="min-h-10"
            startContent={<Ban size={14} />}
            isLoading={revoking}
            onPress={onRevoke}
          >
            Revoke access
          </Button>
          <p className="mt-2 max-w-2xl text-[11.5px] text-foreground/50">
            Revoking cuts off this Pod immediately and stops the app&apos;s key
            from working. It does not delete the app from this list — it moves
            under &ldquo;Revoked apps&rdquo;.
          </p>
        </div>
      ) : null}
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
