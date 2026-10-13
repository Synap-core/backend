"use client";

/**
 * One "Sign in with your pod" app — `applicationConnections.get`. The app
 * acts as whoever signed in and sees only what they can see, so its reach is
 * a sentence, not a grant list; what it was allowed is its exact browser
 * origins and return URLs (the transport boundary) plus the optional
 * capabilities noted at approval. Revoke drops the origins' admission; it
 * does not remove people or end their pod sessions (the consequence says so).
 */

import { formatRelative } from "../../../../lib/format";
import { trpc } from "../../../../lib/trpc";
import { applicationConnectionCapabilities } from "../../../_lib/application-connection-capabilities";
import { ErrorNote, errorDetail } from "../../../_lib/copy-button";
import type { ObjectFrame } from "../../../_lib/object/views/object-frame";
import { useReauthOnUnauthorized } from "../../../_lib/object/use-reauth";
import type { DangerAction } from "../../../_lib/object/danger-zone";
import {
  SIGN_IN_REACH,
  hostOf,
  peopleWord,
  signInState,
  statePill,
} from "./app-inventory";
import {
  AppSection,
  CopyableId,
  ExactValues,
  PeopleList,
  appFailure,
} from "./app-object-parts";
import { ViaChip } from "./via-chip";

export function SignInAppObject({
  id,
  frame,
}: {
  id: string;
  frame: ObjectFrame;
}) {
  const utils = trpc.useUtils();
  const query = trpc.applicationConnections.get.useQuery(
    { id },
    { retry: false }
  );
  const revoke = trpc.applicationConnections.revokeConnection.useMutation({
    onSuccess: () =>
      Promise.all([
        utils.applicationConnections.get.invalidate({ id }),
        utils.applicationConnections.list.invalidate(),
      ]),
  });
  useReauthOnUnauthorized(query.error, revoke.error);

  if (query.isLoading) return frame.loading("Loading app…");
  const conn = query.data;
  if (query.error || !conn) return appFailure(frame, query.error);

  const state = signInState(conn);
  const publisher = hostOf(conn.publisherUrl);
  const revoking = revoke.isPending;
  const danger: DangerAction[] =
    conn.status === "approved"
      ? [
          {
            key: "revoke",
            label: "Revoke",
            description:
              "Its browser origins stop being allowed to call this pod.",
            consequence: (
              <>
                <p>
                  Its browser origins immediately lose permission to call this
                  pod.
                </p>
                <p className="mt-2 text-foreground/65">
                  This does not remove people, revoke trusted issuers, or end
                  sessions people already hold with the pod directly.
                </p>
              </>
            ),
            confirmLabel: "Revoke access",
            isPending: revoking,
            onConfirm: () => revoke.mutateAsync({ id }),
          },
        ]
      : [];

  return frame.object({
    header: {
      kind: "application",
      noun: "App",
      title: conn.displayName,
      summary: `${SIGN_IN_REACH}.`,
      status: statePill(state),
      breadcrumb: frame.breadcrumb?.(conn.displayName),
      secondaryActions: <ViaChip via="sign-in" />,
    },
    facts: [
      ...(publisher
        ? [
            {
              label: "Publisher",
              value: (
                <a
                  href={conn.publisherUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {publisher}
                </a>
              ),
            },
          ]
        : []),
      { label: "People", value: peopleWord(conn.peopleCount) },
      {
        label: "Last used",
        value: formatRelative(conn.lastUsedAt, { empty: "Never" }),
      },
      {
        label: conn.status === "approved" ? "Approved" : "Updated",
        value: formatRelative(conn.reviewedAt ?? conn.updatedAt),
      },
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
          <CopyableId label="App id" value={conn.clientId} />
          <ExactValues
            label="Allowed browser origins"
            values={conn.allowedOrigins}
          />
          <ExactValues
            label="Allowed return URLs"
            values={conn.allowedCallbackUrls}
          />
        </AppSection>

        <AppSection
          title="What it can reach"
          hint="It acts as the person who signed in, and sees only what that person can see in the pod. Allowing it gives no one access to data."
        >
          <ExactValues
            label="Noted at approval"
            values={[applicationConnectionCapabilities(conn.allowedScopes)]}
          />
        </AppSection>

        <AppSection
          title="Who uses it"
          hint="People who signed in through the identity service this app was registered with. Last used is when that service last acted for one of them."
        >
          <PeopleList
            people={conn.people.map((p) => ({
              id: p.userId,
              name: p.name,
              email: p.email,
              note: `signed in ${formatRelative(p.linkedAt)}`,
            }))}
            empty="No one has signed in through it yet."
          />
        </AppSection>
      </>
    ),
    advanced: {
      ids: [
        { label: "Connection id", value: conn.id },
        { label: "App id", value: conn.clientId },
        { label: "Registered via (issuer)", value: conn.issuerUrl },
      ],
      raw: { ...conn, people: undefined },
    },
    danger,
  });
}
