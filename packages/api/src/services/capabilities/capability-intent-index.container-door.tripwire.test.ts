import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { foldVerbsByIntent } from "./capability-intent-index.js";

/**
 * TRIPWIRE — the containers door must not resolve `intent` by folding CONTAINERS.
 *
 * `intent` is a property of a VERB (`RegistryCapability.verbs[].intent`).
 * `GET /capabilities/containers` returns `capabilities` rows plus member COUNTS
 * (`containers.list` selects the row and attaches `parts`) — it carries no
 * `verbs` at all. Passing that list to `foldVerbsByIntent` therefore produced an
 * EMPTY index and filtered every container away: `?intent=<anything>` returned
 * `[]` unconditionally, for every intent, on every pod.
 *
 * It typechecked clean because the fold's argument was cast (`caps as never`),
 * which is precisely why this has to be asserted rather than trusted to tsc. The
 * correct resolution goes through the registry and maps back via each brick's
 * `containerId` (`containerIdsDeclaringIntent`).
 */
describe("tripwire: /capabilities/containers resolves intent via the registry", () => {
  const DOOR = join(
    __dirname,
    "../../routers/hub-protocol/rest/capabilities.ts"
  );

  it("a container-shaped row folds to NOTHING (the shape mismatch is real)", () => {
    // Exactly what `containers.list` returns: a capability row + member counts.
    const containerShaped = [
      {
        id: "11111111-1111-1111-1111-111111111111",
        name: "Google Workspace",
        parts: { connections: 1, builtins: 0, skills: 4 },
      },
    ];
    expect(
      foldVerbsByIntent(containerShaped as never).size,
      "If this is ever non-empty the shape changed and the door's resolution " +
        "strategy should be revisited — but as long as it is 0, folding " +
        "containers can only ever return an empty list."
    ).toBe(0);
  });

  it("the containers handler does NOT fold its own list", () => {
    const src = readFileSync(DOOR, "utf8");
    const containersHandler = src.slice(
      src.indexOf('app.get("/capabilities/containers"')
    );
    expect(
      containersHandler.indexOf('app.get("/capabilities/containers"'),
      "the /capabilities/containers handler was not found — it moved, and this " +
        "tripwire is now scanning the wrong region"
    ).toBe(0);
    // `enriched` is the merged container list. Folding it, or filtering it by a
    // fold of itself, is the dead path.
    expect(
      /foldVerbsByIntent\(\s*enriched|applyIntentFilter\(\s*enriched/.test(
        containersHandler
      ),
      "the containers handler resolves `intent` by folding its own container " +
        "list. Containers carry no verbs, so that filter matches nothing and " +
        "the door answers `[]` for every intent. Resolve through the registry " +
        "(`containerIdsDeclaringIntent`) and map back via `containerId`."
    ).toBe(false);
    expect(
      containersHandler.includes("containerIdsDeclaringIntent("),
      "the containers handler no longer calls `containerIdsDeclaringIntent` — " +
        "if the intent filter was removed from this door, delete this tripwire " +
        "and the `intent` query param together, so the door never advertises a " +
        "filter it does not apply."
    ).toBe(true);
  });
});
