"use client";

import { Chip } from "@heroui/react";
import { Bot, KeyRound, LogIn, type LucideIcon } from "lucide-react";
import { VIA_LABEL, type AppVia } from "./app-inventory";

const VIA_ICON: Record<AppVia, LucideIcon> = {
  key: KeyRound,
  "sign-in": LogIn,
  mcp: Bot,
};

/**
 * "How it connects" — a NEUTRAL chip on purpose: the model is a fact about
 * the app, not a state, so it never borrows a status colour.
 */
export function ViaChip({ via }: { via: AppVia }) {
  const Icon = VIA_ICON[via];
  return (
    <Chip
      size="sm"
      radius="sm"
      variant="flat"
      className="bg-foreground/[0.05] text-foreground/75 ring-1 ring-inset ring-foreground/10"
      startContent={<Icon className="ml-1 h-3 w-3" aria-hidden />}
    >
      {VIA_LABEL[via]}
    </Chip>
  );
}
