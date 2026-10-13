"use client";

/**
 * `/open/entity/:id` — one entity, read-only, through the shared skin.
 *
 * The fields are the SHARED plan (`planEntityFields`): status first, the 3–6
 * primary facts in view, the rest behind "More fields". Only DECLARED
 * properties are planned — with no schema nothing is dumped, so an undeclared
 * key holding a secret can never leak as a string — and `FieldList` never
 * draws a secret or a bare entity reference.
 *
 * `entities.get` re-checks access server-side; no admin role is involved.
 */

import { Chip } from "@heroui/react";
import {
  planEntityFields,
  type EffectivePropertyDef,
} from "@synap-core/types/property-render";
import { trpc } from "../../../lib/trpc";
import { formatRelative } from "../../../lib/format";
import { FieldList } from "../../_lib/object/field-list";
import {
  couldNotLoad,
  entitySummary,
  loadFailure,
  redactSecretProperties,
} from "../open-model";
import {
  OpenFailure,
  OpenInAppLink,
  OpenLoading,
  OpenObject,
} from "../open-shell";
import { useReauthOnUnauthorized } from "./use-reauth";

/** The slice of `entities.get({ includeProfile: true })` this page reads. */
type EntityPayload = {
  entity?: {
    id?: string;
    title?: string | null;
    type?: string | null;
    profileSlug?: string | null;
    preview?: string | null;
    description?: string | null;
    workspaceId?: string | null;
    properties?: Record<string, unknown> | null;
    updatedAt?: Date | string | null;
    facetSlugs?: string[];
  };
  profile?: {
    slug?: string;
    displayName?: string;
    uiHints?: { icon?: string | null; color?: string | null } | null;
  };
  effectiveProperties?: Array<{
    id?: string;
    slug?: string;
    valueType?: string;
    constraints?: Record<string, unknown> | null;
    displayOrder?: number;
    uiHints?: Record<string, unknown> | null;
  }>;
  facets?: Array<{ profile?: Record<string, unknown> }>;
};

/** Wire defs → the planner's shape; a def with no slug is not a field. */
function definitionsOf(data: EntityPayload): EffectivePropertyDef[] {
  return (data.effectiveProperties ?? []).flatMap((d) =>
    d.slug
      ? [
          {
            id: d.id ?? d.slug,
            slug: d.slug,
            valueType: d.valueType ?? "string",
            constraints: d.constraints ?? null,
            uiHints: d.uiHints ?? null,
            displayOrder: d.displayOrder,
          },
        ]
      : []
  );
}

function roleSlugs(data: EntityPayload): string[] {
  const slugs = new Set<string>();
  for (const slug of data.entity?.facetSlugs ?? []) if (slug) slugs.add(slug);
  for (const row of data.facets ?? []) {
    const slug = row.profile?.slug;
    if (typeof slug === "string" && slug) slugs.add(slug);
  }
  return [...slugs];
}

export function EntityView({ id }: { id: string }) {
  const query = trpc.entities.get.useQuery({ id, includeProfile: true });
  useReauthOnUnauthorized(query.error);

  if (query.isLoading) return <OpenLoading label="Loading entity…" />;
  const data = query.data as EntityPayload | undefined;
  const fail = loadFailure(query.error, "Entity");
  if (fail || !data?.entity) {
    return (
      <OpenFailure
        kind="entity"
        id={id}
        failure={fail ?? couldNotLoad("Entity")}
      />
    );
  }

  const entity = data.entity;
  const title = entity.title?.trim() || "Untitled";
  // The header speaks as the entity's KIND (a task draws a task's icon and
  // noun); the profile's own name and icon win where it has them.
  const profileSlug =
    entity.profileSlug?.trim() ||
    entity.type?.trim() ||
    data.profile?.slug?.trim() ||
    "entity";
  const noun = data.profile?.displayName?.trim() || undefined;
  const summary = entitySummary(entity);
  const definitions = definitionsOf(data);
  const properties = entity.properties ?? {};
  const plan = planEntityFields({
    definitions,
    values: properties,
    header: { title },
  });
  const roles = roleSlugs(data);

  return (
    <OpenObject
      header={{
        kind: profileSlug,
        profile: data.profile
          ? { slug: profileSlug, uiHints: data.profile.uiHints }
          : null,
        noun,
        title,
        summary: summary.text,
        primaryAction: <OpenInAppLink type="entity" id={id} />,
      }}
      facts={
        entity.updatedAt
          ? [{ label: "Updated", value: formatRelative(entity.updatedAt) }]
          : undefined
      }
      advanced={{
        ids: [
          { label: "Entity id", value: entity.id ?? id },
          ...(entity.workspaceId
            ? [{ label: "Space id", value: entity.workspaceId }]
            : []),
        ],
        raw: {
          ...entity,
          properties: redactSecretProperties(properties, definitions),
        },
      }}
    >
      {roles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {roles.map((slug) => (
            <Chip
              key={slug}
              size="sm"
              variant="flat"
              className="text-foreground/65"
            >
              {slug}
            </Chip>
          ))}
        </div>
      )}
      <FieldList
        plan={plan}
        omit={summary.propertySlug ? [summary.propertySlug] : undefined}
      />
    </OpenObject>
  );
}
