"use client";

/**
 * /my-connections — self-service view of everything that reaches MY pod:
 * the Synap apps I am signed in to, Hub Protocol KEYS (CLI/agent) and
 * Applications (App Connect v1).
 *
 * Any signed-in pod member can already mint their own CLI/agent key at
 * `/connect`; `apiKeys.list` / `apiKeys.revoke` exist and are already
 * self-scoped to `ctx.userId` (a member sees and can only touch their own
 * keys). This page is the self-service counterpart to the admin-gated Trust &
 * Keys page. An APPLICATIONS section shows the apps the user owns — each app's
 * `public_id` is the `client_id` its grant carries, and its reach is the same
 * `summarizeGrant` model a key row renders.
 *
 * Each app row is a DOOR: the name links to `/apps/[public_id]`, where the
 * app's id, reach, dates and Revoke live. Revoked apps no longer vanish — they
 * sit in a "Revoked apps" disclosure (the read opts into them via
 * `apps.list { includeRevoked }`), mirroring the keys' own Revoked section.
 * Every list here is capped with a "Show all N".
 *
 * Badge derivation is shared with Keys — see `categorize()` in
 * `../(admin)/keys/_lib/key-model.ts` — so "what type of
 * connection is this" never drifts between the two surfaces.
 *
 * A POD APP (a website the person connected at the pod's sign-in door) is one
 * card under Applications, headlined by its domain. Its hourly access key is
 * NOT listed under the keys (`managedKeys`): revoking that key would not stop
 * the app (the next refresh mints another), so the app's Revoke is the one
 * control, and it stops the app everywhere.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Button, Card, CardBody, Chip, Spinner, addToast } from "@heroui/react";
import { Ban, ChevronDown, Plug, SquareCode } from "lucide-react";
import { PageHeader } from "../(admin)/components/page-header";
import { SignedInAppsSection } from "./_lib/signed-in-apps-section";
import { ConfirmModal } from "../(admin)/components/confirm-modal";
import { CopyButton } from "../_lib/copy-button";
import { HostName } from "../_lib/host-name";
import { trpc } from "../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../lib/auth-redirect";
import {
  categorize,
  CATEGORY_LABEL,
  holderName,
  keyStatus,
  managedKeys,
  type UnifiedKey,
} from "../(admin)/keys/_lib/key-model";
import { formatRelative } from "../../lib/format";
import {
  FULL_ACCESS_ACCESSIBLE_NAME,
  FULL_ACCESS_LABEL,
  resolveHolderAccess,
  type KeyAccess,
  type KeyAccessGrant,
} from "@synap-core/types/grants";
import { resolveObjectNounPlural } from "@synap-core/types/vocabulary";
import { appHolderAccess, appMode } from "@synap-core/types/apps/app-view";
import {
  resolveAppConnection,
  resolveAppEndConsequence,
  resolveConnectionAction,
} from "@synap-core/types/membrane";
import { chipColor, type AppRow } from "../apps/_lib/app-view";
import {
  approvalSentence,
  podAppOf,
  podAppRevokeNote,
  POD_APP_ACCESS_LINE,
  tierLabel,
} from "../apps/_lib/pod-app-view";

/** How many rows a list shows before it offers "Show all N" (ui-composition §4). */
const LIST_CAP = 6;

/** The command that registers an Application — the empty state's way out. */
const CONNECT_COMMAND = "synap app connect";

/**
 * A key as `apiKeys.list` returns it: `access` + every live grant. Both are on
 * the wire but not yet in the generated api-types, so they are typed here.
 */
type ConnectionKey = UnifiedKey & {
  access: KeyAccess;
  grants: KeyAccessGrant[];
};

/** Human label for a key's `hubId` — mirrors ConnectForm's integration list. */
function connectionLabel(hubId: string | null | undefined): string {
  if (!hubId) return "Personal access token";
  if (hubId === "integration:cli") return "Synap CLI";
  if (hubId === "integration:raycast") return "Raycast";
  // Keys minted before OpenClaw was unbundled (2026-10-14) still exist.
  if (hubId === "integration:openclaw") return "OpenClaw";
  if (hubId === "integration:custom") return "Custom integration";
  if (hubId.startsWith("integration:"))
    return hubId.slice("integration:".length);
  return hubId;
}

/**
 * A bounded list: show at most `cap`, then a "Show all N" that expands in
 * place. Keeps a detail surface from becoming an unbounded column without
 * hiding anything — an explicit "Show all" always names the real total.
 */
function Capped<T>({
  items,
  cap = LIST_CAP,
  children,
}: {
  items: T[];
  cap?: number;
  children: (item: T) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length <= cap) return <>{items.map(children)}</>;
  const shown = expanded ? items : items.slice(0, cap);
  return (
    <>
      {shown.map(children)}
      <Button
        variant="light"
        size="sm"
        className="min-h-10 self-start"
        onPress={() => setExpanded((v) => !v)}
      >
        {expanded ? "Show fewer" : `Show all ${items.length}`}
      </Button>
    </>
  );
}

/** A collapsed "Revoked" history — the shared shape for apps and for keys. */
function SectionDisclosure({
  id,
  label,
  count,
  open,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 py-1 text-left"
      >
        <span id={id} className="text-sm font-medium text-foreground/70">
          {label}
        </span>
        <span className="flex items-center gap-2 text-xs text-foreground/65">
          {count}
          <ChevronDown
            size={15}
            className={
              open ? "rotate-180 transition-transform" : "transition-transform"
            }
          />
        </span>
      </button>
      {open ? <div className="space-y-3">{children}</div> : null}
    </>
  );
}

export default function MyConnectionsPage() {
  const keys = trpc.apiKeys.list.useQuery();
  const utils = trpc.useUtils();
  const [showRevokedKeys, setShowRevokedKeys] = useState(false);
  const [showRevokedApps, setShowRevokedApps] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<UnifiedKey | null>(null);

  // Apps (App Connect v1) — fetched through the pod's tRPC door via a same-origin
  // proxy (`/api/apps`), because the browser cannot reach the pod tRPC origin
  // directly. Self-scoped server-side to this user. The read includes REVOKED
  // apps (see the route → `apps.list { includeRevoked }`) so they can show under
  // "Revoked apps" instead of vanishing.
  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [pendingRevokeApp, setPendingRevokeApp] = useState<AppRow | null>(null);
  const [revokingApp, setRevokingApp] = useState<string | null>(null);

  const loadApps = useCallback(async () => {
    setAppsError(null);
    try {
      const res = await fetch("/api/apps", { cache: "no-store" });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setAppsError(b?.error ?? `Couldn't load your apps (${res.status}).`);
        return;
      }
      const b = (await res.json()) as { apps?: AppRow[] };
      setApps(b.apps ?? []);
    } catch {
      setAppsError("Couldn't load your apps. Try again.");
    }
  }, []);

  useEffect(() => {
    void loadApps();
  }, [loadApps]);

  async function doRevokeApp(app: AppRow) {
    setRevokingApp(app.public_id);
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
      addToast({
        title: resolveConnectionAction("revoke").pastLabel,
        color: "default",
      });
      await loadApps();
    } catch {
      addToast({
        title: "Couldn't revoke",
        description: "Network error.",
        color: "danger",
      });
    } finally {
      setRevokingApp(null);
      setPendingRevokeApp(null);
    }
  }

  const revoke = trpc.apiKeys.revoke.useMutation({
    onSuccess: async (res) => {
      setPendingRevoke(null);
      await utils.apiKeys.list.invalidate();
      if ("proposalId" in res && res.proposalId) {
        addToast({
          title: "Approval required",
          description: "Revoke submitted as a proposal for review.",
          color: "default",
        });
      } else {
        addToast({ title: "Connection revoked", color: "default" });
      }
    },
    onError: (err) => {
      setPendingRevoke(null);
      addToast({
        title: "Couldn't revoke",
        description: err.message,
        color: "danger",
      });
    },
  });

  useEffect(() => {
    if (keys.isError) {
      redirectToLoginIfUnauthorized(keys.error);
    }
  }, [keys.isError, keys.error]);
  const isAuthRedirecting = keys.error?.data?.code === "UNAUTHORIZED";

  if (keys.isLoading || isAuthRedirecting) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner label="Loading your connections" />
      </div>
    );
  }
  if (keys.isError) {
    return (
      <div className="mx-auto max-w-[900px] px-4 sm:px-6 py-6" role="alert">
        <p className="text-sm text-danger">
          Couldn&apos;t load your connections. Try again.
        </p>
        <Button
          size="sm"
          variant="flat"
          className="mt-3 min-h-10"
          isLoading={keys.isFetching}
          onPress={() => void keys.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  // A pod app's own access key is the app's, shown on its card, not a key.
  const all = managedKeys((keys.data ?? []) as UnifiedKey[] as ConnectionKey[]);
  const active = all.filter((k) => k.isActive);
  const revoked = all.filter((k) => !k.isActive);

  const allApps = apps ?? [];
  const isRevoked = (a: AppRow) => resolveAppConnection(a).state === "revoked";
  const activeApps = allApps.filter((a) => !isRevoked(a));
  const revokedApps = allApps.filter(isRevoked);

  /* Was a native `window.confirm`. Same shared modal the admin surfaces use —
     revoking your own key is exactly as consequential as an admin revoking it,
     so it should not look like a cheaper decision. */
  function confirmRevoke(key: UnifiedKey) {
    setPendingRevoke(key);
  }

  return (
    <div className="mx-auto max-w-[900px] px-4 sm:px-6 py-10">
      <PageHeader
        title="Connected"
        description="Every Synap app you're signed in to, every app you connected or registered, and every key you made for this pod, with exactly what each may touch. Signing out or revoking here only affects you."
      />

      <SignedInAppsSection />

      <section className="mb-9 space-y-3" aria-labelledby="apps">
        <div className="flex items-center justify-between gap-3">
          <h2 id="apps" className="text-sm font-medium text-foreground">
            {resolveObjectNounPlural("application")}
          </h2>
          {apps ? (
            <span className="text-xs text-foreground/65">
              {activeApps.length}
            </span>
          ) : null}
        </div>

        {appsError ? (
          <div
            role="alert"
            className="rounded-lg border border-foreground/10 px-4 py-3"
          >
            <p className="text-xs text-danger">{appsError}</p>
            <Button
              size="sm"
              variant="flat"
              className="mt-2 min-h-10"
              onPress={() => void loadApps()}
            >
              Retry
            </Button>
          </div>
        ) : apps === null ? (
          <div className="flex items-center gap-3 px-1 py-3 text-sm text-foreground/65">
            <Spinner size="sm" /> Loading your apps
          </div>
        ) : activeApps.length === 0 ? (
          <AppEmptyState />
        ) : (
          <Capped items={activeApps}>
            {(app) => (
              <AppCard
                key={app.id}
                app={app}
                isRevoking={revokingApp === app.public_id}
                onRevoke={() => setPendingRevokeApp(app)}
              />
            )}
          </Capped>
        )}

        {revokedApps.length > 0 ? (
          <SectionDisclosure
            id="revoked-apps"
            label="Revoked apps"
            count={revokedApps.length}
            open={showRevokedApps}
            onToggle={() => setShowRevokedApps((v) => !v)}
          >
            <Capped items={revokedApps}>
              {(app) => <AppCard key={app.id} app={app} />}
            </Capped>
          </SectionDisclosure>
        ) : null}
      </section>

      <section className="space-y-3" aria-labelledby="active-connections">
        <div className="flex items-center justify-between gap-3">
          <h2
            id="active-connections"
            className="text-sm font-medium text-foreground"
          >
            Active
          </h2>
          <span className="text-xs text-foreground/65">{active.length}</span>
        </div>
        {active.length === 0 ? (
          <EmptyState />
        ) : (
          <Capped items={active}>
            {(key) => (
              <KeyCard
                key={key.id}
                apiKey={key}
                isRevoking={
                  revoke.isPending && revoke.variables?.keyId === key.id
                }
                onRevoke={() => confirmRevoke(key)}
              />
            )}
          </Capped>
        )}
      </section>

      {revoked.length > 0 ? (
        <section className="mt-9" aria-labelledby="revoked-connections">
          <SectionDisclosure
            id="revoked-connections"
            label="Revoked"
            count={revoked.length}
            open={showRevokedKeys}
            onToggle={() => setShowRevokedKeys((v) => !v)}
          >
            <Capped items={revoked}>
              {(key) => <KeyCard key={key.id} apiKey={key} />}
            </Capped>
          </SectionDisclosure>
        </section>
      ) : null}

      <ConfirmModal
        isOpen={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        /* Deliberately does NOT close here. Closing in onConfirm unmounted the
           modal before the mutation resolved, so `isPending` could never
           render and the user got no sign the click landed on a network
           round-trip — on the one action the modal exists to slow down. The
           mutation's own onSuccess/onError closes it. */
        onConfirm={() => {
          if (!pendingRevoke) return;
          revoke.mutate({ keyId: pendingRevoke.id });
        }}
        title={`Revoke "${pendingRevoke?.keyName ?? "this key"}"?`}
        consequence={
          <>
            <p>Anything using this key loses access to this pod.</p>
            <p className="mt-2 text-foreground/65">
              Depending on the key, revoking may need admin approval before it
              takes effect.
            </p>
          </>
        }
        confirmLabel="Revoke key"
        /* Scoped to THIS key: a shared `isPending` would spin this dialog
           while another key's revoke is still in flight. */
        isPending={
          revoke.isPending && revoke.variables?.keyId === pendingRevoke?.id
        }
      />

      <ConfirmModal
        isOpen={pendingRevokeApp !== null}
        onClose={() => setPendingRevokeApp(null)}
        onConfirm={() => {
          if (!pendingRevokeApp) return;
          void doRevokeApp(pendingRevokeApp);
        }}
        title={`${resolveConnectionAction("revoke").label} ${
          pendingRevokeApp
            ? (podAppOf(pendingRevokeApp)?.domain ??
              `"${pendingRevokeApp.name}"`)
            : "this app"
        }?`}
        consequence={
          <>
            <p>
              {pendingRevokeApp
                ? resolveAppEndConsequence({
                    state: resolveAppConnection(pendingRevokeApp).state,
                    action: "revoke",
                    hasReach: pendingRevokeApp.grants.length > 0,
                  }).confirm
                : null}
            </p>
            {pendingRevokeApp && podAppOf(pendingRevokeApp) ? (
              <p className="mt-2">
                {podAppRevokeNote(podAppOf(pendingRevokeApp)!.domain)}
              </p>
            ) : null}
          </>
        }
        confirmLabel={resolveConnectionAction("revoke").label}
        isPending={revokingApp === pendingRevokeApp?.public_id}
      />
    </div>
  );
}

function KeyCard({
  apiKey,
  isRevoking = false,
  onRevoke,
}: {
  apiKey: ConnectionKey;
  isRevoking?: boolean;
  onRevoke?: () => void;
}) {
  const category = categorize(apiKey);
  const holder = holderName(apiKey);
  // Honest STATUS (Active / Expiring soon / Expired / Revoked) — separate from
  // the TYPE badge, so an expired key never reads as a green "active" one.
  const status = keyStatus(apiKey);
  const statusColor =
    status.kind === "healthy"
      ? "success"
      : status.kind === "stale"
        ? "warning"
        : "default";
  const meta = [
    apiKey.createdAt ? `created ${formatRelative(apiKey.createdAt)}` : null,
    apiKey.lastUsedAt
      ? `last used ${formatRelative(apiKey.lastUsedAt)}`
      : "never used",
    apiKey.isActive
      ? apiKey.expiresAt
        ? `expires ${formatRelative(apiKey.expiresAt)}`
        : "no expiry"
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card shadow="none" className="border border-foreground/10 bg-content1">
      <CardBody className="gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{apiKey.keyName}</p>
            <p className="mt-1 text-xs text-foreground/65">
              {holder ? `${holder} · ` : null}
              {connectionLabel(apiKey.hubId)} ·{" "}
              <span className="font-mono">{apiKey.keyPrefix}…</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Chip size="sm" variant="flat" color="default">
              {CATEGORY_LABEL[category]}
            </Chip>
            <Chip size="sm" variant="dot" color={statusColor}>
              {status.label}
            </Chip>
          </div>
        </div>

        {apiKey.isActive ? <KeyAccessLine apiKey={apiKey} /> : null}
        <p className="text-xs text-foreground/65">{meta}</p>

        {onRevoke ? (
          <div className="pt-1">
            <Button
              color="danger"
              size="sm"
              className="min-h-10"
              variant="flat"
              startContent={<Ban size={14} />}
              isLoading={isRevoking}
              onPress={onRevoke}
            >
              Revoke
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** The key as every holder reads: the ONE sentence, and the red Full-access mark. */
function KeyAccessLine({ apiKey }: { apiKey: ConnectionKey }) {
  const access = resolveHolderAccess({
    kind: "key",
    name: apiKey.keyName,
    limits: { source: "grants", access: apiKey.access, grants: apiKey.grants },
    expiresAt: apiKey.expiresAt ?? null,
    revokedAt: apiKey.revokedAt ?? null,
  });
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-foreground/70">
      <span>{access.sentence}</span>
      {access.danger.full ? (
        <Chip
          size="sm"
          variant="flat"
          color="danger"
          aria-label={FULL_ACCESS_ACCESSIBLE_NAME}
        >
          {FULL_ACCESS_LABEL}
        </Chip>
      ) : null}
    </p>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-foreground/15 px-4 py-5">
      <div className="flex items-center gap-3 text-sm text-foreground/65">
        <Plug size={17} className="shrink-0" />
        You have no active keys yet.
      </div>
      {/* `/connect` mints a key for a tool (the CLI, Raycast); an app on a
          website connects from that website instead. */}
      <Button
        as="a"
        href="/connect"
        size="sm"
        variant="flat"
        className="min-h-10"
      >
        Connect a tool
      </Button>
    </div>
  );
}

/**
 * One app. The whole row is a DOOR to `/apps/[public_id]` — the name is the
 * real link (its accessible name), stretched over the card; Revoke is the one
 * control that stays above the overlay. A revoked app renders read-only.
 */
function AppCard({
  app,
  isRevoking = false,
  onRevoke,
}: {
  app: AppRow;
  isRevoking?: boolean;
  onRevoke?: () => void;
}) {
  const view = resolveAppConnection(app);
  // A pod app (it connected at the pod's sign-in door) is named by its
  // domain and tier, and its reach is what the person approved per space.
  const pod = podAppOf(app);
  const lastUsed = pod ? pod.last_used_at : app.last_used_at;
  const meta = [
    pod ? null : appMode(app.mode),
    pod
      ? pod.connected_at
        ? `connected ${formatRelative(pod.connected_at)}`
        : null
      : app.created_at
        ? `created ${formatRelative(app.created_at)}`
        : null,
    lastUsed ? `last used ${formatRelative(lastUsed)}` : "never used",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card
      shadow="none"
      // The whole card is the link (the title's `after:inset-0`): say so on hover.
      className="relative border border-foreground/10 bg-content1 transition-colors hover:bg-foreground/[0.03]"
    >
      <CardBody className="gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">
              <Link
                href={`/apps/${app.public_id}`}
                className="rounded-sm after:absolute after:inset-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {/* A pod app is its DOMAIN; its name is only what it calls itself. */}
                {pod ? <HostName host={pod.domain} /> : app.name}
              </Link>
            </p>
            <p className="mt-1 text-xs text-foreground/65">
              {pod ? (
                <>
                  Calls itself &ldquo;{app.name}&rdquo; ·{" "}
                  {tierLabel(pod.verified)}
                </>
              ) : (
                <span className="font-mono">{app.public_id}</span>
              )}
            </p>
          </div>
          {view.showChip ? (
            <Chip
              size="sm"
              variant="flat"
              color={chipColor(view.tone)}
              className="shrink-0"
            >
              {view.label}
            </Chip>
          ) : null}
        </div>

        <p className="text-xs text-foreground/70">
          {pod && !app.revoked_at
            ? approvalSentence(pod.approved)
            : appHolderAccess(app).sentence}
        </p>
        <p className="text-xs text-foreground/65">{meta}</p>
        {pod && !app.revoked_at ? (
          <p className="text-xs text-foreground/65">{POD_APP_ACCESS_LINE}</p>
        ) : null}

        {onRevoke ? (
          <div className="relative z-10 pt-1">
            <Button
              color="danger"
              size="sm"
              className="min-h-10"
              variant="flat"
              startContent={<Ban size={14} />}
              isLoading={isRevoking}
              onPress={onRevoke}
            >
              {resolveConnectionAction("revoke").label}
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function AppEmptyState() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-foreground/15 px-4 py-5">
      <div className="flex items-start gap-3 text-sm text-foreground/65">
        <SquareCode size={17} className="mt-0.5 shrink-0" />
        <span className="text-pretty">
          You have no apps yet. When you connect an app from its website, it
          shows here. Building one? Add a{" "}
          <span className="font-mono">synap.app.json</span> to your repo and run
          the command below from it.
        </span>
      </div>
      {/* The escape hatch: apps are registered from a repo, which this web page
          cannot do for you — hand over the exact command instead of a door that
          goes nowhere. */}
      <CopyButton text={CONNECT_COMMAND} label={CONNECT_COMMAND} />
    </div>
  );
}
