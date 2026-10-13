"use client";

/**
 * One Claude/MCP client of the pod's own OAuth server —
 * `oauthClients.adminGet`. A registration reaches nothing; its reach is the
 * keys people minted by consenting, so the page reads through them: who
 * connected it, which keys are live, when one was last used. Revoke stops
 * every key and keeps the registration (`services/oauth-client-inventory`):
 * a person connects it again by consenting, the same act as the first time.
 */

import { formatRelative } from "../../../../lib/format";
import { trpc } from "../../../../lib/trpc";
import { ErrorNote, errorDetail } from "../../../_lib/copy-button";
import type { ObjectFrame } from "../../../_lib/object/views/object-frame";
import { useReauthOnUnauthorized } from "../../../_lib/object/use-reauth";
import type { DangerAction } from "../../../_lib/object/danger-zone";
import { mcpReach, mcpState, statePill } from "./app-inventory";
import {
  AppSection,
  CopyableId,
  ExactValues,
  KeyList,
  PeopleList,
  appFailure,
} from "./app-object-parts";
import { ViaChip } from "./via-chip";

export function McpAppObject({
  clientId,
  frame,
}: {
  clientId: string;
  frame: ObjectFrame;
}) {
  const utils = trpc.useUtils();
  const query = trpc.oauthClients.adminGet.useQuery(
    { clientId },
    { retry: false }
  );
  const revoke = trpc.oauthClients.adminRevoke.useMutation({
    onSuccess: () =>
      Promise.all([
        utils.oauthClients.adminGet.invalidate({ clientId }),
        utils.oauthClients.adminList.invalidate(),
      ]),
  });
  useReauthOnUnauthorized(query.error, revoke.error);

  if (query.isLoading) return frame.loading("Loading app…");
  const client = query.data;
  if (query.error || !client) return appFailure(frame, query.error);

  const state = mcpState(client);
  const reach = mcpReach(client.scopes);
  const revoking = revoke.isPending;
  const danger: DangerAction[] =
    client.activeKeys > 0
      ? [
          {
            key: "revoke",
            label: "Revoke",
            description: "Every key it holds stops working at once.",
            consequence: (
              <>
                <p>
                  {client.activeKeys === 1
                    ? "Its key stops working at once"
                    : `Its ${client.activeKeys} keys stop working at once`}
                  , for everyone who connected it, and a sign-in still in
                  progress cannot finish.
                </p>
                <p className="mt-2 text-foreground/65">
                  Its registration stays. Someone can connect it again by
                  approving it on the consent screen.
                </p>
              </>
            ),
            confirmLabel: "Revoke access",
            isPending: revoking,
            onConfirm: () => revoke.mutateAsync({ clientId }),
          },
        ]
      : [];

  return frame.object({
    header: {
      kind: "application",
      noun: "App",
      title: client.clientName,
      summary: `${reach}.`,
      status: statePill(state),
      breadcrumb: frame.breadcrumb?.(client.clientName),
      secondaryActions: <ViaChip via="mcp" />,
    },
    facts: [
      {
        label: "Redirects to",
        value: client.redirectHosts.join(", ") || "—",
      },
      {
        label: "Keys",
        value: `${client.activeKeys} live of ${client.mintedKeys}`,
      },
      {
        label: "Last used",
        value: formatRelative(client.lastUsedAt, { empty: "Never" }),
      },
      { label: "Registered", value: formatRelative(client.createdAt) },
    ],
    children: (
      <>
        {revoke.error && (
          <ErrorNote
            message="We couldn't revoke this app. Nothing changed — try again."
            detail={errorDetail(revoke.error)}
          />
        )}

        <AppSection title="Identity">
          <CopyableId label="Client id" value={client.clientId} />
          <ExactValues label="Redirect URIs" values={client.redirectUris} />
        </AppSection>

        <AppSection
          title="What it can reach"
          hint={`${reach}, as an agent: the pod's agent rules decide which of its changes wait for review.`}
        >
          <ExactValues label="Scopes" values={client.scopes} />
        </AppSection>

        <AppSection
          title="Who uses it"
          hint="Each person who approved it on the consent screen holds a key of their own."
        >
          <PeopleList
            people={client.people.map((p) => ({
              ...p,
              note: p.active ? "Connected" : "No live key",
            }))}
            empty="No one has connected it."
          />
        </AppSection>

        <AppSection title="Keys">
          <KeyList keys={client.keys} empty="No key was minted for it." />
        </AppSection>
      </>
    ),
    advanced: {
      ids: [{ label: "Client id", value: client.clientId }],
      raw: { ...client, keys: undefined },
    },
    danger,
  });
}
