"use client";

/**
 * One `:::synap-*` embed, drawn from the shared embed model
 * (`describeEmbed`, `@synap-core/types/renderables`) — the console decides
 * nothing about what an embed IS, only how it looks here.
 *
 *   chart-snapshot  the chart, drawn from its numbers (`embed-chart`)
 *   chart-broken    a visible error row with the reason — never an empty chart
 *   entity          a card that opens the record's console page; its title
 *                   only when the reader's own read returns it
 *   view            a chip that opens the view's console page
 *   chart-live, cell-frame, cell-builtin, unknown
 *                   a quiet chip naming it + the object's "Open in app"
 *   broken          says the embed names nothing
 *
 * A sandboxed cell is NEVER mounted here: no iframe, no script, nothing in
 * content runs. The author's fallback prose stays visible under every block.
 */

import { useContext, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, BarChart3, Lock, type LucideIcon } from "lucide-react";
import type { Embed } from "@synap-core/markdown-core";
import { describeEmbed, type EmbedModel } from "@synap-core/types/renderables";
import {
  nounInSentence,
  resolveEmbedWords,
  type EmbedWords,
} from "@synap-core/types/vocabulary";
import { kindIcon } from "../kind-icon";
import { ChartSnapshot } from "./embed-chart";
import { EmbedHostContext, type EmbedHost } from "./embed-context";
import { objectPage, type EmbedEntityRead } from "./markdown-model";

const CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-md bg-foreground/[0.05] px-2 py-1 text-[12.5px] text-foreground/80 ring-1 ring-inset ring-foreground/10";
const DOOR =
  "underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

function embedModelOf(embed: Embed): EmbedModel {
  return describeEmbed({
    kind: embed.kind,
    attrs: embed.ref,
    props: embed.props,
    propsError: embed.propsError,
  });
}

function iconFor(model: EmbedModel): LucideIcon {
  switch (model.kind) {
    case "chart-snapshot":
    case "chart-broken":
    case "chart-live":
      return BarChart3;
    case "entity":
      return kindIcon("entity");
    case "view":
      return kindIcon("view");
    default:
      return kindIcon("cell");
  }
}

/** "Line Chart · Live chart" — the label, then what kind of thing it is. */
function chipMark(model: EmbedModel, words: EmbedWords): string {
  return model.kind === "chart-live"
    ? `Live ${nounInSentence(words.noun)}`
    : words.noun;
}

function Chip({
  model,
  words,
  href,
}: {
  model: EmbedModel;
  words: EmbedWords;
  href?: string | null;
}) {
  const Icon = iconFor(model);
  const { label } = words;
  const mark = chipMark(model, words);
  const body = (
    <>
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{label}</span>
      {!label.toLowerCase().includes(mark.toLowerCase()) && (
        <span className="shrink-0 text-foreground/55">· {mark}</span>
      )}
    </>
  );
  return href ? (
    <Link href={href} className={`${CHIP} ${DOOR}`}>
      {body}
    </Link>
  ) : (
    <span className={CHIP}>{body}</span>
  );
}

function Note({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <p className="flex items-start gap-1.5 text-[12.5px] text-foreground/65">
      <Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// ─── Entity card ─────────────────────────────────────────────────────────────

const UNRESOLVED: EmbedEntityRead = { state: "unresolved" };

function EntityCardBody({
  model,
  words: { noun, label },
  read,
  inline,
}: {
  model: Extract<EmbedModel, { kind: "entity" }>;
  words: EmbedWords;
  read: EmbedEntityRead;
  inline: boolean;
}) {
  const href = objectPage("entity", model.id);
  const Icon = iconFor(model);
  if (read.state === "hidden" || !href) {
    // Neither the title nor which (gone / not yours) — the pod says NOT_FOUND
    // for both, and the authored label is not repeated either.
    const words = href
      ? "This isn’t visible to you, or no longer exists."
      : `This ${nounInSentence(noun)} link can’t be opened here.`;
    return inline ? (
      <span className={CHIP}>
        <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        {words}
      </span>
    ) : (
      <Note icon={Lock}>{words}</Note>
    );
  }
  if (read.state === "failed") {
    return (
      <span className={`${CHIP} flex-wrap`}>
        <AlertTriangle
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-danger"
        />
        This {nounInSentence(noun)} couldn’t be loaded.
        {read.retry && (
          <button
            type="button"
            onClick={read.retry}
            className={`font-medium text-foreground ${DOOR}`}
          >
            Try again
          </button>
        )}
      </span>
    );
  }
  if (read.state === "loading") {
    return (
      <span
        role="status"
        aria-busy="true"
        aria-label={`Loading ${nounInSentence(noun)}…`}
        className={`${CHIP} w-40`}
      >
        <span className="h-3 w-full rounded bg-foreground/[0.07] shimmer-pulse" />
      </span>
    );
  }
  const title = read.state === "ready" ? read.title : label;
  const words = (
    <>
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words font-medium text-foreground">
        {title}
      </span>
      {title !== noun && (
        <span className="shrink-0 text-foreground/55">· {noun}</span>
      )}
    </>
  );
  return inline ? (
    <Link href={href} className={`${CHIP} ${DOOR}`}>
      {words}
    </Link>
  ) : (
    <Link
      href={href}
      className={`flex max-w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] ring-1 ring-inset ring-foreground/10 hover:bg-foreground/[0.03] ${DOOR}`}
    >
      {words}
    </Link>
  );
}

type EntityCardProps = {
  model: Extract<EmbedModel, { kind: "entity" }>;
  words: EmbedWords;
  inline: boolean;
};

function EntityCardRead({
  host,
  ...props
}: EntityCardProps & { host: EmbedHost }) {
  const read = host.useEntity(props.model.id);
  return <EntityCardBody {...props} read={read} />;
}

function EntityCard(props: EntityCardProps) {
  const host = useContext(EmbedHostContext);
  return host ? (
    <EntityCardRead host={host} {...props} />
  ) : (
    <EntityCardBody {...props} read={UNRESOLVED} />
  );
}

// ─── The block ───────────────────────────────────────────────────────────────

function Head({
  model,
  words,
  inline,
}: {
  model: EmbedModel;
  words: EmbedWords;
  inline: boolean;
}) {
  const host = useContext(EmbedHostContext);
  switch (model.kind) {
    case "chart-snapshot":
      return inline ? (
        <Chip model={model} words={words} />
      ) : (
        <ChartSnapshot model={model} title={words.label} />
      );
    case "chart-broken": {
      const Tag = inline ? "span" : "p";
      return (
        <Tag
          className={`${inline ? "inline-flex" : "flex"} items-start gap-1.5 rounded-md bg-danger/10 px-2 py-1 text-[12.5px] text-foreground ring-1 ring-inset ring-danger/30`}
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger"
          />
          <span className="min-w-0 break-words">
            <span className="font-medium">{words.label}</span> can’t be drawn:{" "}
            {model.message}
          </span>
        </Tag>
      );
    }
    case "entity":
      return <EntityCard model={model} words={words} inline={inline} />;
    case "view":
      return (
        <Chip
          model={model}
          words={words}
          href={objectPage("view", model.viewId)}
        />
      );
    case "broken":
      return inline ? (
        <span className={CHIP}>
          This {nounInSentence(words.noun)} embed names nothing to show.
        </span>
      ) : (
        <Note icon={AlertTriangle}>
          This {nounInSentence(words.noun)} embed names nothing to show.
        </Note>
      );
    default:
      return (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Chip model={model} words={words} />
          {!inline && host?.openInApp}
        </span>
      );
  }
}

/**
 * `fallback` is the author's prose, already drawn by the caller (the one
 * markdown walker); it shows under the head.
 */
export function EmbedBlock({
  embed,
  inline,
  fallback,
}: {
  embed: Embed;
  inline: boolean;
  fallback: ReactNode;
}) {
  const model = embedModelOf(embed);
  const words = resolveEmbedWords(model);
  if (inline) return <Head model={model} words={words} inline />;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-embed={model.kind}>
      <Head model={model} words={words} inline={false} />
      {embed.fallback.length > 0 && (
        <div className="flex flex-col gap-2 text-foreground/80">{fallback}</div>
      )}
    </div>
  );
}
