"use client";

/**
 * One "Sign in with your pod" app — `applicationConnections.get`. The app
 * acts as whoever signed in and sees only what they can see, so its reach is
 * a sentence, not a grant list; what it was allowed is its exact browser
 * origins and return URLs (the transport boundary) plus the optional
 * capabilities noted at approval. Revoke drops the origins' admission; it
 * does not remove people or end their pod sessions (the consequence says so).
 */

import { humanizeToken } from "@synap-core/types/vocabulary";
import { ExitLink } from "../../../../lib/exit-link";
import { formatRelative } from "../../../../lib/format";
import { publisherExit } from "../../../../lib/open-in";
import { trpc } from "../../../../lib/trpc";
import { applicationConnectionCapabilities } from "../../../_lib/application-connection-capabilities";
import { ErrorNote, errorDetail } from "../../../_lib/copy-button";
import type { ObjectFrame } from "../../../_lib/object/views/object-frame";
import { SubjectActivity } from "../../../_lib/object/subject-activity";
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
  CopyableId,
  ExactValues,
  PeopleList,
  appFailure,
} from "./app-object-parts";
import { SectionCard } from "../../components/section-card";
import { appActivityLine } from "./app-activity";
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
  if (query.error || !conn) return appFailure(frame, id, query.error);

  const state = signInState(conn);
  const publisher = hostOf(conn.publisherUrl);
  // Only an https address is followed (`publisherExit`); anything else is
  // named, never linked.
  const publisherSite = publisherExit(conn.publisherUrl);
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
      noun: (
        <>
          App <ViaChip via="sign-in" />
        </>
      ),
      title: conn.displayName,
      summary: `${SIGN_IN_REACH}.`,
      status: statePill(state),
      breadcrumb: frame.breadcrumb?.(conn.displayName),
    },
    facts: [
      ...(publisher
        ? [
            {
              label: "Publisher",
              value: publisherSite ? (
                <ExitLink exit={publisherSite} label={publisher} />
              ) : (
                publisher
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
    children: revoke.error && (
      <ErrorNote
        message="We couldn't revoke this app. Nothing changed — try again."
        detail={errorDetail(revoke.error)}
      />
    ),
    tabs: [
      {
        key: "overview",
        label: "Overview",
        content: (
          <div className="flex flex-col gap-6">
            <SectionCard variant="flat" title="Identity">
              <CopyableId label="App id" value={conn.clientId} />
              <ExactValues
                label="Allowed browser origins"
                values={conn.allowedOrigins}
              />
              <ExactValues
                label="Allowed return URLs"
                values={conn.allowedCallbackUrls}
              />
            </SectionCard>

            <SectionCard
              variant="flat"
              title="What it can reach"
              hint="It acts as the person who signed in, and sees only what that person can see in the pod. Allowing it gives no one access to data."
            >
              <ExactValues
                label="Noted at approval"
                values={[applicationConnectionCapabilities(conn.allowedScopes)]}
              />
            </SectionCard>

            <SectionCard
              variant="flat"
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
            </SectionCard>
          </div>
        ),
      },
      {
        key: "activity",
        label: "Activity",
        content: (
          <SubjectActivity
            subjectIds={[conn.id, ...conn.requestIds]}
            line={(e) => appActivityLine(e, humanizeToken)}
          />
        ),
      },
    ],
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
