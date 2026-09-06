"use client";

/**
 * `HandoffCard` — what pod-admin renders where it deliberately stops.
 *
 * pod-admin is the pod's front desk. Plenty of things it can NAME it cannot
 * OWN: connector re-auth, the secrets vault, per-kind package installs, the
 * intelligence service config. Before 2026-09-05 those places rendered the
 * full frame — a section, a row, a button — with the button permanently
 * `isDisabled` behind a tooltip naming the tRPC procedure nobody had written
 * ("Pending: connectors.reauthenticate"). Five surfaces did this.
 *
 * A disabled button teaches "this app is broken". A handoff teaches "this
 * lives over there" — which is true, useful, and the whole product story of a
 * pod that is one surface among several.
 *
 * So: never render a dead control. Render this instead, and say plainly where
 * the capability actually lives.
 *
 * `exit` comes from `openIn()` — the one door. When it resolves to a
 * `synap://` link the fallback is rendered automatically, because a desktop
 * link that does not resolve fails silently and would strand the reader.
 */

import { Button } from "@heroui/react";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import type { Exit } from "../../../lib/open-in";

interface HandoffCardProps {
  /** What lives elsewhere, phrased as a statement of fact. */
  title: string;
  /** Why it lives there, and what the reader will find. One or two sentences. */
  body: string;
  /** The resolved destination. */
  exit: Exit;
  /** Imperative label for the primary action, e.g. "Open Connectors settings". */
  cta: string;
  icon?: LucideIcon;
  /** `inline` sits inside an existing SectionCard; `block` stands alone. */
  variant?: "inline" | "block";
}

export function HandoffCard({
  title,
  body,
  exit,
  cta,
  icon: Icon,
  variant = "inline",
}: HandoffCardProps) {
  return (
    <div
      className={[
        "flex flex-col gap-3 rounded-lg px-4 py-4",
        variant === "block"
          ? "bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10"
          : "bg-content2/40 ring-1 ring-inset ring-foreground/[0.06]",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        {Icon && (
          <Icon
            className="mt-0.5 h-4 w-4 shrink-0 text-foreground/45"
            strokeWidth={2}
            aria-hidden
          />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[13px] font-medium text-foreground">{title}</p>
          <p className="text-[12.5px] leading-relaxed text-foreground/60">
            {body}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-0 sm:pl-7">
        <Button
          as="a"
          href={exit.href}
          {...(exit.isDesktopLink
            ? {}
            : { target: "_blank", rel: "noopener noreferrer" })}
          size="sm"
          radius="md"
          variant="flat"
          endContent={<ArrowUpRight className="h-3.5 w-3.5" />}
        >
          {cta}
        </Button>

        {/* A `synap://` href does nothing at all when the app isn't installed —
            the browser shows no error. This is the way out of that silence. */}
        {exit.fallback && (
          <a
            href={exit.fallback.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] text-foreground/50 underline-offset-2 transition-colors hover:text-foreground/80 hover:underline"
          >
            {exit.fallback.label}
          </a>
        )}
      </div>
    </div>
  );
}
