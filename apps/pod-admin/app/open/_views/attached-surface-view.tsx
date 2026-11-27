"use client";

/**
 * `/open/<kind>/<id>?surface=<surfaceId>`: an object's page,
 * opened on ONE surface attached to it. The surface is read through the one
 * find door (`surfaces.forObject`, the reader's own floors) and drawn by its
 * body's own page here (a view by the view page, a document or HTML artifact
 * by the document page, a cell by the cell page), never re-drawn. That page's
 * header carries the way back: its trail starts at the object.
 *
 * A surface that is no longer attached, or that the reader cannot see, is
 * the thing that is missing, not the object: the page keeps the object's own
 * header (no "not found" mark on it), says the surface no longer exists here,
 * and its one action opens the object by name.
 */

import Link from "next/link";
import { Button } from "@heroui/react";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  resolveObjectNoun,
  type ProfileIdentityInput,
} from "@synap-core/types/vocabulary";
import type {
  SurfaceAnchor,
  SurfacesForObject,
} from "@synap-core/types/surfaces";
import { trpc } from "../../../lib/trpc";
import { couldNotLoad, loadFailure } from "../../_lib/object/load-failure";
import type { ObjectCrumb } from "../../_lib/object/object-header";
import { openT } from "../copy";
import { labelForOpenType, type SurfaceAnchorHostType } from "../open-params";
import { OpenFailure, OpenLoading, OpenObject } from "../open-shell";
import { CellView } from "./cell-view";
import { DocumentView } from "./document-view";
import { ViewView } from "./view-view";

/** An anchor this page opens on a surface (`SURFACE_ANCHOR_HOST_TYPES`). */
type HostedAnchor = SurfaceAnchor & { kind: SurfaceAnchorHostType };

type EntityRead = {
  entity?: { title?: string | null; profileSlug?: string | null };
  profile?: {
    slug?: string;
    displayName?: string;
    uiHints?: { icon?: string | null; color?: string | null } | null;
  };
};
type GoalRead = { name?: string | null };
type ProcessRead = { playbook?: { name?: string | null } };

interface AnchorIdentity {
  /** True while the object's own read is in flight. */
  loading: boolean;
  /** Its own title; null when it has none or cannot be read. */
  title: string | null;
  /** The kind its icon is drawn for (an entity's profile). */
  kind: string;
  profile: ProfileIdentityInput | null;
  /** The noun it reads as: a person, a goal. Never "entity". */
  noun: string;
}

/**
 * The object's own name and noun, read through the same procedure its page
 * reads. An entity reads as its profile ("Person", "Task"), never as
 * "Entity"; one with no profile reads as an item.
 */
function useAnchorIdentity(anchor: HostedAnchor): AnchorIdentity {
  const t = openT();
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
  const read = { entity, session, track: goal, playbook: process }[kind];
  const named: Record<SurfaceAnchorHostType, string | null | undefined> = {
    entity: (entity.data as EntityRead | undefined)?.entity?.title,
    session: session.data ? resolveSessionTitle(session.data as never) : null,
    track: (goal.data as GoalRead | undefined)?.name,
    playbook: (process.data as ProcessRead | undefined)?.playbook?.name,
  };
  const title = named[kind]?.trim() || null;
  if (kind !== "entity") {
    return {
      loading: read.isLoading,
      title,
      kind,
      profile: null,
      noun: labelForOpenType(kind),
    };
  }
  const data = entity.data as EntityRead | undefined;
  const slug =
    data?.entity?.profileSlug?.trim() || data?.profile?.slug?.trim() || null;
  return {
    loading: read.isLoading,
    title,
    kind: slug ?? kind,
    profile:
      slug && data?.profile ? { slug, uiHints: data.profile.uiHints } : null,
    noun:
      data?.profile?.displayName?.trim() ||
      (slug ? resolveObjectNoun(slug) : t("surfaces.item")),
  };
}

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
  const object = useAnchorIdentity(anchor);
  // Wait for the object's own name too, so the page never renames itself.
  if (query.isLoading || object.loading) return <OpenLoading />;
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
  const name = object.title ?? object.noun;
  const row = (query.data as SurfacesForObject).rows.find(
    (r) => r.relation === "attached" && r.id === surfaceId
  );
  if (!row) {
    // The object is here; the surface is what is missing. No state mark on
    // the object's header: a mark is read before the sentence.
    return (
      <OpenObject
        header={{
          kind: object.kind,
          profile: object.profile,
          noun: object.noun,
          title: name,
          summary: t("surfaces.missing"),
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
  // The one way back: the body page's own trail starts at the object.
  const breadcrumb: ObjectCrumb[] = [
    { label: name, href: back },
    { label: row.title.trim() || t("surfaces.untitled") },
  ];
  return row.body === "document" || row.body === "html" ? (
    <DocumentView id={row.id} breadcrumb={breadcrumb} />
  ) : row.body === "cell" && row.cellKey ? (
    <CellView id={row.cellKey} breadcrumb={breadcrumb} />
  ) : (
    <ViewView id={row.id} breadcrumb={breadcrumb} />
  );
}
