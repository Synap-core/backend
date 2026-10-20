"use client";

/**
 * A kind the web does not host: a card that NAMES the object and hands it to
 * the app.
 *
 * The name comes from `diagnose.resolveOpen` — the one user-floored "what is
 * this id?" body the desktop and the CLI already read — instead of the six
 * per-kind `get` queries this card used to fan out (each with its own return
 * shape to dig the name out of). `bounceReceipt` only trusts the answer when
 * the resolver agrees on the kind. A lookup that fails, is forbidden, or finds
 * nothing leaves the card exactly as it was without one: the exit renders
 * regardless, because a receipt that errors is worse than a bounce that works.
 *
 * `cell` is never looked up: `synap://open/cell/<id>` addresses a registered
 * cell TYPE KEY, not a row. `settings` addresses a section name. Both fail the
 * uuid gate.
 *
 * A kind the console also has an admin page for (a space) offers a pod admin
 * that page beside the app link ("See this space here"). A member is not
 * offered it: the page is pod-admin only and would answer /forbidden.
 */

import { Button } from "@heroui/react";
import Link from "next/link";

import { trpc } from "../../../lib/trpc";
import {
  bounceAddressParams,
  bounceReceipt,
  bounceSummary,
} from "../open-model";
import { labelForOpenType, type KnownOpenType } from "../open-params";
import { formatRelative, isUuid } from "../../../lib/format";
import { objectWebAlternative } from "../../../lib/open-in";
import { OpenLoading, OpenObject } from "../open-shell";
import { OpenInAppLink } from "../../_lib/object/open-in-app-link";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";

const PLACEHOLDER_UUID = "00000000-0000-4000-8000-000000000000";

export function BounceView({
  type,
  id,
  viewerIsPodAdmin,
}: {
  type: KnownOpenType;
  id: string;
  viewerIsPodAdmin: boolean;
}) {
  const lookup = isUuid(id) && type !== "cell";
  const resolved = trpc.diagnose.resolveOpen.useQuery(
    { id: lookup ? id : PLACEHOLDER_UUID },
    { enabled: lookup, retry: false }
  );
  const receipt = bounceReceipt(type, resolved.data);

  /* The resolver carries a space UUID, and a UUID is not a space. `list` is
     the cheapest name door the client already holds — one cached array — and
     it is only asked once a receipt resolved. */
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    enabled: Boolean(receipt?.workspaceId),
    retry: false,
  });
  const spaceName = receipt?.workspaceId
    ? (spaces.data ?? []).find((row) => row.id === receipt.workspaceId)?.name
    : undefined;

  useReauthOnUnauthorized(resolved.error);

  if (lookup && resolved.isLoading) return <OpenLoading />;

  const facts = [
    ...(spaceName ? [{ label: "Space", value: spaceName }] : []),
    ...(receipt?.updatedAt
      ? [{ label: "Updated", value: formatRelative(receipt.updatedAt) }]
      : []),
  ];

  const noun = labelForOpenType(type);
  const consolePage = viewerIsPodAdmin
    ? objectWebAlternative(type, id)
    : undefined;
  return (
    <OpenObject
      header={{
        kind: type,
        title:
          receipt?.title ?? `This ${noun.toLowerCase()} opens in the Synap app`,
        summary: bounceSummary(type),
        status: { kind: "unknown", label: "Opens in app" },
        primaryAction: (
          <OpenInAppLink
            type={type}
            id={id}
            params={bounceAddressParams(type, resolved.data)}
          />
        ),
        secondaryActions: consolePage ? (
          <Button
            as={Link}
            href={consolePage.href}
            size="sm"
            radius="md"
            variant="light"
          >
            {consolePage.label}
          </Button>
        ) : undefined,
      }}
      facts={facts.length > 0 ? facts : undefined}
      advanced={
        receipt ? { ids: [{ label: `${noun} id`, value: id }] } : undefined
      }
    />
  );
}
