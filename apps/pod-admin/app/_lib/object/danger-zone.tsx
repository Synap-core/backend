"use client";

/**
 * `DangerZone` — the consequential acts on an object, at the bottom and
 * collapsed (prior-art rule: "dangerous actions at the bottom with an impact
 * preview"). Each act opens the one confirm shape, `ConfirmModal`, whose
 * consequence copy is the impact preview — what will change, and what will
 * NOT. Nothing here fires on the first click.
 */

import { useState, type ReactNode } from "react";
import { Accordion, AccordionItem, Button } from "@heroui/react";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";

export interface DangerAction {
  key: string;
  /** The button and the row's name — imperative ("Revert this session"). */
  label: string;
  /** One line under the name: when you would want this. */
  description: string;
  /** The impact preview shown in the confirm before anything happens. */
  consequence: ReactNode;
  confirmLabel: string;
  /** `warning` for reversible-but-consequential, `danger` for irreversible. */
  confirmColor?: "danger" | "warning";
  /** True while THIS act's mutation runs (scoped to the act, not shared). */
  isPending?: boolean;
  /** Resolve to close the confirm; a thrown error keeps it open. */
  onConfirm: () => Promise<unknown>;
}

export function DangerZone({
  actions,
  title = "Danger zone",
}: {
  actions: DangerAction[];
  title?: string;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (actions.length === 0) return null;
  const open = actions.find((a) => a.key === openKey) ?? null;

  return (
    <>
      <Accordion className="px-0" variant="light">
        <AccordionItem
          key="danger"
          aria-label={title}
          title={
            <span className="text-[12.5px] text-status-down">{title}</span>
          }
        >
          <ul className="flex flex-col gap-3 pb-2">
            {actions.map((action) => (
              <li
                key={action.key}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg p-3 ring-1 ring-inset ring-status-down/30"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="text-[13px] font-medium text-foreground">
                    {action.label}
                  </p>
                  <p className="text-[12px] text-foreground/65">
                    {action.description}
                  </p>
                </div>
                <Button
                  size="sm"
                  radius="md"
                  variant="flat"
                  color={action.confirmColor ?? "danger"}
                  onPress={() => setOpenKey(action.key)}
                >
                  {action.label}
                </Button>
              </li>
            ))}
          </ul>
        </AccordionItem>
      </Accordion>
      {open && (
        <ConfirmModal
          isOpen
          onClose={() => setOpenKey(null)}
          onConfirm={() => {
            open
              .onConfirm()
              .then(() => setOpenKey(null))
              // The caller surfaces the failure (its mutation's error state);
              // the confirm stays up so the reader sees it did not happen.
              .catch(() => undefined);
          }}
          title={open.label}
          consequence={open.consequence}
          confirmLabel={open.confirmLabel}
          confirmColor={open.confirmColor ?? "danger"}
          isPending={open.isPending}
        />
      )}
    </>
  );
}
