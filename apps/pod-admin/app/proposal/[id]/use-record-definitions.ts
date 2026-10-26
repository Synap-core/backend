"use client";

/**
 * The property definitions that NAME the fields of the record(s) a proposal
 * creates or changes — the kind's own labels and types, read through the
 * reader's own access (`profiles.get` for a kind; `entities.get` with its
 * profile for an existing record).
 *
 * Definitions only NAME and TYPE fields; they never decide which fields show.
 * A read that fails or is still in flight leaves every field on the card,
 * labelled from its key — a reviewer is never shown less of the change because
 * a schema read did not answer.
 */

import type { EffectivePropertyDef } from "@synap-core/types/property-render";
import { trpc } from "../../../lib/trpc";
import { isUuid } from "../../../lib/format";
import {
  definitionsOf,
  type WirePropertyDef,
} from "../../_lib/object/property-definitions";

type WithDefs = { effectiveProperties?: WirePropertyDef[] } | undefined;

export function useRecordDefinitions({
  createKind,
  targetEntityId,
  graphKinds,
}: {
  /** A single create's kind (`profileSlug`). */
  createKind: string | null;
  /** An update/delete of an existing entity. */
  targetEntityId: string | null;
  /** A capture graph's kinds, one read each. */
  graphKinds: readonly string[];
}): {
  definitions: EffectivePropertyDef[] | undefined;
  /** The existing record's kind, when its read answered. */
  targetKind: string | null;
  definitionsFor: (kind: string) => EffectivePropertyDef[] | undefined;
} {
  const kindRead = trpc.profiles.get.useQuery(
    { identifier: createKind ?? "" },
    { enabled: !!createKind, retry: false }
  );
  const entityRead = trpc.entities.get.useQuery(
    { id: targetEntityId ?? "", includeProfile: true },
    {
      enabled: !!targetEntityId && isUuid(targetEntityId),
      retry: false,
    }
  );
  const graphReads = trpc.useQueries((t) =>
    graphKinds.map((kind) =>
      t.profiles.get({ identifier: kind }, { retry: false })
    )
  );

  const entityData = entityRead.data as
    | (WithDefs & {
        entity?: { profileSlug?: string | null; type?: string | null };
        profile?: { slug?: string };
      })
    | undefined;
  const byKind = new Map<string, EffectivePropertyDef[]>();
  graphKinds.forEach((kind, i) => {
    const data = graphReads[i]?.data as WithDefs;
    if (data) byKind.set(kind, definitionsOf(data.effectiveProperties));
  });

  const created = kindRead.data as WithDefs;
  return {
    definitions: createKind
      ? created && definitionsOf(created.effectiveProperties)
      : entityData && definitionsOf(entityData.effectiveProperties),
    targetKind:
      entityData?.entity?.profileSlug?.trim() ||
      entityData?.profile?.slug?.trim() ||
      null,
    definitionsFor: (kind) => byKind.get(kind),
  };
}
