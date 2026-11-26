"use client";

/**
 * `/open/<kind>/<id>?surface=<surfaceId>`: an object's page,
 * opened on ONE surface attached to it. The surface is read through the one
 * find door (`surfaces.forObject`, the reader's own floors) and drawn by its
 * body's own page here — a view by the view page, a document or HTML artifact
 * by the document page, a cell by the cell page — never re-drawn. A surface
 * that is no longer attached, or that the reader cannot see, says so under
 * the object's own name, with the door back to the object.
 */

import Link from "next/link";
import { Button } from "@heroui/react";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type {
  SurfaceAnchor,
  SurfacesForObject,
} from "@synap-core/types/surfaces";
import { trpc } from "../../../lib/trpc";
import { couldNotLoad, loadFailure } from "../../_lib/object/load-failure";
import { openT } from "../copy";
import { labelForOpenType, type SurfaceAnchorHostType } from "../open-params";
import { OpenFailure, OpenLoading, OpenObject } from "../open-shell";
import { CellView } from "./cell-view";
import { DocumentView } from "./document-view";
import { ViewView } from "./view-view";

/** An anchor this page opens on a surface (`SURFACE_ANCHOR_HOST_TYPES`). */
type HostedAnchor = SurfaceAnchor & { kind: SurfaceAnchorHostType };

type EntityRead = { entity?: { title?: string | null } };
type GoalRead = { name?: string | null };
type ProcessRead = { playbook?: { name?: string | null } };

/**
 * The object's own title, read through the same procedure its page reads;
 * null while it loads or when it cannot be read (the door then names the
 * object by its kind).
 */
function useAnchorTitle(anchor: HostedAnchor): string | null {
  const { kind, id } = anchor;
  const entity = trpc.entities.get.useQuery(
    { id, includeProfile: true },
    { enabled: kind === "entity", retry: false }
  );
  const session = trpc.focusSessions.get.useQuery(
    { id },
    { enabled: kind === "session", retry: false }
  );
  const goal = trpc.tracks.get.useQuery(
    { id },
    { enabled: kind === "track", retry: false }
  );
  const process = trpc.playbooks.process.useQuery(
    { playbookId: id },
    { enabled: kind === "playbook", retry: false }
  );
  const named: Record<SurfaceAnchorHostType, string | null | undefined> = {
    entity: (entity.data as EntityRead | undefined)?.entity?.title,
    session: session.data ? resolveSessionTitle(session.data as never) : null,
    track: (goal.data as GoalRead | undefined)?.name,
    playbook: (process.data as ProcessRead | undefined)?.playbook?.name,
  };
  return named[kind]?.trim() || null;
}

const BACK =
  "self-start rounded-sm text-[13px] text-foreground/70 underline decoration-foreground/25 underline-offset-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function AttachedSurfaceView({
  anchor,
  surfaceId,
}: {
  anchor: HostedAnchor;
  surfaceId: string;
}) {
  const t = openT();
  const query = trpc.surfaces.forObject.useQuery(
    { kind: anchor.kind, id: anchor.id },
    { retry: false }
  );
  const objectTitle = useAnchorTitle(anchor);
  if (query.isLoading) return <OpenLoading />;
  const fail = loadFailure(query.error, "Surface");
  if (fail || !query.data) {
    return (
      <OpenFailure
        kind={anchor.kind}
        id={anchor.id}
        failure={fail ?? couldNotLoad("Surface")}
      />
    );
  }
  const back = `/open/${encodeURIComponent(anchor.kind)}/${encodeURIComponent(anchor.id)}`;
  const noun = labelForOpenType(anchor.kind);
  const name = objectTitle ?? noun;
  const row = (query.data as SurfacesForObject).rows.find(
    (r) => r.relation === "attached" && r.id === surfaceId
  );
  if (!row) {
    // The object's own header, what happened, and the door back to it.
    return (
      <OpenObject
        header={{
          kind: anchor.kind,
          noun,
          title: name,
          summary: t("surfaces.missing"),
          status: { kind: "unknown", label: t("surfaces.notFound") },
          primaryAction: (
            <Button
              as={Link}
              href={back}
              size="sm"
              radius="md"
              variant="flat"
              color="primary"
            >
              {t("surfaces.open", { title: name })}
            </Button>
          ),
        }}
      />
    );
  }
  const body =
    row.body === "document" || row.body === "html" ? (
      <DocumentView id={row.id} />
    ) : row.body === "cell" && row.cellKey ? (
      <CellView id={row.cellKey} />
    ) : (
      <ViewView id={row.id} />
    );
  return (
    <div className="flex flex-col gap-2">
      <Link href={back} className={BACK}>
        {t("surfaces.back", { title: name })}
      </Link>
      {body}
    </div>
  );
}
