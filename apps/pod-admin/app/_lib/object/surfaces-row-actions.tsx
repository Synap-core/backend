"use client";

/**
 * The verbs on one row of an object's Surfaces list, behind its ⋯ menu:
 * "Copy link" (the row's shareable address) and "Detach" (only for a surface
 * attached through the `attaches` links, the one edge `surfaces.detach`
 * removes). A verb that cannot apply is left out, never disabled.
 *
 * Detach goes through the one governed door (`surfaces.detach`): it answers
 * `detached`, `proposed` (it waits for approval) or `absent` (nothing was
 * there any more); each is said as it is, and the list is read again.
 */

import { useState } from "react";
import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  addToast,
} from "@heroui/react";
import { MoreHorizontal } from "lucide-react";
import type { SurfaceAnchor } from "@synap-core/types/surfaces";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { ambientCatalogLocale } from "@synap-core/types/i18n";
import { trpc } from "../../../lib/trpc";
import { openT } from "../../open/copy";
import { surfaceRowLink, type SurfaceListRow } from "./surfaces-model";

type DetachAnswer = { status: string };

/** The receipt a detach answer reads as (never "done" for a proposal). */
export function detachReceipt(
  answer: DetachAnswer
):
  | "surfaces.detach.done"
  | "surfaces.detach.proposed"
  | "surfaces.detach.absent" {
  return answer.status === "detached"
    ? "surfaces.detach.done"
    : answer.status === "proposed"
      ? "surfaces.detach.proposed"
      : "surfaces.detach.absent";
}

export function useSurfaceRowActions(anchor: SurfaceAnchor) {
  const t = openT();
  const utils = trpc.useUtils();
  const [detaching, setDetaching] = useState<string | null>(null);
  const mutation = trpc.surfaces.detach.useMutation();

  const copyLink = async (row: SurfaceListRow) => {
    const link = surfaceRowLink(row, window.location.origin);
    try {
      if (!link) throw new Error("no link");
      await navigator.clipboard.writeText(link);
      addToast({ title: t("surfaces.linkCopied"), color: "default" });
    } catch {
      // A rejected clipboard write never says "Copied".
      addToast({ title: t("surfaces.copyFailed"), color: "danger" });
    }
  };

  const detach = (row: SurfaceListRow, title: string, onDone?: () => void) => {
    if (!row.detach) return;
    setDetaching(row.key);
    mutation.mutate(
      { anchor: { kind: anchor.kind, id: anchor.id }, surface: row.detach },
      {
        onSuccess: (answer) => {
          addToast({
            title: t(detachReceipt(answer as DetachAnswer), { title }),
            color: "default",
          });
        },
        onError: () => {
          addToast({
            title: t("surfaces.detach.failed", { title }),
            color: "danger",
          });
        },
        onSettled: () => {
          setDetaching(null);
          onDone?.();
          void utils.surfaces.forObject.invalidate({
            kind: anchor.kind,
            id: anchor.id,
          });
        },
      }
    );
  };

  return { copyLink, detach, detaching };
}

export function SurfaceRowMenu({
  row,
  title,
  onCopyLink,
  onDetach,
}: {
  row: SurfaceListRow;
  title: string;
  onCopyLink: () => void;
  onDetach: () => void;
}) {
  const t = openT();
  const label = t("surfaces.actions", { title });
  return (
    <Dropdown placement="bottom-end">
      <DropdownTrigger>
        <Button
          isIconOnly
          size="sm"
          variant="light"
          radius="full"
          aria-label={label}
          className="h-6 w-6 min-w-6 shrink-0 text-foreground/55"
        >
          <MoreHorizontal aria-hidden className="h-3.5 w-3.5" />
        </Button>
      </DropdownTrigger>
      <DropdownMenu aria-label={label}>
        {[
          <DropdownItem key="copy-link" onPress={onCopyLink}>
            {t("surfaces.copyLink")}
          </DropdownItem>,
          ...(row.detach
            ? [
                <DropdownItem
                  key="detach"
                  color="danger"
                  className="text-danger"
                  onPress={onDetach}
                >
                  {resolveActionLabel(
                    "detach",
                    "imperative",
                    ambientCatalogLocale()
                  )}
                  …
                </DropdownItem>,
              ]
            : []),
        ]}
      </DropdownMenu>
    </Dropdown>
  );
}
