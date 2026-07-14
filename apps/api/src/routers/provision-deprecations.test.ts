import { beforeAll, describe, expect, it } from "vitest";

let provisionRouter: (typeof import("./provision.js"))["provisionRouter"];

describe("retired provision identity routes", () => {
  beforeAll(async () => {
    // These handlers do not touch the database, but their module imports the
    // shared configuration package. Keep this isolated router test runnable
    // without a developer's real database URL.
    process.env.DATABASE_URL ??=
      "postgresql://synap:test@localhost:5432/synap_test";
    ({ provisionRouter } = await import("./provision.js"));
  });

  const retiredRoutes = [
    ["/connect", undefined],
    ["/authorize-issuer", "/api/federation/identity-links"],
    ["/seed-trust", "/api/federation/identity-links"],
    ["/seed-admin", "/api/federation/access-grants"],
    ["/activate-member", "/api/federation/access-grants"],
    ["/admin-recovery-link", "/self-service/recovery/browser"],
  ] as const;

  it.each(retiredRoutes)(
    "retires %s without executing its former flow",
    async (path, successor) => {
      const response = await provisionRouter.request(path, { method: "POST" });

      expect(response.status).toBe(410);
      expect(response.headers.get("Deprecation")).toBe("true");
      expect(response.headers.get("Link")).toBe(
        successor ? `<${successor}>; rel="successor-version"` : null
      );
      await expect(response.json()).resolves.toEqual(
        successor
          ? {
              error: "This legacy provisioning endpoint has been retired.",
              successor,
            }
          : {
              error:
                "This Control-Plane-specific provisioning endpoint has been retired.",
            }
      );
    }
  );
});
