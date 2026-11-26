"use client";

/**
 * `/open/<kind>/<id>?surface=<surfaceId>` (Surfaces P3): an object's page,
 * opened on ONE surface attached to it. The surface is read through the one
 * find door (`surfaces.forObject`, the reader's own floors) and drawn by its
 * body's own page here — a view by the view page, a document or HTML artifact
 * by the document page, a cell by the cell page — never re-drawn. A surface
 * that is no longer attached, or that the reader cannot see, says so with the
 * way back to the object.
 */

import Link from "next/link";
import type {
  SurfaceAnchor,
  SurfacesForObject,
} from "@synap-core/types/surfaces";
import { trpc } from "../../../lib/trpc";
import { couldNotLoad, loadFailure } from "../../_lib/object/load-failure";
import { openT } from "../copy";
import { OpenFailure, OpenLoading, OpenMessage } from "../open-shell";
import { CellView } from "./cell-view";
import { DocumentView } from "./document-view";
import { ViewView } from "./view-view";

export function AttachedSurfaceView({
  anchor,
  surfaceId,
}: {
  anchor: SurfaceAnchor;
  surfaceId: string;
}) {
  const t = openT();
  const query = trpc.surfaces.forObject.useQuery(
    { kind: anchor.kind, id: anchor.id },
    { retry: false }
  );
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
  const row = (query.data as SurfacesForObject).rows.find(
    (r) => r.relation === "attached" && r.id === surfaceId
  );
  if (!row) {
    return (
      <OpenMessage
        kind={anchor.kind}
        title={t("surfaces.title")}
        message={t("surfaces.missing")}
        chip={t("surfaces.title")}
        appLink={{ type: anchor.kind, id: anchor.id }}
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
      <Link
        href={back}
        className="self-start text-[13px] text-foreground/70 underline decoration-foreground/25 underline-offset-2 hover:text-foreground"
      >
        {t("surfaces.back")}
      </Link>
      {body}
    </div>
  );
}
