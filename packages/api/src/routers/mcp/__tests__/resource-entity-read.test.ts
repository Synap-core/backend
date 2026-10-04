/**
 * `synap://entities/<type>/<id>` must read THAT entity.
 *
 * The by-id branch used to fetch `getEntities({ limit: 1 })` — one arbitrary
 * row — and `.find` the requested id in it, so almost every read reported
 * "Entity not found". It now goes through `entities.get`, the door
 * `synap_get_entity` uses. This drives the real adapter and asserts the
 * requested id is what reaches the by-id read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getSpy = vi.fn();
const getEntitiesSpy = vi.fn();

vi.mock("../../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: vi.fn(async () => ({ ctx: "hub" })),
}));
vi.mock("../../entities.js", () => ({
  entitiesRouter: { createCaller: () => ({ get: getSpy }) },
}));
vi.mock("../handlers/shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../handlers/shared.js")>()),
  createHubProtocolCaller: vi.fn(async () => ({
    entities: { getEntities: getEntitiesSpy },
  })),
}));

const { readMCPResourceViaHubProtocol } = await import("../adapter.js");

describe("synap://entities/<type>/<id> resource read", () => {
  beforeEach(() => {
    getSpy.mockReset();
    getEntitiesSpy.mockReset();
  });

  it("reads the requested entity by id, not the first row of a list", async () => {
    const wanted = { id: "e-wanted", title: "Wanted" };
    getSpy.mockResolvedValue(wanted);
    // A list read would hand back some OTHER row — the old defect.
    getEntitiesSpy.mockResolvedValue([{ id: "e-other", title: "Other" }]);

    const res = await readMCPResourceViaHubProtocol(
      "synap://entities/contacts/e-wanted",
      "user-1",
      ["mcp.read"]
    );

    expect(getSpy).toHaveBeenCalledWith({ id: "e-wanted" });
    expect(JSON.parse(res.contents[0].text as string)).toEqual(wanted);
  });
});
