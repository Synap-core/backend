"use client";

/**
 * One "Sign in with your pod" app — `applicationConnections.get`. The app
 * acts as whoever signed in and sees only what they can see, so its reach is
 * a sentence, not a grant list; what it was allowed is its exact browser
 * origins and return URLs (the transport boundary) plus the optional
 * capabilities noted at approval. Revoke drops the origins' admission; it
 * does not remove people or end their pod sessions (the consequence says so).
 */

import Link from "next/link";
import { useState } from "react";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { ExitLink } from "../../../../lib/exit-link";
import { navHref } from "../../../../lib/console-nav";
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
  personName,
  signInState,
  statePill,
} from "./app-inventory";
import {
  CopyableId,
  ExactValues,
  PeopleList,
  appFailure,
  type AppPerson,
} from "./app-object-parts";
import { ConfirmModal } from "../../components/confirm-modal";
import { SectionCard } from "../../components/section-card";
import { appActivityLine } from "./app-activity";
import { unlinkSignInNotice } from "./unlink-impact";
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
  // "Unlink {email}": one person off this app's issuer (so off every app of
  // that issuer, `unlinkReach`); the app stays.
  // The person stays set while the confirm plays its exit, so its title does
  // not change under the closing modal; `unlinkOpen` decides visibility.
  const [unlinking, setUnlinking] = useState<AppPerson | null>(null);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const unlink = trpc.applicationConnections.unlinkAccount.useMutation({
    onSuccess: () =>
      Promise.all([
        utils.applicationConnections.get.invalidate({ id }),
        utils.applicationConnections.list.invalidate(),
      ]),
  });
  useReauthOnUnauthorized(query.error, revoke.error, unlink.error);

  if (query.isLoading) return frame.loading("Loading app…");
  const conn = query.data;
  if (query.error || !conn) return appFailure(frame, id, query.error);

  const state = signInState(conn);
  // The other APPS "Unlink" takes away: the link is per sign-in service, not
  // per app. Cloud sign-in is not an app; it has its own sentence below.
  const alsoGoes = conn.unlinkReach.otherApps.map((app) => app.displayName);
  // What the person is left to sign in with: the server's fact, per person.
  const unlinkingWho =
    unlinking?.email ?? personName(unlinking) ?? "This person";
  const signInNotice = unlinking
    ? unlinkSignInNotice(
        conn.people.find((p) => p.userId === unlinking.id)?.unlinkImpact ??
          "unknown",
        conn.unlinkReach.cloudSignIn,
        unlinkingWho
      )
    : null;
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
    children: (
      <>
        {revoke.error && (
          <ErrorNote
            message="We couldn't revoke this app. Nothing changed — try again."
            detail={errorDetail(revoke.error)}
          />
        )}
        {unlink.error && (
          <ErrorNote
            message="We couldn't unlink that account. Nothing changed — try again."
            detail={errorDetail(unlink.error)}
          />
        )}
        {unlink.data?.status === "unlinked" &&
        unlink.data.signIn === "failed" ? (
          <>
            <ErrorNote
              message={`${unlink.data.email ?? "That account"} is unlinked, but their Synap Cloud sign-in could not be removed from their Pod account.`}
            />
            <Link
              href={navHref("members", { focus: unlinking?.id })}
              className="text-[13px] underline"
            >
              Remove it from Members
            </Link>
          </>
        ) : null}
        <ConfirmModal
          isOpen={unlinkOpen}
          onClose={() => setUnlinkOpen(false)}
          onConfirm={() => {
            if (!unlinking) return;
            unlink
              .mutateAsync({ connectionId: id, userId: unlinking.id })
              .then(() => setUnlinkOpen(false))
              // The error note above says it did not happen; the confirm
              // stays up.
              .catch(() => undefined);
          }}
          title={`Unlink ${unlinking?.email ?? personName(unlinking) ?? "this account"}`}
          consequence={
            <>
              <p>
                Their Synap account stops signing in to this Pod through{" "}
                {conn.displayName}
                {alsoGoes.length > 0
                  ? `, and through ${new Intl.ListFormat("en", { type: "conjunction" }).format(alsoGoes)}: they share one sign-in service, so the account is unlinked from all of them at once.`
                  : "."}
              </p>
              {conn.unlinkReach.cloudSignIn ? (
                <p className="mt-2">
                  This also removes their Continue with Synap Cloud sign-in.
                </p>
              ) : null}
              {signInNotice ? (
                <div
                  className={
                    signInNotice.tone === "danger"
                      ? "mt-3 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30"
                      : "mt-3 rounded-medium bg-warning/10 p-3 text-[13px] text-warning ring-1 ring-inset ring-warning/30"
                  }
                  role="alert"
                >
                  {signInNotice.text}
                </div>
              ) : null}
              <p className="mt-2 text-foreground/65">
                Their Pod account, memberships and any password stay. Everyone
                else keeps using {conn.displayName}.
              </p>
            </>
          }
          confirmLabel="Unlink"
          confirmColor="danger"
          isPending={unlink.isPending}
        />
      </>
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
                  note: p.linkedByInvite
                    ? `linked by invite ${formatRelative(p.linkedAt)}, without an owner's approval`
                    : `signed in ${formatRelative(p.linkedAt)}`,
                }))}
                empty="No one has signed in through it yet."
                onUnlink={(person) => {
                  setUnlinking(person);
                  setUnlinkOpen(true);
                }}
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
