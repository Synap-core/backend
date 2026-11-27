"use client";

/**
 * The link door of a running frame (a stored page, `html-frame`, or a module
 * cell, `module-frame`): the frame's `synap:navigate` and `synap:surface:open`
 * messages, decided by `handleFrameLink` / `handleFrameOpen`
 * (`html-frame-links.ts`), and the console's own question before another
 * site opens.
 *
 * Another site never opens on the page's word (security review H2, 27 Nov
 * 2026): a page reads the viewer's data over the bridge, and a link was the
 * one way left to carry it out. The console asks "Open a page on <host>?",
 * shows the address it will open (origin and path: the query and fragment
 * the page wrote are cut), and opens it only on the reader's click, which is
 * also what lets the browser open the tab.
 */

import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { FrameExternalLink } from "@synap-core/types/cell-bridge";
import { ConfirmModal } from "../../../(admin)/components/confirm-modal";
import {
  browserFrameLinkEnv,
  handleFrameLink,
  handleFrameOpen,
} from "./html-frame-links";
import { frameT } from "./frame-copy";

/**
 * Listens to the frame's link messages while `live`, and returns the
 * console's confirmation, to render next to the frame.
 */
export function useFrameLinkDoor(
  frameRef: RefObject<HTMLIFrameElement | null>,
  live: boolean,
  run: number
): ReactNode {
  const [asking, setAsking] = useState<FrameExternalLink | null>(null);
  const env = useMemo(() => browserFrameLinkEnv(setAsking), []);

  useEffect(() => {
    if (!live) return;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow ?? null;
      if (!handleFrameLink(event, frame, env)) {
        handleFrameOpen(event, frame, env);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef, live, run, env]);

  const t = frameT();
  return (
    <ConfirmModal
      isOpen={asking !== null}
      onClose={() => setAsking(null)}
      onConfirm={() => {
        if (asking) env.newTab(asking.href);
        setAsking(null);
      }}
      title={t("link.external.title", { host: asking?.host ?? "" })}
      consequence={
        <>
          <p>{t("link.external.body")}</p>
          <p className="mt-2 break-all font-mono text-[12px] text-foreground">
            {asking?.href}
          </p>
        </>
      }
      confirmLabel={t("link.external.open")}
      confirmColor="primary"
    />
  );
}
