/**
 * The pod's property definitions on the wire (`entities.get({ includeProfile })`
 * and `profiles.get` both return `effectiveProperties`) → the shape the shared
 * planner and classifier read (`@synap-core/types/property-render`). A def with
 * no slug is not a field.
 */

import type { EffectivePropertyDef } from "@synap-core/types/property-render";

export interface WirePropertyDef {
  id?: string;
  slug?: string;
  valueType?: string;
  constraints?: Record<string, unknown> | null;
  displayOrder?: number;
  uiHints?: Record<string, unknown> | null;
}

export function definitionsOf(
  defs: readonly WirePropertyDef[] | null | undefined
): EffectivePropertyDef[] {
  return (defs ?? []).flatMap((d) =>
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
