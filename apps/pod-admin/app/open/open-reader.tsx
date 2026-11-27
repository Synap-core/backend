"use client";

/**
 * `OpenReader` — big content on `/open/<type>/<id>` read in the whole window
 * (founder, 27 Nov 2026), instead of inside the receiver card: a view, a
 * bento, a whiteboard, a document, an HTML page. Which objects read here is
 * decided ONCE, in `reader-model.ts`; every other object and every other state
 * keeps the card (`open-shell.tsx`).
 *
 *   bar   left: the Synap mark (Home, only for a member or an admin:
 *         `canGoHome`), then the title and its kind noun. Right: Share (copy
 *         this page's link), the page's own doors ("Open in app"), and ⋯.
 *         The title is never a door: the mark is.
 *   ⋯     what the card showed around the content: its facts, who is signed
 *         in and on which pod, and Advanced; a view's sentence too. Below `sm`
 *         it also holds Share and the doors, which leave the bar to the title.
 *         A document's sentence stays in sight, one quiet line above its
 *         body: it says whether this is the document or a copy of a live one
 *         (founder Q8, 3 Nov 2026), which a reader must not have to dig for.
 *   body  the rest of the window, owning its scroll: no card, no box inside a
 *         box, no second scrollbar. A view fills the width; a document reads
 *         at the document frame (page grammar §2).
 *
 * Keyboard: the bar's order is mark → actions → ⋯ (the title is text); the ⋯
 * popover closes on Esc and gives focus back to its button (React Aria).
 */

import { useEffect, useState } from "react";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { MoreHorizontal } from "lucide-react";
import { StatusPill } from "../(admin)/components/status-pill";
import { CopyButton } from "../_lib/copy-button";
import { HostName } from "../_lib/host-name";
import { SynapLockup } from "../_lib/brand/synap-mark";
import { useReceiverIdentity } from "../_lib/receiver-shell";
import { AdvancedPanel } from "../_lib/object/advanced-panel";
import { FactsGrid } from "../_lib/object/facts-grid";
import { kindLabel } from "../_lib/object/kind-icon";
import type { ObjectPageProps } from "../_lib/object/object-page";
import { FillBottomGapContext } from "../_lib/object/content/module-frame";
import { navHref } from "../../lib/console-nav";
import { openT } from "./copy";
import {
  READER_FILL_BOTTOM_GAP,
  readerBodyClass,
  type ReaderLayout,
} from "./reader-model";

/** This page's own address, read once mounted (there is no window on the server). */
function usePageHref(): string {
  const [href, setHref] = useState("");
  useEffect(() => setHref(window.location.href), []);
  return href;
}

export function OpenReader({
  layout,
  header,
  facts,
  advanced,
  children,
}: Pick<ObjectPageProps, "header" | "facts" | "advanced" | "children"> & {
  layout: ReaderLayout;
}) {
  const t = openT();
  const { podHost, identity, canGoHome } = useReceiverIdentity();
  const href = usePageHref();
  const noun = header.noun ?? kindLabel(header.kind);
  const doors =
    header.primaryAction || header.secondaryActions ? (
      <>
        {header.primaryAction}
        {header.secondaryActions}
      </>
    ) : null;
  const share = (
    <CopyButton
      text={href}
      label={t("reader.share")}
      copiedLabel={t("reader.shareCopied")}
      ariaLabel={t("reader.share.aria")}
      variant="light"
    />
  );
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-foreground/[0.06] px-3 sm:gap-3 sm:px-4">
        <SynapLockup
          href={canGoHome ? navHref("home") : undefined}
          compactWordmark
        />
        <span aria-hidden className="h-4 w-px shrink-0 bg-foreground/10" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="min-w-0 truncate text-[14px] font-medium text-foreground">
            {header.title}
          </h1>
          {header.title !== noun && (
            <span className="hidden shrink-0 text-[12.5px] text-foreground/60 sm:inline">
              {noun}
            </span>
          )}
          {header.status && (
            <StatusPill
              kind={header.status.kind}
              label={header.status.label}
              icon={header.status.icon}
              className="shrink-0"
            />
          )}
        </div>
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          {share}
          {doors}
        </div>
        <Popover placement="bottom-end">
          <PopoverTrigger>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              radius="md"
              aria-label={t("reader.more.aria", { title: header.title })}
              className="shrink-0"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="min-w-[260px] max-w-[min(92vw,420px)] p-0">
            <div className="flex w-full flex-col gap-4 p-4">
              <div className="flex flex-wrap items-center gap-2 sm:hidden">
                {share}
                {doors}
              </div>
              {header.summary && layout === "fill" && (
                <p className="text-[13px] leading-relaxed text-foreground/70">
                  {header.summary}
                </p>
              )}
              {facts && facts.length > 0 && (
                <FactsGrid facts={facts} columns={2} />
              )}
              {(podHost || identity) && (
                <div className="flex flex-col gap-1 border-t border-foreground/[0.06] pt-3 text-[12px] text-foreground/65">
                  {podHost && <HostName host={podHost} />}
                  {identity && (
                    <span className="truncate">
                      {t("reader.signedInAs", { who: identity })}
                    </span>
                  )}
                </div>
              )}
              {advanced && (
                <div className="border-t border-foreground/[0.06]">
                  <AdvancedPanel {...advanced} />
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </header>
      <main className="min-h-0 flex-1 overflow-auto" data-reader={layout}>
        <div className={readerBodyClass(layout)}>
          {layout === "fill" ? (
            <FillBottomGapContext.Provider value={READER_FILL_BOTTOM_GAP}>
              {children}
            </FillBottomGapContext.Provider>
          ) : (
            <>
              {header.summary && (
                <p className="mb-4 text-[13px] leading-relaxed text-foreground/65">
                  {header.summary}
                </p>
              )}
              {children}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
