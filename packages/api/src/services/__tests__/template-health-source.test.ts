/**
 * Template health compares a space with the source it was installed from: a
 * space from a source a person added is stamped `<source>/<slug>` and is
 * never measured against Synap's same-named template. A qualified slug the
 * source does not list reads `unknown` — the official sync's completeness
 * proves nothing about another source.
 */

import { describe, it, expect } from "vitest";
import {
  classifyTemplateLifecycle,
  splitTemplateSlug,
} from "../template-health.js";

describe("splitTemplateSlug", () => {
  it("reads a source-qualified stamp; a bare slug is the official catalog's", () => {
    expect(splitTemplateSlug("acme/crm")).toEqual({
      source: "acme",
      slug: "crm",
    });
    expect(splitTemplateSlug("crm")).toBeNull();
    expect(splitTemplateSlug("/crm")).toBeNull();
    expect(splitTemplateSlug("Not A Source/crm")).toBeNull();
  });
});

describe("classifyTemplateLifecycle — source-qualified slugs", () => {
  const complete = { entryBySlug: new Map(), complete: true };

  it("an absent official slug under a complete sync is `unlisted`", () => {
    expect(classifyTemplateLifecycle("crm", complete).lifecycle).toBe(
      "unlisted"
    );
  });

  it("an absent qualified slug stays `unknown`, whatever the official sync says", () => {
    expect(
      classifyTemplateLifecycle("acme/crm", {
        ...complete,
        unprovable: new Set(["acme/crm"]),
      }).lifecycle
    ).toBe("unknown");
  });

  it("a qualified slug its source lists is `current`", () => {
    expect(
      classifyTemplateLifecycle("acme/crm", {
        entryBySlug: new Map([
          [
            "acme/crm",
            {
              version: "h-1",
              retired: false,
              replacedBy: null,
              retiredReason: null,
            },
          ],
        ]),
        complete: false,
      }).lifecycle
    ).toBe("current");
  });
});
