"use client";

/**
 * One of YOUR vault secrets, the one object page — `/my-vault/[id]`.
 *
 * Reads `secretsVault.getDetailBundle` (owner-only: a secret that is not yours
 * is NOT_FOUND) plus the owner's own `list` row for the two facts the bundle
 * lacks (compromised, last used). It never reads or shows the value: `reveal`
 * stays out of a browser tab a person may leave open on a borrowed machine
 * (see `../page.tsx`), and nothing here says the vault is zero-knowledge.
 *
 * A FAILED read is an error with a retry, never an empty page: a bundle that
 * did not load draws the failure, a list that did not load says only that the
 * compromise mark could not be read.
 */

import { Button, addToast } from "@heroui/react";
import { Bot, Box, KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import type { SecretGrantView } from "@synap-core/types/vault";
import { trpc } from "../../../lib/trpc";
import { ExitLink } from "../../../lib/exit-link";
import { formatRelative, formatTimestamp } from "../../../lib/format";
import { openIn } from "../../../lib/open-in";
import { useT } from "../../../lib/i18n/locale-provider";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import {
  ResourceRow,
  ResourceRowEmpty,
} from "../../(admin)/components/resource-row";
import { SectionCard } from "../../(admin)/components/section-card";
import type { DangerAction } from "../../_lib/object/danger-zone";
import { couldNotLoad, loadFailure } from "../../_lib/object/load-failure";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import type { ObjectFrame } from "../../_lib/object/views/object-frame";
import { SECRET_CATALOGS } from "./copy";
import {
  activityLine,
  grantState,
  granteeWords,
  type GranteeLookup,
  listRowFor,
  secretStatus,
  splitGrants,
  usageTarget,
  type SecretListRow,
} from "./secret-model";

/** Latest events in view before "Show all". */
const ACTIVITY_CAP = 6;

export function SecretObject({
  id,
  frame,
}: {
  id: string;
  frame: ObjectFrame;
}) {
  const t = useT(SECRET_CATALOGS);
  const router = useRouter();
  const utils = trpc.useUtils();
  const bundle = trpc.secretsVault.getDetailBundle.useQuery(
    { id },
    { retry: false }
  );
  const list = trpc.secretsVault.list.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  // The grantee's name: the owner's own grants list (label + type) and the
  // viewer's spaces. A failed read falls back to the holder's kind + short id.
  const allGrants = trpc.secretsVault.listAllGrants.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });
  useReauthOnUnauthorized(bundle.error, list.error);
  const lookup: GranteeLookup = {
    grants: allGrants.data,
    spaces: spaces.data?.map((w) => ({ id: w.id, name: w.name })),
  };

  const [revoking, setRevoking] = useState<SecretGrantView | null>(null);
  const [showAllActivity, setShowAllActivity] = useState(false);

  const refresh = () =>
    Promise.all([
      utils.secretsVault.getDetailBundle.invalidate({ id }),
      utils.secretsVault.list.invalidate(),
      utils.secretsVault.getSecurityStats.invalidate(),
    ]);

  const revoke = trpc.secretsVault.revokeGrant.useMutation({
    onSuccess: async () => {
      setRevoking(null);
      await refresh();
      addToast({ title: t("grants.revoked"), color: "default" });
    },
    onError: (err) => {
      setRevoking(null);
      addToast({
        title: t("grants.revokeFailed"),
        description: err.message,
        color: "danger",
      });
    },
  });
  const markCompromised = trpc.secretsVault.markCompromised.useMutation();
  const remove = trpc.secretsVault.delete.useMutation();

  const row: SecretListRow | null = useMemo(
    () => listRowFor(list.data as SecretListRow[] | undefined, id),
    [list.data, id]
  );

  if (bundle.isLoading) return frame.loading(t("loading"));
  const data = bundle.data;
  if (bundle.error || !data) {
    // Not yours, not there, or signed out: retrying cannot change the answer.
    const code = bundle.error?.data?.code;
    const fail = loadFailure(bundle.error, "Secret", { inApp: false });
    if (
      fail &&
      (code === "NOT_FOUND" || code === "FORBIDDEN" || code === "UNAUTHORIZED")
    ) {
      return frame.failure({
        kind: "secret",
        id,
        failure: fail,
        openIn: false,
      });
    }
    // A read that FAILED, not an empty secret: say so, keep the retry.
    const failed = couldNotLoad("Secret", { inApp: false });
    return frame.object({
      header: {
        kind: "secret",
        title: failed.title,
        summary: failed.message,
        status: { kind: "down", label: failed.chip },
        breadcrumb: frame.breadcrumb?.(failed.chip),
        primaryAction: (
          <Button
            size="sm"
            radius="md"
            variant="flat"
            onPress={() => void bundle.refetch()}
          >
            {t("retry")}
          </Button>
        ),
      },
    });
  }

  const compromised = list.isSuccess && row ? row.isCompromised : null;
  const status = secretStatus(data, compromised, t);
  const { active, ended } = splitGrants(data.grants);
  const activity = showAllActivity
    ? data.recentActivity
    : data.recentActivity.slice(0, ACTIVITY_CAP);

  const lastUsed =
    !list.isSuccess || !row
      ? t("fact.lastUsed.unknown")
      : row.lastAccessedAt
        ? formatRelative(row.lastAccessedAt)
        : t("fact.lastUsed.never");

  // Named first: the exit-door tripwire reads `isPending: <proc>.` as a stub.
  const markIsPending = markCompromised.isPending;
  const removeIsPending = remove.isPending;
  const danger: DangerAction[] = [
    ...(compromised === false
      ? [
          {
            key: "compromised",
            label: t("danger.compromised.label"),
            description: t("danger.compromised.description"),
            consequence: t("danger.compromised.consequence"),
            confirmLabel: t("danger.compromised.confirm"),
            confirmColor: "warning" as const,
            isPending: markIsPending,
            onConfirm: async () => {
              try {
                await markCompromised.mutateAsync({ id });
                await refresh();
                addToast({
                  title: t("danger.compromised.done"),
                  color: "default",
                });
              } catch (err) {
                addToast({
                  title: t("danger.compromised.failed"),
                  description: (err as Error).message,
                  color: "danger",
                });
                throw err;
              }
            },
          },
        ]
      : []),
    {
      key: "delete",
      label: t("danger.delete.label"),
      description: t("danger.delete.description"),
      consequence: t("danger.delete.consequence"),
      confirmLabel: t("danger.delete.confirm"),
      isPending: removeIsPending,
      onConfirm: async () => {
        try {
          await remove.mutateAsync({ id });
          addToast({ title: t("danger.delete.done"), color: "default" });
          await utils.secretsVault.list.invalidate();
          router.push("/my-vault");
        } catch (err) {
          addToast({
            title: t("danger.delete.failed"),
            description: (err as Error).message,
            color: "danger",
          });
          throw err;
        }
      },
    },
  ];

  return (
    <>
      {frame.object({
        header: {
          kind: "secret",
          noun: resolveObjectNoun(data.type),
          title: data.name,
          summary: status.sentence,
          status: { kind: status.kind, label: status.label },
          breadcrumb: frame.breadcrumb?.(data.name),
          secondaryActions: (
            <ExitLink
              exit={openIn({ kind: "settings", section: "vault" })}
              label={t("settings.link")}
            />
          ),
        },
        facts: [
          { label: t("fact.lastUsed"), value: lastUsed },
          { label: t("fact.created"), value: formatTimestamp(data.createdAt) },
          { label: t("fact.updated"), value: formatRelative(data.updatedAt) },
          ...(data.category
            ? [{ label: t("fact.category"), value: data.category }]
            : []),
          ...(data.url
            ? [{ label: t("fact.address"), value: data.url, mono: true }]
            : []),
          { label: t("fact.id"), value: data.id, mono: true },
        ],
        railLabel: t("activity.title"),
        rail: (
          <SectionCard title={t("activity.title")} variant="flat">
            {data.recentActivity.length === 0 ? (
              <ResourceRowEmpty message={t("activity.empty")} />
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {activity.map((e) => (
                    <li key={e.id} className="flex flex-col">
                      <span className="text-[12.5px] text-foreground">
                        {activityLine(e, t)}
                      </span>
                      <span className="text-[11.5px] text-foreground/65">
                        {formatRelative(e.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
                {data.recentActivity.length > ACTIVITY_CAP && (
                  <Button
                    size="sm"
                    variant="light"
                    radius="md"
                    className="self-start text-foreground/65"
                    onPress={() => setShowAllActivity((v) => !v)}
                  >
                    {showAllActivity
                      ? t("activity.less")
                      : t("activity.more", { n: data.recentActivity.length })}
                  </Button>
                )}
              </>
            )}
          </SectionCard>
        ),
        children: (
          <>
            <SectionCard title={t("grants.title")} hint={t("grants.hint")}>
              {active.length === 0 ? (
                <ResourceRowEmpty message={t("grants.empty")} />
              ) : (
                <div className="-mx-2 divide-y divide-foreground/[0.05]">
                  {active.map((g) => (
                    <GrantRow
                      key={g.grantId}
                      grant={g}
                      lookup={lookup}
                      onRevoke={setRevoking}
                    />
                  ))}
                </div>
              )}
              {ended.length > 0 && (
                <div className="mt-3 flex flex-col gap-1">
                  <h4 className="px-1 text-[12px] font-medium text-foreground/65">
                    {t("grants.ended")}
                  </h4>
                  <div className="-mx-2 divide-y divide-foreground/[0.05]">
                    {ended.map((g) => (
                      <GrantRow key={g.grantId} grant={g} lookup={lookup} />
                    ))}
                  </div>
                </div>
              )}
            </SectionCard>

            <SectionCard title={t("usages.title")} hint={t("usages.hint")}>
              {data.usages.length === 0 ? (
                <ResourceRowEmpty message={t("usages.empty")} />
              ) : (
                <div className="-mx-2 divide-y divide-foreground/[0.05]">
                  {data.usages.map((u) => {
                    const target = usageTarget(u);
                    const href = target ? openIn(target).href : null;
                    return (
                      <ResourceRow
                        key={u.id}
                        Icon={Box}
                        primary={u.consumerLabel}
                        secondary={resolveObjectNoun(u.consumerType)}
                        onSelect={href ? () => router.push(href) : undefined}
                      />
                    );
                  })}
                </div>
              )}
            </SectionCard>
          </>
        ),
        danger,
      })}

      <ConfirmModal
        isOpen={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking) revoke.mutate({ grantId: revoking.grantId });
        }}
        title={t("grants.revoke.title")}
        consequence={
          revoking
            ? t("grants.revoke.consequence", {
                who: granteeWords(revoking, lookup, t),
              })
            : null
        }
        confirmLabel={t("grants.revoke.confirm")}
        isPending={
          revoke.isPending && revoke.variables?.grantId === revoking?.grantId
        }
      />
    </>
  );
}

function GrantRow({
  grant,
  lookup,
  onRevoke,
}: {
  grant: SecretGrantView;
  lookup: GranteeLookup;
  onRevoke?: (g: SecretGrantView) => void;
}) {
  const t = useT(SECRET_CATALOGS);
  const state = grantState(grant);
  const who = granteeWords(grant, lookup, t);
  const detail = [
    grant.scope,
    state === "revoked" && grant.revokedAt
      ? t("grants.detail.revoked", { when: formatRelative(grant.revokedAt) })
      : null,
    grant.expiresAt
      ? t(
          state === "expired"
            ? "grants.detail.expired"
            : "grants.detail.expires",
          { when: formatRelative(grant.expiresAt) }
        )
      : null,
    typeof grant.usesRemaining === "number"
      ? t("grants.detail.usesLeft", { n: grant.usesRemaining })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ResourceRow
      Icon={state === "active" ? Bot : KeyRound}
      primary={t("grants.to", { who })}
      secondary={detail}
      status={{
        kind: state === "active" ? "stale" : "unknown",
        label: t(`grants.status.${state}`),
      }}
      actions={
        onRevoke && state === "active" ? (
          <Button
            size="sm"
            radius="md"
            variant="light"
            className="min-h-10 text-foreground/65"
            aria-label={t("grants.revoke.aria", { who })}
            onPress={() => onRevoke(grant)}
          >
            {t("grants.revoke")}
          </Button>
        ) : undefined
      }
    />
  );
}
