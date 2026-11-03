/**
 * A why that holds a shell line shows it in its own wrapping, selectable
 * monospace block; a plain why stays a paragraph. The LinkedIn import ask
 * (3 Nov 2026) put a curl line with a 70-character URL in `why`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AskContext, splitContextCommand } from "./ask-context";

const WHY =
  "The import door needs your full-access key ('*', no limit): the agent key got 403 GRANT_DOOR_UNSUPPORTED. curl -X POST -H 'Authorization: Bearer <key>' -d '{}' https://pod.example.live/api/hub/messaging/accounts/ab60de0b-1b95-4346-aa4e-7af67d8a63be/import-history";

describe("splitContextCommand", () => {
  it("splits the words from the curl line", () => {
    const parts = splitContextCommand(WHY);
    expect(parts.prose).toMatch(/GRANT_DOOR_UNSUPPORTED\.$/);
    expect(parts.command).toMatch(/^curl -X POST .*\/import-history$/);
  });

  it("leaves a why with no command as prose", () => {
    expect(splitContextCommand("The launch post needs a date.")).toEqual({
      prose: "The launch post needs a date.",
      command: null,
    });
  });

  it("does not take the word curl in a sentence for a command", () => {
    expect(splitContextCommand("Use curl to test it.").command).toBeNull();
  });

  it("takes a $ prompt line, dropping the prompt", () => {
    expect(splitContextCommand("Run this: $ pnpm install").command).toBe(
      "pnpm install"
    );
  });
});

describe("AskContext", () => {
  it("draws the command in a wrapping, selectable monospace block", () => {
    const html = renderToStaticMarkup(<AskContext context={WHY} />);
    expect(html).toMatch(/<pre[^>]*data-ask-command[^>]*>curl -X POST/);
    expect(html).toContain("break-all");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("font-mono");
  });

  it("draws a plain why as one paragraph, no block", () => {
    const html = renderToStaticMarkup(
      <AskContext context="The launch post needs a date." />
    );
    expect(html).not.toContain("<pre");
    expect(html).toContain("The launch post needs a date.");
  });
});

describe("the ask card draws its why through AskContext", () => {
  const source = readFileSync(
    new URL("./ask-answer.tsx", import.meta.url),
    "utf8"
  );

  it("renders view.context with AskContext, never as a bare paragraph", () => {
    expect(source).toMatch(/<AskContext context=\{view\.context\} \/>/);
    expect(source).not.toMatch(/\{view\.context\}\s*<\/p>/);
  });
});
