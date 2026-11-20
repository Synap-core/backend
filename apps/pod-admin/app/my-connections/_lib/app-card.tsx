"use client";

/**
 * One app on Connected (`/my-connections`), moved out of the page so the row
 * is tested and captured on its own. A pod app whose old pairs do not fit one
 * access (W3d `pod_app.reconsent`, Q3) wears "Needs your review"; its reach
 * reads the v2 access when the pod sends it (projects included).
 */

import Link from "next/link";
import { Button, Card, CardBody, Chip } from "@heroui/react";
import { Ban } from "lucide-react";
import { HostName } from "../../_lib/host-name";
import { formatRelative } from "../../../lib/format";
import { appHolderAccess, appMode } from "@synap-core/types/apps/app-view";
import {
  resolveAppConnection,
  resolveConnectionAction,
} from "@synap-core/types/membrane";
import { summarizeAppAccessProposal } from "@synap-core/types/proposals/intent";
import { chipColor, type AppRow } from "../../apps/_lib/app-view";
import {
  accessOfNamed,
  namesOfNamed,
  type NamedAppAccess,
} from "../../oauth/consent/consent-access";
import { consentT } from "../../oauth/consent/copy";
import {
  approvalSentence,
  podAppOf,
  POD_APP_ACCESS_LINE,
  tierLabel,
} from "../../apps/_lib/pod-app-view";

/** A v2 access in the card's words: one phrase per tier and place. */
export function accessSentence(
  appName: string,
  access: NamedAppAccess
): string {
  return summarizeAppAccessProposal({
    appName,
    access: accessOfNamed(access),
    names: namesOfNamed(access),
  })
    .lines.map((l) => l.text)
    .join(" · ");
}

/**
 * One app. The whole row is a DOOR to `/apps/[public_id]` — the name is the
 * real link (its accessible name), stretched over the card; Revoke is the one
 * control that stays above the overlay. A revoked app renders read-only.
 */
export function AppCard({
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
          {pod?.reconsent && !app.revoked_at ? (
            // Its old pairs do not fit one access (Q3): a mark, and its page
            // shows the proposed form with Confirm.
            // Ink on the tinted fill: HeroUI's tone-coloured text on its own
            // /20 fill fails 4.5:1 (axe, light and dark).
            <Chip
              size="sm"
              variant="flat"
              color="warning"
              className="shrink-0"
              classNames={{ content: "text-foreground" }}
            >
              {consentT()("connected.needsReview")}
            </Chip>
          ) : view.showChip ? (
            <Chip
              size="sm"
              variant="flat"
              color={chipColor(view.tone)}
              className="shrink-0"
              classNames={{ content: "text-foreground" }}
            >
              {view.label}
            </Chip>
          ) : null}
        </div>

        <p className="text-xs text-foreground/70">
          {pod && !app.revoked_at
            ? pod.access
              ? // The v2 access (W3d) when the pod sends it: projects included.
                accessSentence(app.name, pod.access)
              : approvalSentence(pod.approved)
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
