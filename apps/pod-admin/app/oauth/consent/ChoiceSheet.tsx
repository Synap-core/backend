"use client";

/**
 * The one floating layer of the consent's lines (design A): a popover
 * anchored to its door on a desktop, a bottom sheet on a phone (MD_UP is the
 * switch, as every pod-admin docked-vs-drawer layout). Both are HeroUI
 * overlays (react-aria): focus moves in on open, Esc closes, focus returns to
 * the door. Motion is the overlays' own: the popover scales in, the sheet
 * slides up, both fade under reduced motion (`HeroUIProvider
 * reducedMotion="user"`).
 *
 * The door is the line's ONE action (ui-composition §12): the sheet holds the
 * choices, and its footer (Done on the consent, Cancel / Save on the app page)
 * is the caller's.
 */

import type { ReactNode } from "react";
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@heroui/react";
import { X } from "lucide-react";
import { MD_UP, useMediaQuery } from "../../../lib/use-media-query";
import { consentT } from "./copy";

export interface ChoiceSheetProps {
  /** The door's words ("Review", "Change", "Pick"). */
  doorLabel: string;
  /**
   * The door's accessible name, starting with its visible words so a voice
   * user can say what they see: "Change where it can look".
   */
  doorAccessibleName: string;
  title: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  isDisabled?: boolean;
  children: ReactNode;
  /** The sheet's own buttons (Done, or Cancel / Save). */
  footer: ReactNode;
  /**
   * The live access sentence, announced from INSIDE the sheet: an open
   * overlay hides the page behind it from assistive tech (react-aria), so the
   * page's own live headline would go silent while the person changes things.
   */
  live?: string;
}

/** The door: a small flat button, one per line. */
function doorProps(p: ChoiceSheetProps) {
  return {
    size: "sm" as const,
    variant: "flat" as const,
    radius: "full" as const,
    className: "min-h-10 min-w-16 shrink-0 px-3 font-medium",
    isDisabled: p.isDisabled,
    "aria-haspopup": "dialog" as const,
    "aria-label": p.doorAccessibleName,
  };
}

export function ChoiceSheet(props: ChoiceSheetProps) {
  const desktop = useMediaQuery(MD_UP);
  const t = consentT();
  if (desktop) {
    return (
      <Popover
        isOpen={props.isOpen}
        onOpenChange={props.onOpenChange}
        placement="bottom-end"
        offset={6}
        shouldBlockScroll={false}
        classNames={{
          content:
            "min-w-[18rem] max-w-[min(26rem,calc(100vw-2rem))] items-stretch p-0",
        }}
      >
        <PopoverTrigger>
          <Button {...doorProps(props)}>{props.doorLabel}</Button>
        </PopoverTrigger>
        <PopoverContent>
          {(titleProps) => (
            <div className="flex max-h-[min(36rem,70vh)] w-full flex-col">
              <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-3">
                <h2
                  {...titleProps}
                  className="text-sm font-medium text-foreground"
                >
                  {props.title}
                </h2>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  radius="full"
                  className="min-h-10 min-w-10"
                  aria-label={t("sheet.close")}
                  onPress={() => props.onOpenChange(false)}
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
                {props.children}
                {props.live ? (
                  <p className="sr-only" aria-live="polite">
                    {props.live}
                  </p>
                ) : null}
              </div>
              <div className="flex justify-end gap-2 border-t border-foreground/10 px-4 py-3">
                {props.footer}
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <>
      <Button
        {...doorProps(props)}
        aria-expanded={props.isOpen}
        onPress={() => props.onOpenChange(true)}
      >
        {props.doorLabel}
      </Button>
      <Drawer
        isOpen={props.isOpen}
        onOpenChange={props.onOpenChange}
        placement="bottom"
        scrollBehavior="inside"
        classNames={{ base: "max-h-[85vh] rounded-b-none" }}
      >
        <DrawerContent>
          <DrawerHeader className="text-sm font-medium text-foreground">
            {props.title}
          </DrawerHeader>
          <DrawerBody className="px-4">
            {props.children}
            {props.live ? (
              <p className="sr-only" aria-live="polite">
                {props.live}
              </p>
            ) : null}
          </DrawerBody>
          <DrawerFooter className="border-t border-foreground/10 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {props.footer}
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </>
  );
}
