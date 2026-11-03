/**
 * The one write-mode choice (`/device` and the agent page), rendered with
 * react-dom/server (pod-admin's vitest runs in node, no DOM).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AGENT_WRITE_MODE_CHOICES,
  AGENT_WRITE_MODE_LINE,
} from "@synap-core/types/agents";
import { WriteModeChoice } from "./write-mode-choice";

const noop = () => {};

describe("WriteModeChoice", () => {
  it("draws THE list's names and sentences", () => {
    const html = renderToStaticMarkup(
      <WriteModeChoice value="ask-first" onChange={noop} label="How" />
    );
    for (const c of AGENT_WRITE_MODE_CHOICES.filter(
      (c) => c.recommended || c.mode === "ask-first"
    )) {
      expect(html).toContain(c.label);
      expect(html).toContain(c.line);
    }
  });

  it("says what a choice does on THIS pod when the page passes it", () => {
    const html = renderToStaticMarkup(
      <WriteModeChoice
        value="pod-default"
        onChange={noop}
        label="How"
        lines={{ "pod-default": AGENT_WRITE_MODE_LINE["ask-first"] }}
      />
    );
    expect(html).toContain(AGENT_WRITE_MODE_LINE["ask-first"]);
    expect(html).not.toContain(AGENT_WRITE_MODE_LINE["pod-default"]);
  });
});
