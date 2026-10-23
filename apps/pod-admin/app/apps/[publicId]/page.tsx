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
 *
 * A POD APP (spec 17 PB4 — it connected at the pod's sign-in door) is shown by
 * its domain and tier, and its page holds the connection's two settings: what
 * it may touch, per space, where the person can take a permission or a whole
 * space away (narrow: `PATCH /api/apps` → `apps.narrow`, no new consent), and
 * "Apply automatically" (`apps.setWriteMode`, off until the person turns it on
 * here — never at consent; turning it on is confirmed, `writeModeConfirm`).
 * A pod app's page carries none of App Connect's developer detail (the id to
 * share, the access mode): the person connected someone else's app.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Button,
  Card,
  CardBody,
  Checkbox,
  Chip,
  Spinner,
  Switch,
  addToast,
} from "@heroui/react";
import { ArrowLeft, Ban, Minus, Trash2 } from "lucide-react";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import { CopyButton } from "../../_lib/copy-button";
import { HostName } from "../../_lib/host-name";
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
import {
  approvalBySpace,
  keepWithout,
  podAppOf,
  podAppRevokeNote,
  tierLabel,
  writeModeConfirm,
  type PodAppInfo,
} from "../_lib/pod-app-view";

type LoadState = "loading" | "ready" | "missing" | "error";

/** The app's one danger act: Remove for good once revoked, Revoke before. */
type EndAct = "revoke" | "remove";

/** How a confirm names the app: a pod app by its domain, else its name. */
function appTitleText(app: AppDetailRow | null): string {
  if (!app) return "this app";
  const pod = podAppOf(app);
  return pod ? pod.domain : `"${app.name}"`;
}

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
          title="This app isn't yours, or it no longer exists."
          body="An app shows here only for the person who connected or registered it. If you expected it here, check that you're signed in as the right account."
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
          onEnd={setConfirming}
          ending={ending}
          onChanged={() => void load()}
        />
      ) : null}

      <ConfirmModal
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && void doEnd(confirming)}
        title={`${resolveConnectionAction(confirming ?? "revoke").label} ${appTitleText(app)}?`}
        consequence={
          <>
            <p>
              {app ? endConsequence(app, confirming ?? "revoke").confirm : null}
            </p>
            {app && confirming === "revoke" && podAppOf(app) ? (
              <p className="mt-2">{podAppRevokeNote(podAppOf(app)!.domain)}</p>
            ) : null}
          </>
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
  onChanged,
}: {
  app: AppDetailRow;
  onEnd: (action: EndAct) => void;
  ending: boolean;
  onChanged: () => void;
}) {
  const view = resolveAppConnection(app);
  const pod = podAppOf(app);
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
        title={
          pod ? (
            // A pod app is its DOMAIN; the name is only what it calls itself.
            <HostName host={pod.domain} />
          ) : (
            <span className="break-words">{app.name}</span>
          )
        }
        description={
          pod
            ? `Calls itself \u201c${app.name}\u201d · ${tierLabel(pod.verified)}`
            : app.description
        }
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
              <li key={l.workspaceId} className="text-sm text-foreground/80">
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
          {pod ? null : (
            <div>
              <p className="text-xs font-medium text-foreground/65">
                {resolveObjectNoun("application")} id
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-xs leading-5 text-foreground/75">
                  {app.public_id}
                </span>
                <CopyButton text={app.public_id} label="Copy" size="sm" />
              </div>
              <p className="mt-1.5 text-xs text-foreground/65">
                This id is the <span className="font-mono">client_id</span> its
                access is granted to. Share it with the app, never with anyone
                else.
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {pod ? null : (
              <>
                <Field label="Access" value={appMode(app.mode)} />
                <Field
                  label="Added"
                  value={
                    app.created_at ? formatRelative(app.created_at) : "Unknown"
                  }
                />
              </>
            )}
            {pod ? (
              <Field
                label="Connected"
                value={
                  pod.connected_at
                    ? formatRelative(pod.connected_at)
                    : "Unknown"
                }
              />
            ) : null}
            <Field
              label="Last used"
              value={
                (pod ? pod.last_used_at : app.last_used_at)
                  ? formatRelative((pod ? pod.last_used_at : app.last_used_at)!)
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

      {pod && !revoked ? (
        <PodAppSettings app={app} pod={pod} onChanged={onChanged} />
      ) : (
        <section className="mt-6" aria-labelledby="reach">
          <h2 id="reach" className="mb-2 text-sm font-medium text-foreground">
            What it may touch
          </h2>
          {revoked ? (
            <p className="text-xs text-foreground/65">
              Access removed. Revoking an app revokes its key, so nothing it
              held works any more.
            </p>
          ) : lines.length === 0 ? (
            <p className="text-xs text-foreground/65">
              No access yet. The app has registered but nothing has been
              approved for it.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {lines.map((line, i) => (
                <li
                  key={i}
                  className="rounded-lg border border-foreground/10 bg-content1 px-4 py-3"
                >
                  <p className="text-sm text-foreground/85">
                    {line.summary.what}
                  </p>
                  <p className="mt-1 text-xs text-foreground/65">
                    {line.summary.where.length > 0
                      ? line.summary.where.join(" · ")
                      : "Anywhere"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

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
        <p className="mt-2 max-w-2xl text-pretty text-xs text-foreground/65">
          {endConsequence(app, endAct).note}
          {revoked ? null : <> It moves under &ldquo;Revoked apps&rdquo;.</>}
          {pod && !revoked ? <> {podAppRevokeNote(pod.domain)}</> : null}
        </p>
      </div>
    </div>
  );
}

/** What `PATCH /api/apps` answers when it refuses. */
async function patchApp(
  body: Record<string, unknown>
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/apps", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (!res.ok) {
      return { ok: false, error: data?.error ?? `Failed (${res.status}).` };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

/** A pair (or a whole space) the person is about to take away. */
interface PendingDrop {
  permission?: string;
  workspaceId: string;
  /** "Create posts in Brand" / "everything in Brand". */
  what: string;
}

/**
 * A pod app's two settings: what it may touch per space (each can be taken
 * away; the last one is Revoke's) and how its changes land.
 */
function PodAppSettings({
  app,
  pod,
  onChanged,
}: {
  app: AppDetailRow;
  pod: PodAppInfo;
  onChanged: () => void;
}) {
  const [drop, setDrop] = useState<PendingDrop | null>(null);
  const [narrowing, setNarrowing] = useState(false);
  const [mode, setMode] = useState(pod.write_mode);
  const [switching, setSwitching] = useState(false);
  // "Apply automatically" ON waits here for its confirm (`writeModeConfirm`).
  const [confirmOn, setConfirmOn] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const onConfirm = writeModeConfirm(true, pod);
  const spaces = approvalBySpace(pod.approved);
  const keep = drop ? keepWithout(pod.approved, drop) : null;

  async function confirmDrop() {
    if (!keep) return;
    setNarrowing(true);
    const r = await patchApp({
      publicId: app.public_id,
      action: "narrow",
      approved: keep,
    });
    setNarrowing(false);
    setDrop(null);
    if (!r.ok) {
      addToast({
        title: "Couldn't change its access",
        description: r.error,
        color: "danger",
      });
      return;
    }
    addToast({ title: "Access narrowed", color: "default" });
    onChanged();
  }

  async function switchMode(on: boolean) {
    setSwitching(true);
    const r = await patchApp({
      publicId: app.public_id,
      action: "write-mode",
      applyAutomatically: on,
    });
    setSwitching(false);
    setConfirmOn(false);
    if (!r.ok) {
      addToast({
        title: "Couldn't change it",
        description: r.error,
        color: "danger",
      });
      return;
    }
    setMode(r.data as PodAppInfo["write_mode"]);
  }

  /** The switch's own change: OFF applies now, ON asks first. */
  function requestMode(on: boolean) {
    if (writeModeConfirm(on, pod) === null) {
      void switchMode(on);
      return;
    }
    setAcknowledged(false);
    setConfirmOn(true);
  }

  return (
    <>
      <section className="mt-6" aria-labelledby="pod-reach">
        <h2 id="pod-reach" className="mb-2 text-sm font-medium text-foreground">
          What it may touch
        </h2>
        <ul className="flex flex-col gap-3">
          {spaces.map((space) => (
            <li
              key={space.workspaceId}
              className="rounded-lg border border-foreground/10 bg-content1 px-4 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground/85">
                  {space.workspaceName}
                </p>
                {spaces.length > 1 ? (
                  <Button
                    size="sm"
                    variant="light"
                    className="min-h-10 text-foreground/70"
                    onPress={() =>
                      setDrop({
                        workspaceId: space.workspaceId,
                        what: `everything in ${space.workspaceName}`,
                      })
                    }
                  >
                    Remove this space
                  </Button>
                ) : null}
              </div>
              <ul className="mt-1 flex flex-col">
                {space.permissions.map((p) => {
                  const pair = {
                    permission: p.permission,
                    workspaceId: space.workspaceId,
                  };
                  const removable = keepWithout(pod.approved, pair) !== null;
                  return (
                    <li
                      key={p.permission}
                      className="flex min-h-10 items-center justify-between gap-3"
                    >
                      <span className="text-xs text-foreground/75">
                        {p.label}{" "}
                        <span className="font-mono text-xs text-foreground/65">
                          {p.permission}
                        </span>
                      </span>
                      {removable ? (
                        <Button
                          size="sm"
                          variant="light"
                          isIconOnly
                          className="min-h-10 min-w-10"
                          aria-label={`Remove ${p.label} in ${space.workspaceName}`}
                          onPress={() =>
                            setDrop({
                              ...pair,
                              what: `${p.label} in ${space.workspaceName}`,
                            })
                          }
                        >
                          <Minus size={15} />
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        <p className="mt-2 max-w-2xl text-pretty text-xs text-foreground/65">
          Taking something away applies now, with no new consent: the app&apos;s
          current access stops, and the next one it gets no longer includes it.
          To remove everything, revoke it.
        </p>
      </section>

      <section className="mt-6" aria-labelledby="pod-writes">
        <h2
          id="pod-writes"
          className="mb-2 text-sm font-medium text-foreground"
        >
          Its changes
        </h2>
        <div className="flex items-start justify-between gap-4 rounded-lg border border-foreground/10 bg-content1 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm text-foreground/85">Apply automatically</p>
            <p className="mt-1 text-pretty text-xs text-foreground/65">
              {mode.line}
            </p>
          </div>
          <Switch
            size="sm"
            isSelected={mode.applyAutomatically}
            isDisabled={switching}
            onValueChange={requestMode}
            aria-label="Apply this app's changes automatically"
          />
        </div>
      </section>

      <ConfirmModal
        isOpen={drop !== null}
        onClose={() => setDrop(null)}
        onConfirm={() => void confirmDrop()}
        title={`Remove ${drop?.what ?? "this"}?`}
        consequence={
          <p>
            {pod.domain} loses it now. Its current access stops; the next one it
            gets carries only what is left.
          </p>
        }
        confirmLabel="Remove"
        isPending={narrowing}
      />

      {onConfirm ? (
        <ConfirmModal
          isOpen={confirmOn}
          onClose={() => setConfirmOn(false)}
          onConfirm={() => void switchMode(true)}
          title={onConfirm.title}
          consequence={onConfirm.body.map((line, i) => (
            <p key={i} className={i > 0 ? "mt-2" : undefined}>
              {line}
            </p>
          ))}
          confirmLabel={onConfirm.confirmLabel}
          confirmColor={onConfirm.color}
          isConfirmDisabled={onConfirm.acknowledge !== null && !acknowledged}
          isPending={switching}
        >
          {onConfirm.acknowledge ? (
            <Checkbox
              size="sm"
              isSelected={acknowledged}
              onValueChange={setAcknowledged}
            >
              <span className="text-xs text-foreground/85">
                {onConfirm.acknowledge}
              </span>
            </Checkbox>
          ) : null}
        </ConfirmModal>
      ) : null}
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-foreground/65">{label}</p>
      <p className="mt-1 text-xs text-foreground/75">{value}</p>
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
        <p className="mt-1 max-w-2xl text-xs leading-5 text-foreground/65">
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
