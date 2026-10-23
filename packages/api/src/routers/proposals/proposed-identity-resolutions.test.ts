/**
 * `withProposedIdentityResolutions` — what a PROPOSAL may pre-decide for its
 * approval. Only `separate` (a same-name row backed by a different strong
 * signal, which a person accepts by approving); a proposed `fill_empty` /
 * `use_capture` / `keep_existing` would let a producer choose what an
 * approval writes onto an existing entity, so it is ignored. The approver's
 * own choice for a ref always wins.
 */
import { describe, it, expect } from "vitest";
import { withProposedIdentityResolutions } from "./apply-approval.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("withProposedIdentityResolutions", () => {
  it("keeps a proposed separate; drops any other proposed verb or junk", () => {
    expect(
      withProposedIdentityResolutions(
        {
          t1: { verb: "separate" },
          t2: { verb: "fill_empty", existingEntityId: ID },
          t3: { verb: "use_capture", existingEntityId: ID },
          t4: "separate",
        },
        undefined
      )
    ).toEqual({ identityResolutionByRef: { t1: { verb: "separate" } } });
  });

  it("the approver's choice for a ref wins", () => {
    expect(
      withProposedIdentityResolutions(
        { t1: { verb: "separate" } },
        { t1: { verb: "keep_existing", existingEntityId: ID } }
      )
    ).toEqual({
      identityResolutionByRef: {
        t1: { verb: "keep_existing", existingEntityId: ID },
      },
    });
  });

  it("nothing proposed and nothing chosen adds nothing", () => {
    expect(withProposedIdentityResolutions(undefined, undefined)).toEqual({});
    expect(withProposedIdentityResolutions([], undefined)).toEqual({});
  });
});
