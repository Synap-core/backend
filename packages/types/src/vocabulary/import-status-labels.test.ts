import { describe, it, expect } from "vitest";
import {
  IMPORT_CONTENT_STATUSES,
  IMPORT_ITEM_DECISIONS,
  IMPORT_PHASES,
} from "../imports/curate.js";
import {
  IMPORT_STATUS_LABELS,
  resolveImportOriginLabel,
  resolveImportStatusLabel,
} from "./index.js";

describe("resolveImportStatusLabel — one word per import state", () => {
  it("labels every phase, content status and decision of the contract", () => {
    for (const token of [
      ...IMPORT_PHASES,
      ...IMPORT_CONTENT_STATUSES,
      ...IMPORT_ITEM_DECISIONS,
    ]) {
      expect(IMPORT_STATUS_LABELS[token], token).toBeTruthy();
    }
  });

  it("says the words the curate screen shows", () => {
    expect(resolveImportStatusLabel("collecting")).toBe("Collecting");
    expect(resolveImportStatusLabel("curating")).toBe("Curating");
    expect(resolveImportStatusLabel("building")).toBe("Building");
    expect(resolveImportStatusLabel("needs_file")).toBe("Needs the file");
    expect(resolveImportStatusLabel("title_only")).toBe("Title only");
    expect(resolveImportStatusLabel("captions")).toBe("Captions");
    expect(resolveImportStatusLabel("readable")).toBe("Readable");
    expect(resolveImportStatusLabel("later")).toBe("Later");
    expect(resolveImportStatusLabel("exclude")).toBe("Excluded");
  });

  it("never leaks a raw token", () => {
    expect(resolveImportStatusLabel("some_new_state")).toBe("Some new state");
    expect(resolveImportStatusLabel(null)).toBe("");
  });
});

describe("resolveImportOriginLabel — where an import started", () => {
  it("names the device, never the client token", () => {
    expect(resolveImportOriginLabel("relay")).toBe("your phone");
    expect(resolveImportOriginLabel("browser")).toBe("your computer");
    expect(resolveImportOriginLabel("")).toBe("");
  });
});
