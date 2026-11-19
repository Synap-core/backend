/**
 * A client app's kit as the design door reads it (W6): the app names its
 * catalog file, the catalog pins each code file by sha256. No kit is `none`;
 * a kit that cannot be read is an error naming why; bytes that are not the
 * pinned ones are refused, never served.
 */
import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  appRows: [] as Array<Record<string, unknown>>,
  files: new Map<string, Buffer>(),
  refused: new Set<string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => h.appRows }) }),
      }),
    },
  };
});
vi.mock("../../access/entity-read-floor.js", () => ({
  entityReadVisibleWhere: () => undefined,
}));
vi.mock("../../routers/file-upload.js", () => ({
  readableFileEntity: async (_userId: string, id: string) =>
    h.refused.has(id)
      ? { ok: false, status: 403, error: "You cannot read this file." }
      : h.files.has(id)
        ? { ok: true, entity: { storageKey: `k/${id}` } }
        : { ok: false, status: 404, error: "File entity not found" },
}));
vi.mock("@synap/storage", () => ({
  storage: {
    downloadBuffer: async (key: string) => h.files.get(key.slice(2))!,
  },
}));

const { readAppKit, readKitPart } = await import("./app-kit.js");

const APP = "11111111-1111-4111-8111-111111111111";
const CAT = "22222222-2222-4222-8222-222222222222";
const JS = "33333333-3333-4333-8333-333333333333";
const CSS = "44444444-4444-4444-8444-444444444444";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const jsBytes = Buffer.from("export const components = {};");
const cssBytes = Buffer.from('@scope ([data-kit="crm"]) {}');

const catalog = (over: Record<string, unknown> = {}) => ({
  kitId: "crm",
  hash: "sha256:kit",
  components: { Button: { children: { kind: "slot" } } },
  layout: {},
  canvas: { components: { Button: { category: "button", defaults: {} } } },
  kit: {
    react: "19",
    files: {
      js: { entityId: JS, sha256: sha(jsBytes), bytes: jsBytes.length },
      css: { entityId: CSS, sha256: sha(cssBytes), bytes: cssBytes.length },
    },
  },
  ...over,
});

const app = (props: Record<string, unknown>) => [
  { id: APP, type: "devplane_app", properties: props },
];

beforeEach(() => {
  h.appRows = app({ "design-kit": CAT });
  h.files = new Map([
    [CAT, Buffer.from(JSON.stringify(catalog()))],
    [JS, jsBytes],
    [CSS, cssBytes],
  ]);
  h.refused = new Set();
});

describe("readAppKit", () => {
  it("an app that names no kit: none (its designs are Synap's components)", async () => {
    h.appRows = app({ appName: "CRM" });
    expect(await readAppKit("u", APP)).toEqual({ status: "none", appId: APP });
  });

  it("reads the kit its design-kit file holds", async () => {
    const r = await readAppKit("u", APP);
    expect(r).toMatchObject({ status: "kit", catalogFileId: CAT });
    if (r.status !== "kit") return;
    expect(r.kit.kitId).toBe("crm");
    expect(r.kit.kit.files.js.entityId).toBe(JS);
  });

  it("refuses, naming why: not an app, an app you cannot read, a file you cannot read, a catalog it cannot trust", async () => {
    h.appRows = [{ id: APP, type: "ui-design", properties: {} }];
    await expect(readAppKit("u", APP)).rejects.toThrow(/not an app/);
    h.appRows = [];
    await expect(readAppKit("u", APP)).rejects.toThrow(/No app/);
    h.appRows = app({ "design-kit": CAT });
    h.refused.add(CAT);
    await expect(readAppKit("u", APP)).rejects.toThrow(/cannot read this file/);
    h.refused.clear();
    h.files.set(CAT, Buffer.from("not json"));
    await expect(readAppKit("u", APP)).rejects.toThrow(/not JSON/);
    h.files.set(CAT, Buffer.from(JSON.stringify(catalog({ kitId: "synap" }))));
    await expect(readAppKit("u", APP)).rejects.toThrow(/cannot be used/);
    h.appRows = app({ "design-kit": "kit.json" });
    await expect(readAppKit("u", APP)).rejects.toThrow(/not a file id/);
  });
});

describe("readKitPart", () => {
  it("serves a code file whose bytes are the pinned ones", async () => {
    const js = await readKitPart("u", APP, "js");
    expect(js).toMatchObject({ kitId: "crm", hash: "sha256:kit", part: "js" });
    expect(js.bytes.equals(jsBytes)).toBe(true);
    expect(js.sha256).toBe(sha(jsBytes));
  });

  it("refuses other bytes under the pinned id, and an app with no kit", async () => {
    h.files.set(CSS, Buffer.from("body { display: none }"));
    await expect(readKitPart("u", APP, "css")).rejects.toThrow(
      /not the one its catalog pins/
    );
    h.appRows = app({});
    await expect(readKitPart("u", APP, "js")).rejects.toThrow(/no design kit/);
  });
});
