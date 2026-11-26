/**
 * An object's page opened on a surface that is no longer attached to it (or
 * that the reader cannot see): the page keeps the object's OWN name, says
 * what happened with a real state ("Not found", never the section's name),
 * and its door opens the object by name. Rendered from the wire shapes the
 * two reads answer (`surfaces.forObject`, `entities.get`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let surfaces: unknown = { rows: [], unavailable: [] };
let entity: unknown = { entity: { title: "Acme deal" } };

const answered = (data: () => unknown) => ({
  useQuery: (_input: unknown, opts?: { enabled?: boolean }) => ({
    data: opts?.enabled === false ? undefined : data(),
    error: null,
    isLoading: false,
    refetch: () => {},
  }),
});

vi.mock("../../../lib/trpc", () => ({
  trpc: {
    surfaces: { forObject: answered(() => surfaces) },
    entities: { get: answered(() => entity) },
    focusSessions: { get: answered(() => undefined) },
    tracks: { get: answered(() => undefined) },
    playbooks: { process: answered(() => undefined) },
  },
}));

import { AttachedSurfaceView } from "./attached-surface-view";
import { labelForOpenType } from "../open-params";

const E = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const S = "11111111-2222-4333-8444-555555555555";
const draw = () =>
  renderToStaticMarkup(
    <AttachedSurfaceView anchor={{ kind: "entity", id: E }} surfaceId={S} />
  );

beforeEach(() => {
  surfaces = { rows: [], unavailable: [] };
  entity = { entity: { title: "Acme deal" } };
});

describe("AttachedSurfaceView: a surface no longer on the object", () => {
  it("keeps the object's own name, says Not found, and opens the object by name", () => {
    const html = draw();
    expect(html).toContain("Acme deal");
    expect(html).toContain("Not found");
    expect(html).toContain("isn’t on this page any more");
    expect(html).toContain(`href="/open/entity/${E}"`);
    expect(html).toContain("Open Acme deal");
    // The section's name is not a state.
    expect(html).not.toContain(">Surfaces<");
  });

  it("names the object by its kind when its own read has no title", () => {
    entity = { entity: { title: "  " } };
    expect(draw()).toContain(`Open ${labelForOpenType("entity")}`);
  });
});
