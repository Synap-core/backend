"use client";

/**
 * A ```mermaid fence drawn as a diagram. The rules are in `mermaid-model.ts`:
 * mermaid runs strict, and its SVG becomes a `Blob` shown as
 * `<img src=blob:>` — never markup in the page. The object URL is revoked when
 * the diagram changes or unmounts.
 *
 * Mermaid is large, so it is imported on first use only. Until it draws (and
 * when it cannot: a syntax error, the chunk not loading) the reader sees the
 * source — never a blank block.
 */

import { useEffect, useId, useState } from "react";
import {
  diagramAlt,
  mermaidConfig,
  mermaidRenderId,
  mermaidThemeVariables,
  type ColorReader,
} from "./mermaid-model";

type DiagramState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed"; message: string };

function pageIsDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

/**
 * Reads a HeroUI colour through a hidden probe, so it resolves exactly as the
 * page draws it; the computed value is `rgb()`, which mermaid's colour maths
 * accepts.
 */
function heroColorReader(host: HTMLElement): ColorReader {
  return (name) => {
    const probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:absolute;width:0;height:0;visibility:hidden";
    probe.style.color = `hsl(var(--heroui-${name}))`;
    host.appendChild(probe);
    try {
      const value = getComputedStyle(probe).color;
      return /^rgba?\(/.test(value) ? value : null;
    } finally {
      probe.remove();
    }
  };
}

async function renderDiagram(source: string, id: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize(
    mermaidConfig(
      mermaidThemeVariables(heroColorReader(document.body), pageIsDark())
    )
  );
  // Parse first, so a syntax error throws before mermaid mounts its
  // temporary render node.
  await mermaid.parse(source);
  const { svg } = await mermaid.render(id, source);
  return svg;
}

/** Bumps when the console switches between light and dark. */
function useThemeRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const root = document.documentElement;
    let dark = pageIsDark();
    const observer = new MutationObserver(() => {
      if (pageIsDark() === dark) return;
      dark = pageIsDark();
      setRevision((n) => n + 1);
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return revision;
}

function DiagramSource({ source }: { source: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-foreground/[0.05] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-foreground/90">
      <code>{source}</code>
    </pre>
  );
}

export function MermaidFence({ source }: { source: string }) {
  const renderId = mermaidRenderId(useId());
  const themeRevision = useThemeRevision();
  const [state, setState] = useState<DiagramState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setState({ status: "loading" });
    renderDiagram(source, renderId)
      .then((svg) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        setState({ status: "ready", url });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, renderId, themeRevision]);

  if (state.status === "ready") {
    return (
      <figure className="overflow-x-auto rounded-lg bg-foreground/[0.03] px-3 py-3 ring-1 ring-inset ring-foreground/10">
        <img
          src={state.url}
          alt={diagramAlt(source)}
          className="mx-auto h-auto max-w-full"
        />
      </figure>
    );
  }
  if (state.status === "failed") {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[12.5px] text-foreground/65">
          This diagram can’t be drawn:{" "}
          <span className="break-words">{state.message.split("\n")[0]}</span>
        </p>
        <DiagramSource source={source} />
      </div>
    );
  }
  return <DiagramSource source={source} />;
}
