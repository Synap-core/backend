/**
 * X1 — `find` / `start_session` playbook candidates carry the template kind.
 * `matchSessionTemplate` is the ONE matcher both doors call (find-intent.ts
 * reuses it), so asserting its output is asserting both doors' rows.
 *
 * Stubbed: the db select (returns two playbook rows) and the access predicate.
 * Real: the ranker and `templateKindFields` (vocabulary `resolveTemplateNoun`).
 */
import { describe, it, expect, vi } from "vitest";

const rows = [
  {
    id: "pb-track",
    name: "Business Model (GRP)",
    description: "Run the business model interrogation as a track",
    goalTemplate: "GRP",
    stages: [],
    scope: "project",
  },
  {
    id: "pb-twin",
    name: "GRP Business Model Interrogation",
    description: null,
    goalTemplate: "Interrogate the business model",
    stages: [],
    scope: null,
  },
];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: async () => rows,
  };
  return { ...actual, db: { select: () => chain } };
});
vi.mock("../../../access/scoped-db.js", () => ({
  scopedDb: () => ({ predicate: () => undefined }),
}));
vi.mock("../../../access/context.js", () => ({
  AccessContext: { agent: () => ({ withLens: () => ({}) }) },
}));

import { matchSessionTemplate } from "../match-session-template.js";

describe("matchSessionTemplate — template kind on every candidate", () => {
  it("names each candidate's scope and its vocabulary noun", async () => {
    const out = await matchSessionTemplate({
      userId: "u1",
      goal: "business model interrogation",
    });
    const byId = Object.fromEntries(out.candidates.map((c) => [c.id, c]));
    expect(byId["pb-track"]).toMatchObject({
      scope: "project",
      templateKind: "Track template",
    });
    expect(byId["pb-twin"]).toMatchObject({
      scope: "session",
      templateKind: "Work template",
    });
  });
});
