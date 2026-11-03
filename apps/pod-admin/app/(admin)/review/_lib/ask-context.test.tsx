/**
 * A why wraps inside the card and keeps its line breaks; a fenced block is a
 * command in its own selectable monospace block. The LinkedIn import ask
 * (3 Nov 2026) put a curl line with a 70-character URL in `why`; the card
 * names the why ("Why") because the steps say "in this card's why".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AskContext, contextParts } from "./ask-context";

const URL_LINE =
  "https://pod.example.live/api/hub/messaging/accounts/ab60de0b-1b95-4346-aa4e-7af67d8a63be/import-history";

describe("contextParts", () => {
  it("keeps a plain why as one text part", () => {
    expect(contextParts("The launch post needs a date.")).toEqual([
      { kind: "text", text: "The launch post needs a date." },
    ]);
  });

  it("takes a fenced block as code, the words around it as text", () => {
    expect(
      contextParts(
        `Run this:\n\`\`\`sh\ncurl -X POST ${URL_LINE}\n\`\`\`\nThen wait.`
      )
    ).toEqual([
      { kind: "text", text: "Run this:" },
      { kind: "code", text: `curl -X POST ${URL_LINE}` },
      { kind: "text", text: "Then wait." },
    ]);
  });

  it("does not take a bare curl line for code", () => {
    expect(contextParts(`curl -X POST ${URL_LINE}`)[0]?.kind).toBe("text");
  });
});

describe("AskContext", () => {
  it("wraps a long line inside the card and keeps line breaks", () => {
    const html = renderToStaticMarkup(
      <AskContext context={`See ${URL_LINE}\nthen answer.`} />
    );
    expect(html).toContain("break-words");
    expect(html).toContain("whitespace-pre-wrap");
  });

  it("draws a fenced command in a wrapping, selectable monospace block", () => {
    const html = renderToStaticMarkup(
      <AskContext context={`Run:\n\`\`\`\ncurl ${URL_LINE}\n\`\`\``} />
    );
    expect(html).toMatch(/<pre[^>]*data-ask-command[^>]*>curl https/);
    expect(html).toContain("break-all");
    expect(html).toContain("font-mono");
  });
});

describe("the ask card draws its why through AskContext, named", () => {
  const source = readFileSync(
    new URL("./ask-answer.tsx", import.meta.url),
    "utf8"
  );

  it("labels the why and draws view.context with AskContext", () => {
    expect(source).toMatch(
      /<Section label=\{ASK_COPY\.why\}>\s*<AskContext context=\{view\.context\} \/>/
    );
  });
});
