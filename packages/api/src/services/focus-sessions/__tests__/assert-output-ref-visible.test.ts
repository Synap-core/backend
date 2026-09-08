import { describe, it, expect, vi } from "vitest";
import { OUTPUT_REF_KINDS } from "@synap/playbooks";

/**
 * PARTIAL mock — only `db`, and only so the VIEW branch is observable. The view
 * lookup is the branch an unknown kind used to fall through to; making it THROW
 * is what turns "an unknown kind is refused" from a shape assertion into a
 * reachability one. A total replacement goes dark at collection time the moment
 * the module under test imports one more export.
 */
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        views: {
          findFirst: async () => {
            throw new Error("VIEWS_LOOKUP_REACHED");
          },
        },
      },
    },
  };
});

/**
 * `isOutputRefVisible` — the `url` arm.
 *
 * A `url` output has no backing row, so there is no visibility floor to apply
 * and the door accepted ANY string. But the string is not inert: the session
 * room renders it as a link, so `javascript:` / `data:` refs were a stored
 * script vector written by an authenticated caller and clicked by anyone who
 * can see the session.
 *
 * The scheme gate is `isHttpUrl` (@synap/shared-utils) — scheme-only, NOT
 * `validateExternalUrl` (the SSRF door): a session output URL is never
 * fetched by the pod, only rendered as a link, so a developer must be able to
 * record `http://localhost:3000/thing`. Loopback/private-host rejection is
 * deliberately NOT applied here — that's a decision for the outbound-fetch
 * guard, not this display-only reference.
 *
 * No DB is reached: this arm returns before any query.
 */

const { isOutputRefVisible } = await import("../assert-output-ref-visible.js");

const check = (refId: string) =>
  isOutputRefVisible({ userId: "user-1", kind: "url", refId });

describe("isOutputRefVisible — url scheme floor", () => {
  it("accepts http and https", async () => {
    await expect(check("https://example.com/spec")).resolves.toBe(true);
    await expect(check("http://example.com/spec")).resolves.toBe(true);
  });

  it("refuses a script-capable or non-network scheme", async () => {
    // The whole reason this arm validates at all.
    await expect(check("javascript:alert(1)")).resolves.toBe(false);
    await expect(
      check("data:text/html,<script>alert(1)</script>")
    ).resolves.toBe(false);
    await expect(check("ftp://example.com/x")).resolves.toBe(false);
  });

  it("refuses a non-url string", async () => {
    // `refId` is only `z.string().min(1)` on both doors, so this is reachable.
    await expect(check("not a url")).resolves.toBe(false);
    await expect(check("example.com")).resolves.toBe(false);
  });

  it("accepts a loopback/private host — a developer must be able to record a local URL", async () => {
    // Deliberate: nothing FETCHES a url output, it is only rendered as a link,
    // so the SSRF door's loopback/private-host rejection does not apply here.
    await expect(check("http://localhost:3000/thing")).resolves.toBe(true);
    await expect(check("http://192.168.1.10/thing")).resolves.toBe(true);
  });

  it("still accepts a cell ref, which has no backing row and no url shape", async () => {
    await expect(
      isOutputRefVisible({ userId: "user-1", kind: "cell", refId: "some-cell" })
    ).resolves.toBe(true);
  });
});

/**
 * THE DEFAULT ARM — an unadjudicable kind is REFUSED, not routed to `views`.
 *
 * `view` used to be the FALL-THROUGH: after the entity / document / automation /
 * playbook blocks the function simply ran the view lookup. So a kind outside
 * `OUTPUT_REF_KINDS` — reachable from any caller that did not parse, which until
 * this wave included the MCP door — was adjudicated AS A VIEW, cleared the floor
 * whenever its id named a readable view, and was then stored verbatim for every
 * reader that believes the union.
 *
 * Asserted by REACHABILITY, not shape: the mocked `views.findFirst` throws, so
 * "the unknown kind did not reach the views lookup" is proved by the call
 * RESOLVING rather than by reading the source. The `view` case below is the
 * non-vacuity half — if the mock ever stopped being wired, it would resolve
 * quietly and the refusal test would prove nothing.
 */
describe("isOutputRefVisible — a kind outside OUTPUT_REF_KINDS", () => {
  const VIEW_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  it("NON-VACUITY: a real `view` ref DOES reach the views lookup", async () => {
    await expect(
      isOutputRefVisible({ userId: "user-1", kind: "view", refId: VIEW_UUID })
    ).rejects.toThrow("VIEWS_LOOKUP_REACHED");
  });

  it("is refused without touching the views lookup", async () => {
    for (const kind of ["session", "proposal", "anything", ""]) {
      await expect(
        isOutputRefVisible({
          // Unreachable through a door that parses — which is the point: the
          // floor is what a caller reaching the service DIRECTLY hits.
          userId: "user-1",
          kind: kind as never,
          refId: VIEW_UUID,
        })
      ).resolves.toBe(false);
    }
  });

  it("the six adjudicable kinds are the ones the union declares", () => {
    // Derived, not hand-listed: if a kind is added to the union without a
    // branch here, the loop above would start refusing something the wire
    // accepts. `url` and `cell` return before any query; the four backed kinds
    // and `view` each have their own block.
    expect([...OUTPUT_REF_KINDS].sort()).toEqual(
      ["automation", "cell", "document", "entity", "playbook", "view"].sort()
    );
  });
});
