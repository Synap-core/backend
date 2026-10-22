"use client";

/**
 * Pod apps (spec 17 PB4) as the pod admin sees them: apps that members
 * connected at this pod's sign-in door, grouped by app across members
 * (`apps.adminPodApps`), and the pod's one policy switch for them
 * (`apps.adminPolicy` / `apps.adminSetPolicy`, founder decision F4: members
 * may connect apps that are not Synap apps, default on).
 *
 * One member's connection opens on its own app page (`/applications/key/…`,
 * the same `adminGet` / `adminRevoke` door as any App Connect app); "Revoke
 * for everyone" ends every member's connection of that app
 * (`apps.adminRevokeClient`). The switch gates NEW connections only, so the
 * card says how many unverified connections stay live when it is off.
 */

import { Button, Switch, addToast } from "@heroui/react";
import Link from "next/link";
import { useState } from "react";
import { SquareCode } from "lucide-react";
import { trpc } from "../../../../lib/trpc";
import { formatRelative, readableError } from "../../../../lib/format";
import { ConfirmModal } from "../../components/confirm-modal";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { StatusPill } from "../../components/status-pill";
import { approvalSentence, tierLabel } from "../../../apps/_lib/pod-app-view";
import { appHref } from "./app-inventory";

export function PodAppsCard() {
  const utils = trpc.useUtils();
  const groups = trpc.apps.adminPodApps.useQuery(undefined, {
    staleTime: 30_000,
  });
  const policy = trpc.apps.adminPolicy.useQuery(undefined, {
    staleTime: 30_000,
  });
  const setPolicy = trpc.apps.adminSetPolicy.useMutation({
    onSuccess: (next) => {
      utils.apps.adminPolicy.setData(undefined, next);
    },
    onError: (err) =>
      addToast({
        title: "Couldn't change it",
        description: readableError(err.message),
        color: "danger",
      }),
  });
  const [ending, setEnding] = useState<{
    clientId: string;
    domain: string;
    verified: boolean;
    live: number;
  } | null>(null);
  const revokeAll = trpc.apps.adminRevokeClient.useMutation({
    onSuccess: async ({ revoked }) => {
      setEnding(null);
      addToast({
        title: `Revoked for ${revoked} member${revoked === 1 ? "" : "s"}`,
        color: "default",
      });
      await Promise.all([
        utils.apps.adminPodApps.invalidate(),
        utils.apps.adminList.invalidate(),
        utils.apps.adminPolicy.invalidate(),
      ]);
    },
    onError: (err) => {
      setEnding(null);
      addToast({
        title: "Couldn't revoke",
        description: readableError(err.message),
        color: "danger",
      });
    },
  });

  const allow = policy.data?.allowUnverified ?? true;
  const stillLive = policy.data?.unverifiedLive ?? 0;

  return (
    <SectionCard
      title="Pod apps"
      hint="Apps your members connected to their pod by signing in. Each acts only in the spaces its member approved, and asks before changing anything unless that member turned on Apply automatically."
    >
      <div className="flex items-start justify-between gap-4 px-1 pb-3">
        <div className="min-w-0">
          <p className="text-[13px] text-foreground/85">
            Allow apps that are not Synap apps
          </p>
          <p className="mt-0.5 max-w-2xl text-[12px] leading-5 text-foreground/65">
            {allow
              ? "Members may connect any app, within what they can do themselves. Unverified apps show their domain and a warning."
              : `Only Synap apps can connect. ${
                  stillLive > 0
                    ? `${stillLive} connection${stillLive === 1 ? "" : "s"} made before stay${stillLive === 1 ? "s" : ""} until revoked below.`
                    : "No unverified app is connected."
                }`}
          </p>
        </div>
        <Switch
          size="sm"
          isSelected={allow}
          isDisabled={policy.isLoading || setPolicy.isPending}
          onValueChange={(on) => setPolicy.mutate({ allowUnverified: on })}
          aria-label="Allow apps that are not Synap apps"
        />
      </div>

      {groups.isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : groups.error ? (
        <ResourceRowError
          message="Couldn't load pod apps."
          onRetry={() => void groups.refetch()}
        />
      ) : (groups.data ?? []).length === 0 ? (
        <ResourceRowEmpty message="No member has connected a pod app yet." />
      ) : (
        <ul className="flex flex-col divide-y divide-foreground/[0.06]">
          {(groups.data ?? []).map((g) => (
            <li key={g.client_id} className="flex flex-col gap-2 px-1 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <SquareCode
                    className="h-4 w-4 shrink-0 text-foreground/55"
                    aria-hidden
                  />
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {g.domain}
                  </span>
                  <StatusPill
                    kind={g.verified ? "healthy" : "stale"}
                    label={tierLabel(g.verified)}
                  />
                  <span className="text-[12px] text-foreground/65">
                    {g.live} member{g.live === 1 ? "" : "s"}
                  </span>
                </div>
                {g.live > 0 ? (
                  <Button
                    size="sm"
                    variant="flat"
                    color="danger"
                    radius="md"
                    className="min-h-9"
                    onPress={() =>
                      setEnding({
                        clientId: g.client_id,
                        domain: g.domain,
                        verified: g.verified,
                        live: g.live,
                      })
                    }
                  >
                    Revoke for everyone
                  </Button>
                ) : null}
              </div>
              <ul className="flex flex-col gap-1 pl-6">
                {g.members.map((m) => (
                  <li key={m.public_id} className="text-[12px] leading-5">
                    <Link
                      href={appHref("key", m.public_id)}
                      className="font-medium text-foreground/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      {m.owner?.name ?? m.owner?.email ?? "A former member"}
                    </Link>{" "}
                    <span className="text-foreground/65">
                      {m.revoked_at
                        ? `· revoked ${formatRelative(m.revoked_at)}`
                        : `· ${approvalSentence(m.approved)} · ${
                            m.last_used_at
                              ? `last used ${formatRelative(m.last_used_at)}`
                              : "never used"
                          }`}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <ConfirmModal
        isOpen={ending !== null}
        onClose={() => setEnding(null)}
        onConfirm={() =>
          ending && revokeAll.mutate({ clientId: ending.clientId })
        }
        title={`Revoke ${ending?.domain ?? "this app"} for everyone?`}
        consequence={
          <p>
            {`Every member's connection of ${ending?.domain ?? "this app"} stops now (${ending?.live ?? 0} member${ending?.live === 1 ? "" : "s"}): its tokens, its sign-in renewals and its webhooks. A member can connect it again later${
              allow || ending?.verified
                ? ""
                : ", once you allow apps that are not Synap apps again"
            }.`}
          </p>
        }
        confirmLabel="Revoke for everyone"
        isPending={revokeAll.isPending}
      />
    </SectionCard>
  );
}
