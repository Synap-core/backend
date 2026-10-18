"use client";

/**
 * `DetailDrawer` — the canonical right-docked side panel used across every
 * Pod Admin tab.
 *
 * Phase C tabs each instantiate HeroUI `Drawer` ad-hoc; this wrapper is the
 * standardization pass. Same placement, same sizes, same backdrop, same
 * header / body / footer rhythm so a workspace drawer feels like an audit
 * drawer feels like a connector drawer.
 *
 *   placement = right
 *   size      = md
 *   backdrop  = opaque (HeroUI default — every modal and drawer shares it)
 *   classNames.base = bg-content1     (same surface as section cards)
 *
 * Header and footer stay pinned; only the body scrolls, so the decision
 * buttons in the footer never scroll out of reach on a long detail.
 *
 * Props slot in:
 *   • `title` + optional `subtitle` — header
 *   • `children`                    — body (with consistent padding)
 *   • `footer`                      — the row's actions (the header ✕ closes)
 *
 * If a tab needs a glyph in the header (e.g. event-type badge or color
 * chip), use `headerAccessory` rather than overriding the title — keeps
 * the header height predictable.
 */

import {
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
} from "@heroui/react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export interface DetailDrawerProps {
  /** Open state. */
  isOpen: boolean;
  /** Close handler — also fired when the user clicks the backdrop / Esc. */
  onClose: () => void;
  /** Header title (always shown). */
  title: string;
  /** Optional second line under the title — id, hint, mono code, etc. */
  subtitle?: ReactNode;
  /** Optional left-side header glyph (icon chip / color square). */
  headerAccessory?: ReactNode;
  /** Optional right-side header content (status pill or extra metadata). */
  headerRight?: ReactNode;
  /** Footer slot for actions. Closing is the header ✕ — no footer Close. */
  footer?: ReactNode;
  /**
   * Override the drawer width. Defaults to `md` — the brief mandates `md`
   * but the prop is here for the rare full-screen detail (e.g. proposal
   * payload preview) without forking the component.
   */
  size?: "sm" | "md" | "lg" | "xl";
  children: ReactNode;
}

export function DetailDrawer({
  isOpen,
  onClose,
  title,
  subtitle,
  headerAccessory,
  headerRight,
  footer,
  size = "md",
  children,
}: DetailDrawerProps) {
  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      placement="right"
      size={size}
      // The custom ✕ in the header replaces HeroUI's floating one.
      hideCloseButton
      classNames={{
        base: "bg-content1 overflow-hidden",
        body: "min-h-0 overflow-y-auto",
      }}
    >
      <DrawerContent>
        {(close) => (
          <>
            <DrawerHeader className="flex flex-col gap-1.5 border-b border-foreground/[0.06] px-6 py-4">
              <div className="flex items-center gap-3">
                {headerAccessory && (
                  <div className="shrink-0">{headerAccessory}</div>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[15px] font-medium text-foreground">
                    {title}
                  </span>
                  {subtitle && (
                    <span className="truncate text-[11.5px] text-foreground/65">
                      {subtitle}
                    </span>
                  )}
                </div>
                {headerRight && <div className="shrink-0">{headerRight}</div>}
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  radius="full"
                  onPress={close}
                  aria-label="Close"
                  className="shrink-0 text-foreground/55 hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </DrawerHeader>

            <DrawerBody className="px-6 py-4">{children}</DrawerBody>

            {footer && (
              <DrawerFooter className="border-t border-foreground/[0.06] px-6 py-3">
                {footer}
              </DrawerFooter>
            )}
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}
