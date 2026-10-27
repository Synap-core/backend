/**
 * Every kind the registry names draws its own icon, not the fallback cube.
 * The set is derived from `OBJECT_KINDS`, never listed here: a kind the
 * registry gains with an icon this bundle lacks fails by name.
 */
import { describe, expect, it } from "vitest";
import { Box } from "lucide-react";
import { FALLBACK_ICON, OBJECT_KINDS } from "@synap-core/types/vocabulary";
import { kindIcon } from "./kind-icon";

describe("kindIcon", () => {
  it("draws the registry's icon for every kind", () => {
    const cubes = Object.entries(OBJECT_KINDS)
      .filter(([, def]) => def.icon !== FALLBACK_ICON)
      .filter(([kind]) => kindIcon(kind) === Box)
      .map(([kind, def]) => `${kind} (${def.icon})`);
    expect(cubes).toEqual([]);
  });

  it("an unknown kind draws the fallback", () => {
    expect(kindIcon("no-such-kind")).toBe(Box);
  });
});
