"use client";

/**
 * One KEY app (App Connect) as a pod admin sees it — `apps.adminGet`, any
 * owner. Standing is the membrane rule, reach the ONE holder reader
 * (`appHolderAccess`, with the space names the pod sent), the end words the
 * membrane's (`resolveAppEndConsequence`) — the same the owner's own page
 * (`/apps/[publicId]`) reads, so the two never disagree.
 *
 * The admin may END it (revoke; remove for good once revoked). Asking for
 * access, issuing or rotating its key stay the owner's acts — the page says
 * so instead of offering a door the pod would refuse.
 */

import { Button } from "@heroui/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { appHolderAccess, appMode } from "@synap-core/types/apps/app-view";
import {
  resolveAppConnectionState,
  resolveAppEndConsequence,
  resolveConnectionAction,
} from "@synap-core/types/membrane";
import { summarizeAppConnectRequest } from "@synap-core/types/proposals/intent";
import { navHref } from "../../../../lib/console-nav";
import { formatRelative } from "../../../../lib/format";
import { trpc } from "../../../../lib/trpc";
import { ErrorNote, errorDetail } from "../../../_lib/copy-button";
import type { ObjectFrame } from "../../../_lib/object/views/object-frame";
import { useReauthOnUnauthorized } from "../../../_lib/object/use-reauth";
import type { DangerAction } from "../../../_lib/object/danger-zone";
import { ResourceRowEmpty } from "../../components/resource-row";
import { personName, statePill } from "./app-inventory";
import {
  CopyableId,
  KeyList,
  PeopleList,
  appFailure,
} from "./app-object-parts";
import { SectionCard } from "../../components/section-card";
import { ViaChip } from "./via-chip";

export function KeyAppObject({
  publicId,
  frame,
}: {
  publicId: string;
  frame: ObjectFrame;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const query = trpc.apps.adminGet.useQuery({ publicId }, { retry: false });
  // Ending an app ends its keys too: the Keys list reads them.
  const refresh = () =>
    Promise.all([
      utils.apps.adminGet.invalidate(),
      utils.apps.adminList.invalidate(),
      utils.apiKeys.invalidate(),
    ]);
  const revoke = trpc.apps.adminRevoke.useMutation({ onSuccess: refresh });
  const remove = trpc.apps.adminRemove.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.apps.adminList.invalidate(),
        utils.apiKeys.invalidate(),
      ]);
      router.push(navHref("apps"));
    },
  });
  useReauthOnUnauthorized(query.error, revoke.error, remove.error);

  if (query.isLoading) return frame.loading("Loading app…");
  const app = query.data;
  if (query.error || !app) return appFailure(frame, publicId, query.error);

  const state = resolveAppConnectionState(app);
  const access = appHolderAccess(app, { workspaceNames: app.workspace_names });
  const owner = personName(app.owner);
  const hasKey = app.keys.some((k) => k.isActive && !k.revokedAt);
  const asked = app.pending_request
    ? summarizeAppConnectRequest({
        appName: app.name,
        requests: app.pending_request.requests,
        workspaceNames: app.workspace_names,
      })
    : null;
  const endWords = (action: "revoke" | "remove") =>
    resolveAppEndConsequence({
      state,
      action,
      hasKey,
      hasReach: app.grants.length > 0,
    });

  // Scoped per act, never a shared flag (`DangerAction.isPending`).
  const revoking = revoke.isPending;
  const removing = remove.isPending;
  const danger: DangerAction[] = app.revoked_at
    ? [
        {
          key: "remove",
          label: resolveConnectionAction("remove").label,
          description: endWords("remove").note,
          consequence: <p>{endWords("remove").confirm}</p>,
          confirmLabel: resolveConnectionAction("remove").label,
          isPending: removing,
          onConfirm: () => remove.mutateAsync({ publicId }),
        },
      ]
    : [
        {
          key: "revoke",
          label: resolveConnectionAction("revoke").label,
          description: endWords("revoke").note,
          consequence: (
            <>
              <p>{endWords("revoke").confirm}</p>
              {owner && (
                <p className="mt-2 text-foreground/65">
                  {owner} owns this app; they can register it again to ask for
                  access anew.
                </p>
              )}
            </>
          ),
          confirmLabel: resolveConnectionAction("revoke").label,
          isPending: revoking,
          onConfirm: () => revoke.mutateAsync({ publicId }),
        },
      ];
  const actError = revoke.error ?? remove.error;

  return frame.object({
    header: {
      kind: "application",
      noun: (
        <>
          App <ViaChip via="key" />
        </>
      ),
      title: app.name,
      summary: app.description || access.sentence,
      status: statePill(state),
      breadcrumb: frame.breadcrumb?.(app.name),
      primaryAction: app.pending_request ? (
        <Button
          as={Link}
          href={navHref("review", {
            type: "access",
            focus: app.pending_request.proposal_id,
          })}
          size="sm"
          radius="md"
          color="primary"
        >
          Open in Review
        </Button>
      ) : undefined,
    },
    facts: [
      { label: "Owner", value: owner ?? "Unknown" },
      { label: "Access", value: appMode(app.mode) },
      { label: "Added", value: formatRelative(app.created_at) },
      {
        label: "Last used",
        value: formatRelative(app.last_used_at, { empty: "Never" }),
      },
      ...(app.revoked_at
        ? [{ label: "Revoked", value: formatRelative(app.revoked_at) }]
        : []),
    ],
    children: (
      <>
        {actError && (
          <ErrorNote
            message="That didn't go through. Nothing changed — try again."
            detail={errorDetail(actError)}
          />
        )}

        <SectionCard variant="flat" title="Identity">
          <CopyableId
            label="App id"
            value={app.public_id}
            note={
              <>
                The <span className="font-mono">client_id</span> its access is
                granted to.
              </>
            }
          />
        </SectionCard>

        <SectionCard
          variant="flat"
          title="What it can reach"
          hint={app.revoked_at ? undefined : access.sentence}
        >
          {app.revoked_at ? (
            <ResourceRowEmpty message="Nothing. Revoking an app revokes its key, so nothing it held works any more." />
          ) : access.lines.length === 0 ? (
            <ResourceRowEmpty message="No access yet. Nothing has been approved for it." />
          ) : (
            <ul className="flex flex-col gap-2">
              {access.lines.map((line, i) => (
                <li
                  key={i}
                  className="rounded-lg px-3 py-2 ring-1 ring-inset ring-foreground/10"
                >
                  <p className="text-[13px] text-foreground/85">
                    {line.summary.what}
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-foreground/65">
                    {line.summary.where.length > 0
                      ? line.summary.where.join(" · ")
                      : "Anywhere"}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {asked && (
            <div className="rounded-lg bg-status-stale/10 px-3 py-2 ring-1 ring-inset ring-status-stale/30">
              <p className="text-[12.5px] font-medium text-foreground">
                Asks for
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {asked.lines.map((l) => (
                  <li
                    key={l.workspaceId ?? "anywhere"}
                    className="text-[12.5px] text-foreground/80"
                  >
                    {l.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SectionCard>

        <SectionCard
          variant="flat"
          title="Who uses it"
          hint="A key app acts as its owner, within the spaces its key names."
        >
          <PeopleList
            people={app.owner ? [{ ...app.owner, note: "Owner" }] : []}
            empty="Its owner's account is gone."
          />
        </SectionCard>

        <SectionCard
          variant="flat"
          title="Keys"
          hint="Only its owner can issue a new key, from their Connected page. Revoking the app below stops every key it holds."
        >
          <KeyList keys={app.keys} empty="No key has been issued yet." />
        </SectionCard>
      </>
    ),
    advanced: {
      ids: [
        { label: "App id", value: app.public_id },
        { label: "Record id", value: app.id },
        ...(app.agent_user_id
          ? [{ label: "Its agent user", value: app.agent_user_id }]
          : []),
      ],
      raw: app,
    },
    danger,
  });
}
