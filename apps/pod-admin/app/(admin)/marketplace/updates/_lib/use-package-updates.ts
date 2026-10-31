"use client";

/**
 * Every read and write of `packageUpdates.*` pod admin makes, behind one set
 * of hooks. The list, the Review page and the package page all read the list
 * through `usePackageUpdateList`, one query, so they can never count
 * differently (ui-composition §11). After any write the whole router is read
 * again: the list, every plan, and the history.
 */

import { useMutation } from "@tanstack/react-query";
import { trpc } from "../../../../../lib/trpc";
import type { PackageUpdateRowKind } from "./contract";

/** Every installed package compared with the catalog, one row each. */
export function usePackageUpdateList({
  enabled = true,
}: { enabled?: boolean } = {}) {
  return trpc.packageUpdates.list.useQuery(undefined, {
    enabled,
    staleTime: 60_000,
    // A pod that said no will say no again; the failed state has its retry.
    retry: false,
  });
}

/** One update, field by field (`packageUpdates.get`). */
export function usePackageUpdatePlan(
  slug: string,
  { enabled = true }: { enabled?: boolean } = {}
) {
  return trpc.packageUpdates.get.useQuery(
    { slug },
    { enabled: enabled && !!slug, retry: false }
  );
}

export function useApplyPackageUpdate() {
  const utils = trpc.useUtils();
  // `applyUpdate`: tRPC reserves `apply` as a procedure name.
  return trpc.packageUpdates.applyUpdate.useMutation({
    onSettled: () => utils.packageUpdates.invalidate(),
  });
}

export function useUndoPackageUpdate() {
  const utils = trpc.useUtils();
  return trpc.packageUpdates.undo.useMutation({
    onSettled: () => utils.packageUpdates.invalidate(),
  });
}

/** One installed row "Stop updates" detaches (`packageUpdates.detach`). */
export interface DetachRow {
  rowKind: PackageUpdateRowKind;
  rowId: string;
}

/**
 * "Stop updates": every installed row of the package becomes fully the
 * person's (the pod detaches one row at a time). A failure stops at that row
 * and throws: the rows before it are detached, and the list read again says
 * which.
 */
export function useDetachPackage() {
  const utils = trpc.useUtils();
  return useMutation({
    mutationFn: async (rows: readonly DetachRow[]) => {
      for (const row of rows) {
        await utils.client.packageUpdates.detach.mutate({
          kind: row.rowKind,
          id: row.rowId,
        });
      }
    },
    onSettled: () => utils.packageUpdates.invalidate(),
  });
}
