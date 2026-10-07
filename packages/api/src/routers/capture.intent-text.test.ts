/**
 * CAPTURE ROUTE SUGGESTIONS RANK BY WHAT THE PERSON SAID — on every door.
 *
 * `loadRouteSuggestions` ranks playbooks / rules / running sessions by the
 * intent words of the capture (`rankRouteCandidates`). The Hub REST structure
 * door has always passed `body.text`; the tRPC `capture.execute` door — the one
 * Relay and the MCP capture handler reach — passed NOTHING, so a capture's
 * suggestions there were ranked by kind alone (research-3 §2.4).
 *
 * Driving `capture.execute` end to end needs Postgres, so — like
 * `capture.session-parity.test.ts` — the wiring is asserted against the source,
 * scoped to execute's OWN body. The ranking itself is exercised behaviourally
 * in `services/routing/load-route-suggestions.test.ts`.
 *
 * WHAT IT CANNOT SEE: a door that forwards a DIFFERENT text under the right key.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(HERE, p), "utf8");

describe("capture intent text reaches the route ranker", () => {
  const captureSrc = read("capture.ts");
  const start = captureSrc.indexOf("\n  execute: podProcedure");
  const end = captureSrc.indexOf("\n  executeWithSchema: podProcedure");
  const executeSrc = captureSrc.slice(start, end);

  it("scans execute's own body (non-vacuity)", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(executeSrc).toContain("loadRouteSuggestions({");
  });

  it("execute declares intentText and hands it to loadRouteSuggestions", () => {
    expect(executeSrc).toMatch(
      /intentText: z\.string\(\)\.max\(4000\)\.optional\(\)/
    );
    const call = executeSrc.slice(executeSrc.indexOf("loadRouteSuggestions({"));
    const callBody = call.slice(0, call.indexOf("});"));
    expect(callBody).toContain("intentText: input.intentText");
  });

  it("the MCP capture door forwards the raw text it holds", () => {
    const mcp = read("mcp/handlers/capture.ts");
    expect(mcp).toMatch(/intentText: captureRawText/);
  });

  it("the Hub REST execute door declares and forwards it", () => {
    const codec = read("hub-protocol/rest/_codecs/misc.ts");
    const schema = codec.slice(
      codec.indexOf("CaptureExecuteRequest") - 6000,
      codec.indexOf('.openapi("CaptureExecuteRequest")')
    );
    expect(schema).toContain("intentText: z.string().max(4000).optional()");
    const rest = read("hub-protocol/rest/capture.ts");
    expect(rest).toContain("intentText: body.intentText");
  });
});
