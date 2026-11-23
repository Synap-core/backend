/**
 * A RENDERER BUNDLE (decision c91d26dc): a set of frame cells that draw a
 * pod's objects (an entity card, an entity page, a board…) together with the
 * ONE host-module set they run on (React, react-dom, the JSX runtimes, the
 * kit and the tokens CSS, all from one build). A host with no renderers of
 * its own (pod admin) draws pod content through it, in sandboxed frames
 * (`@synap-core/types/cell-bridge`, `buildCellModuleFrameSrcdoc`).
 *
 * This file is the published definition's shape and its pure check
 * (`validateRendererBundleDefinition`). The pod re-hashes every source with
 * node crypto on install; the check here never trusts a declared hash, it
 * only checks the shape, the sizes, the kit imports and each cell's source
 * (`checkCellSource`, the same rule a single frame cell is defined under).
 */

import {
  CELL_FRAME_MAX_BYTES,
  htmlByteLength,
} from "../cell-bridge/frame-size.js";
import { isCellBridgeReadOp } from "../cell-bridge/read-ops.js";
import { isCellBridgeWriteOp } from "../cell-bridge/write-ops.js";
import * as cellBridge from "../cell-bridge/index.js";
import { checkCellSource } from "./cell-source-checks.js";

/** The bundle API this version of the contract reads. */
export const RENDERER_BUNDLE_API = 1 as const;

/** The package kind a renderer bundle is published under. */
export const RENDERER_BUNDLE_KIND = "renderer-bundle" as const;

/** The largest host module (React, the kit…): 4 MB of UTF-8. */
export const RENDERER_BUNDLE_MAX_MODULE_BYTES = 4 * 1024 * 1024;

/**
 * The KIT's working budget: 3.2 MiB of UTF-8, under the 4 MiB ceiling. Every
 * frame whose cell imports the kit carries it again (base64 in its srcdoc)
 * and parses it again, so the kit's size is every such frame's boot cost
 * (plan cb8470f2 §3). Measured 22 Nov 2026: 2,864,519 bytes. Synap's official
 * build refuses a kit over it (app-bases `build-renderer-bundle.mjs`, which
 * reads this constant); the pod's install check does not (another bundle may
 * still use the whole ceiling). Raise it on purpose, with the new measure,
 * never to make a build pass.
 */
export const RENDERER_BUNDLE_KIT_BUDGET_BYTES = Math.floor(3.2 * 1024 * 1024);

/** One host module's source and its declared sha256 (hex). */
export interface RendererBundleModule {
  source: string;
  sha256: string;
}

/** The host-module set: one build, one React. */
export interface RendererBundleHostModules {
  react: RendererBundleModule;
  reactDom: RendererBundleModule;
  reactDomClient: RendererBundleModule;
  jsxRuntime: RendererBundleModule;
  jsxDevRuntime?: RendererBundleModule;
  kit?: RendererBundleModule;
  tokensCss: RendererBundleModule;
}

/** One frame cell of the bundle (installed as `cell:<slug>:<key>`). */
export interface RendererBundleCell {
  key: string;
  name: string;
  /** The cell's ES module source. */
  code: string;
  sha256: string;
  /** The slot it draws (`entity-card`, `entity-detail`, `collection`, …). */
  contentKind: string;
  /** A view renderer's view types. */
  viewTypes?: string[];
  defaultSize?: { w: number; h: number };
  minSize?: { w: number; h: number };
  /** The kit names the cell imports: each must be in `kitExports`. */
  kitImports: string[];
}

/**
 * Which cell a host with no built-in draws when nothing is bound. Never a
 * renderer binding: a binding would beat the desktop's own adapters.
 */
export interface RendererBundleDefaults {
  "entity-card"?: string;
  "entity-detail"?: string;
  views?: Record<string, string>;
}

/**
 * What a bundle needs from the pod that runs it: the bundle is built against
 * backend `main`, while a `stable` pod runs an older release. Optional, every
 * field optional; absent = no requirement. A requirement this pod does not
 * know (a newer contract's) is unmet, never invalid: the bundle waits for the
 * pod to be updated instead of being refused.
 *
 *   bridgeContract — the frame contract version it was built against
 *               (`CELL_BRIDGE_CONTRACT_VERSION`): a param an op gained is not
 *               a new op name, so the version says it;
 *   bridgeOps — the cell-bridge operations its cells call (read ops of
 *               `CELL_BRIDGE_READ_OPS`, write ops of `CELL_BRIDGE_WRITE_OPS`).
 */
export interface RendererBundleRequires {
  bridgeContract?: number;
  bridgeOps?: string[];
}

/** The published definition of a renderer bundle. */
export interface RendererBundleDefinition {
  _meta: { slug: string; version: string; kind: typeof RENDERER_BUNDLE_KIND };
  bundleApi: typeof RENDERER_BUNDLE_API;
  /** The React version every module was built against. */
  reactVersion: string;
  /** sha256 of `rendererSetDigestText` over the host modules' sha256s. */
  setSha256: string;
  /** Every name the kit exports. */
  kitExports: string[];
  hostModules: RendererBundleHostModules;
  cells: RendererBundleCell[];
  defaults: RendererBundleDefaults;
  /** What it needs from the pod; absent = nothing beyond `bundleApi`. */
  requires?: RendererBundleRequires;
}

/**
 * Every requirement of a bundle that THIS build of the contract does not
 * meet, as plain sentences; empty when the pod can run it. The pod's contract
 * is the one compiled into it: the bundle API it reads (`RENDERER_BUNDLE_API`)
 * and the bridge ops its hosts answer. Pure. Reads the definition loosely, so
 * it can say why before `validateRendererBundleDefinition` refuses the shape.
 */
/** The requirements this build of the contract can check. */
const KNOWN_REQUIREMENTS: ReadonlySet<string> = new Set([
  "bridgeContract",
  "bridgeOps",
]);

/**
 * The frame contract this pod answers. Read off the cell-bridge module so the
 * number is the contract's own (`CELL_BRIDGE_CONTRACT_VERSION`); a build of
 * the contract that predates the constant answers contract 1.
 */
export const POD_BRIDGE_CONTRACT: number =
  (cellBridge as { CELL_BRIDGE_CONTRACT_VERSION?: number })
    .CELL_BRIDGE_CONTRACT_VERSION ?? 1;

export function unmetRendererBundleRequirements(definition: unknown): string[] {
  if (!isRecord(definition)) return [];
  const unmet: string[] = [];
  if (
    typeof definition.bundleApi === "number" &&
    definition.bundleApi !== RENDERER_BUNDLE_API
  ) {
    unmet.push(
      `It is built for bundle API ${definition.bundleApi}; this pod reads bundle API ${RENDERER_BUNDLE_API}.`
    );
  }
  const requires = definition.requires;
  if (!isRecord(requires)) return unmet;
  if (
    typeof requires.bridgeContract === "number" &&
    requires.bridgeContract > POD_BRIDGE_CONTRACT
  ) {
    unmet.push(
      `It is built for frame contract ${requires.bridgeContract}; this pod answers contract ${POD_BRIDGE_CONTRACT}.`
    );
  }
  if (Array.isArray(requires.bridgeOps)) {
    const missing = requires.bridgeOps.filter(
      (op) => !isCellBridgeReadOp(op) && !isCellBridgeWriteOp(op)
    );
    if (missing.length > 0) {
      unmet.push(
        `It calls ${missing.map(String).join(", ")}, which this pod does not answer yet.`
      );
    }
  }
  const unknown = Object.keys(requires).filter(
    (name) => !KNOWN_REQUIREMENTS.has(name)
  );
  if (unknown.length > 0) {
    unmet.push(
      `It needs ${unknown.join(", ")}, which this pod does not know yet.`
    );
  }
  return unmet;
}

/**
 * The exact text whose sha256 is a host-module set's identity (`setSha256`):
 * one line `"<module> <sha256>\n"` per host module, sorted by module name
 * (JavaScript's default sort). The bundle build (app-bases
 * `build-renderer-bundle.mjs`, `rendererSetSha256`) and the pod's install
 * hash THIS text; it lives here so neither spells the formula alone. Pure:
 * the caller hashes it (node crypto, Web Crypto).
 */
export function rendererSetDigestText(hashes: Record<string, string>): string {
  return Object.keys(hashes)
    .sort()
    .map((name) => `${name} ${hashes[name]}\n`)
    .join("");
}

/** One reason a definition is refused, with where it is. */
export interface RendererBundleProblem {
  /** A dotted path into the definition (`cells[2].code`). */
  path: string;
  message: string;
}

const REQUIRED_MODULES = [
  "react",
  "reactDom",
  "reactDomClient",
  "jsxRuntime",
  "tokensCss",
] as const;
const OPTIONAL_MODULES = ["jsxDevRuntime", "kit"] as const;
const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CELL_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isSize = (v: unknown): boolean =>
  isRecord(v) &&
  Number.isInteger(v.w) &&
  Number.isInteger(v.h) &&
  (v.w as number) > 0 &&
  (v.h as number) > 0;
const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);

/**
 * Every reason `definition` cannot be installed, in definition order; empty
 * when it can. Pure: the same input always gives the same problems.
 */
export function validateRendererBundleDefinition(
  definition: unknown
): RendererBundleProblem[] {
  const problems: RendererBundleProblem[] = [];
  const add = (path: string, message: string) =>
    problems.push({ path, message });
  if (!isRecord(definition)) {
    add("", "The definition is not an object.");
    return problems;
  }
  const d = definition;

  const meta = d._meta;
  if (!isRecord(meta)) add("_meta", "_meta is missing.");
  else {
    if (!text(meta.slug) || !SLUG.test(meta.slug))
      add(
        "_meta.slug",
        "The slug must be lowercase letters, digits and dashes."
      );
    if (!text(meta.version)) add("_meta.version", "The version is missing.");
    if (meta.kind !== RENDERER_BUNDLE_KIND)
      add("_meta.kind", `The kind must be "${RENDERER_BUNDLE_KIND}".`);
  }
  if (d.bundleApi !== RENDERER_BUNDLE_API)
    add("bundleApi", `This pod reads bundle API ${RENDERER_BUNDLE_API} only.`);
  if (!text(d.reactVersion))
    add("reactVersion", "The React version is missing.");
  if (typeof d.setSha256 !== "string" || !SHA256.test(d.setSha256))
    add("setSha256", "setSha256 must be a sha256 in hex.");
  const kitExports = isStringList(d.kitExports) ? new Set(d.kitExports) : null;
  if (!kitExports) add("kitExports", "kitExports must be a list of names.");

  const modules = d.hostModules;
  const hasKit = isRecord(modules) && modules.kit !== undefined;
  if (!isRecord(modules)) add("hostModules", "hostModules is missing.");
  else {
    for (const name of [...REQUIRED_MODULES, ...OPTIONAL_MODULES]) {
      const m = modules[name];
      const path = `hostModules.${name}`;
      if (m === undefined) {
        if ((REQUIRED_MODULES as readonly string[]).includes(name))
          add(path, `The ${name} module is missing.`);
        continue;
      }
      if (!isRecord(m) || !text(m.source)) {
        add(path, `The ${name} module has no source.`);
        continue;
      }
      if (typeof m.sha256 !== "string" || !SHA256.test(m.sha256))
        add(`${path}.sha256`, "sha256 must be a sha256 in hex.");
      if (htmlByteLength(m.source) > RENDERER_BUNDLE_MAX_MODULE_BYTES)
        add(path, `The ${name} module is larger than 4 MB.`);
    }
    for (const name of Object.keys(modules)) {
      if (
        !(REQUIRED_MODULES as readonly string[]).includes(name) &&
        !(OPTIONAL_MODULES as readonly string[]).includes(name)
      )
        add(`hostModules.${name}`, `"${name}" is not a host module.`);
    }
  }

  /** Each cell by its key (the first cell that holds a key). */
  const keys = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(d.cells) || d.cells.length === 0)
    add("cells", "A bundle has at least one cell.");
  else {
    d.cells.forEach((cell: unknown, i: number) => {
      const path = `cells[${i}]`;
      if (!isRecord(cell)) {
        add(path, "The cell is not an object.");
        return;
      }
      if (!text(cell.key) || !CELL_KEY.test(cell.key))
        add(
          `${path}.key`,
          "The key must be lowercase letters, digits and dashes."
        );
      else if (keys.has(cell.key))
        add(`${path}.key`, `"${cell.key}" is used by another cell.`);
      else keys.set(cell.key, cell);
      if (!text(cell.name)) add(`${path}.name`, "The name is missing.");
      if (!text(cell.contentKind))
        add(`${path}.contentKind`, "The content kind is missing.");
      if (typeof cell.sha256 !== "string" || !SHA256.test(cell.sha256))
        add(`${path}.sha256`, "sha256 must be a sha256 in hex.");
      if (cell.viewTypes !== undefined && !isStringList(cell.viewTypes))
        add(`${path}.viewTypes`, "viewTypes must be a list of view types.");
      if (cell.defaultSize !== undefined && !isSize(cell.defaultSize))
        add(`${path}.defaultSize`, "defaultSize must be whole w and h.");
      if (cell.minSize !== undefined && !isSize(cell.minSize))
        add(`${path}.minSize`, "minSize must be whole w and h.");
      if (!isStringList(cell.kitImports))
        add(`${path}.kitImports`, "kitImports must be a list of names.");
      else if (cell.kitImports.length > 0 && !hasKit)
        add(
          `${path}.kitImports`,
          "The cell imports the kit, and the bundle has no kit module."
        );
      else if (kitExports) {
        const unknown = cell.kitImports.filter((n) => !kitExports.has(n));
        if (unknown.length > 0)
          add(
            `${path}.kitImports`,
            `The kit does not export ${unknown.join(", ")}.`
          );
      }
      if (!text(cell.code)) {
        add(`${path}.code`, "The cell has no code.");
        return;
      }
      if (htmlByteLength(cell.code) > CELL_FRAME_MAX_BYTES)
        add(`${path}.code`, "The cell is larger than a frame runs (2 MB).");
      const check = checkCellSource({ source: cell.code, mechanism: "frame" });
      for (const r of check.refusals)
        add(
          `${path}.code`,
          r.line ? `Line ${r.line}: ${r.message}` : r.message
        );
    });
  }

  if (d.requires !== undefined) {
    if (!isRecord(d.requires)) add("requires", "requires must be an object.");
    else {
      // An unknown requirement is unmet (`unmetRendererBundleRequirements`),
      // not invalid.
      if (
        d.requires.bridgeOps !== undefined &&
        !isStringList(d.requires.bridgeOps)
      )
        add("requires.bridgeOps", "bridgeOps must be a list of op names.");
      const contract = d.requires.bridgeContract;
      if (
        contract !== undefined &&
        !(Number.isInteger(contract) && (contract as number) > 0)
      )
        add(
          "requires.bridgeContract",
          "bridgeContract must be a contract version (a whole number)."
        );
    }
  }

  const defaults = d.defaults;
  if (!isRecord(defaults)) add("defaults", "defaults is missing.");
  else {
    /** A default names a cell of the bundle that draws its slot. */
    const names = (
      key: unknown,
      path: string,
      draws: (cell: Record<string, unknown>) => boolean,
      slot: string
    ) => {
      if (key === undefined) return;
      const cell = typeof key === "string" ? keys.get(key) : undefined;
      if (!cell) add(path, `"${String(key)}" is not a cell of this bundle.`);
      else if (!draws(cell)) add(path, `"${key}" does not draw ${slot}.`);
    };
    for (const slot of ["entity-card", "entity-detail"] as const)
      names(
        defaults[slot],
        `defaults.${slot}`,
        (cell) => cell.contentKind === slot,
        `the ${slot} slot`
      );
    if (defaults.views !== undefined) {
      if (!isRecord(defaults.views))
        add("defaults.views", "views must map a view type to a cell.");
      else
        for (const [viewType, key] of Object.entries(defaults.views))
          names(
            key,
            `defaults.views.${viewType}`,
            (cell) =>
              Array.isArray(cell.viewTypes) &&
              cell.viewTypes.includes(viewType),
            `the ${viewType} view`
          );
    }
    for (const name of Object.keys(defaults)) {
      if (!["entity-card", "entity-detail", "views"].includes(name))
        add(`defaults.${name}`, `"${name}" is not a default slot.`);
    }
  }
  return problems;
}
