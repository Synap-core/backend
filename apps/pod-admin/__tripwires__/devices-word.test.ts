import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import {
  computerHref,
  consoleRedirects,
  navItem,
  SEARCH_DESTINATION,
} from "../lib/console-nav";
import { routeAccess } from "../lib/route-policy";
import { en, fr } from "../app/(admin)/components/copy";

/**
 * "Devices" is the product word for what the pod reaches, "Appareils" in
 * French (decision 78fc3fa1). Two defects typecheck and would bring the
 * collision back:
 *
 *   • a sentence that says "device" for a SIGN-IN (a browser or app session)
 *     — those say "sign-in", "signed in" or "Signed-in apps";
 *   • a Computers page address that stops redirecting, breaking every
 *     bookmark and every link an older client builds.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every non-test source file of the app, without its comments. */
function sources(): Array<{ file: string; code: string }> {
  const out: Array<{ file: string; code: string }> = [];
  for (const dir of ["app", "lib"]) {
    for (const e of readdirSync(join(ROOT, dir), {
      withFileTypes: true,
      recursive: true,
    })) {
      if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
      const path = join(e.parentPath, e.name);
      // Comments may describe a device in any sense; only shipped words count.
      const code = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      out.push({ file: relative(ROOT, path), code });
    }
  }
  return out;
}

/** "device" meaning a sign-in, in either language. */
const SIGN_IN_AS_DEVICE: readonly RegExp[] = [
  /signed[- ]in devices?/i,
  /sign(?:ed)? out (?:of )?(?:\d+ |\$\{\w+\} )?(?:other )?devices?/i,
  /other devices/i,
  /every device of/i,
  /devices of yours/i,
  /list your devices/i,
  /only this device/i,
  /chacun de vos appareils/i,
  /appareils connectés/i,
  /vos autres appareils/i,
  /tous vos appareils/i,
];

describe("a sign-in is never called a device", () => {
  it("says sign-in words wherever the app means a session", () => {
    const found = sources().flatMap(({ file, code }) =>
      SIGN_IN_AS_DEVICE.flatMap((re) => {
        const m = code.match(re);
        return m ? [`${file}: “${m[0]}”`] : [];
      })
    );
    expect(found).toEqual([]);
  });

  it("keeps the Security page's old #devices anchor on the phones card", () => {
    const card = readFileSync(
      join(ROOT, "app/_lib/presence/ways-in/device-keys-card.tsx"),
      "utf8"
    );
    expect(card).toMatch(/DEVICE_KEYS_LEGACY_ANCHOR = "devices"/);
    expect(card).toMatch(/id=\{DEVICE_KEYS_LEGACY_ANCHOR\}/);
    expect(card).toMatch(/id=\{DEVICE_KEYS_ANCHOR\}/);
  });
});

describe("Computers became Devices", () => {
  it("names the nav item and the search heading Devices", () => {
    const item = navItem("computers");
    expect(item.label).toBe("Devices");
    expect(item.href).toBe("/devices");
    expect(SEARCH_DESTINATION.computer.label).toBe("Devices");
    expect(computerHref("c 1")).toBe("/devices/c%201");
  });

  it("names a member's own list My devices, Mes appareils", () => {
    expect(en["user.devices"]).toBe("My devices");
    expect(fr["user.devices"]).toBe("Mes appareils");
  });

  it("serves the new pages and no longer the old ones", () => {
    const app = join(ROOT, "app");
    expect(existsSync(join(app, "(admin)/devices/page.tsx"))).toBe(true);
    expect(existsSync(join(app, "(admin)/devices/[id]/page.tsx"))).toBe(true);
    expect(existsSync(join(app, "my-devices/page.tsx"))).toBe(true);
    expect(existsSync(join(app, "my-devices/[id]/page.tsx"))).toBe(true);
    expect(existsSync(join(app, "(admin)/computers"))).toBe(false);
    expect(existsSync(join(app, "my-computers"))).toBe(false);
    // A member's own list stays open to a member.
    expect(routeAccess("/my-devices")).toBe("signed-in");
    expect(routeAccess("/my-devices/c1")).toBe("signed-in");
    expect(routeAccess("/devices")).toBe("admin");
  });

  it("redirects every old address, through the config Next loads", async () => {
    const expected = [
      { source: "/computers", destination: "/devices" },
      { source: "/computers/:id", destination: "/devices/:id" },
      { source: "/my-computers", destination: "/my-devices" },
      { source: "/my-computers/:id", destination: "/my-devices/:id" },
    ];
    const sets: ReadonlyArray<
      ReadonlyArray<{ source: string; destination: string; has?: unknown }>
    > = [consoleRedirects(), await nextConfig.redirects!()];
    for (const rules of sets) {
      for (const { source, destination } of expected) {
        const rule = rules.find((r) => r.source === source && !r.has);
        expect(rule?.destination, source).toBe(destination);
      }
    }
  });
});
