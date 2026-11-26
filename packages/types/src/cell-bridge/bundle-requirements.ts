/**
 * Whether THIS pod can run a renderer bundle: the bundle's `requires`
 * (`RendererBundleRequires`, `@synap-core/types/renderables`) read against
 * the contract compiled into this build — the bundle API, the frame contract
 * version and the bridge op tables. It lives beside the op tables because the
 * renderables subpath is a leaf that may not import them.
 */
import { RENDERER_BUNDLE_API } from "../renderables/renderer-bundle.js";
import { CELL_BRIDGE_CONTRACT_VERSION } from "./contract-version.js";
import { isCellBridgeReadOp } from "./read-ops.js";
import { isCellBridgeWriteOp } from "./write-ops.js";

/** The requirements this build of the contract can check. */
const KNOWN_REQUIREMENTS: ReadonlySet<string> = new Set([
  "bridgeContract",
  "bridgeOps",
]);

/** The frame contract this pod answers: the contract's own version. */
export const POD_BRIDGE_CONTRACT: number = CELL_BRIDGE_CONTRACT_VERSION;

/**
 * Every requirement of a bundle that THIS build of the contract does not
 * meet, as plain sentences; empty when the pod can run it. The pod's contract
 * is the one compiled into it: the bundle API it reads (`RENDERER_BUNDLE_API`)
 * and the bridge ops its hosts answer. Pure. Reads the definition loosely, so
 * it can say why before `validateRendererBundleDefinition` refuses the shape.
 */
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
