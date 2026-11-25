/**
 * The Surface model: UI anchored to an object (a view, a document, a bento, a
 * whiteboard, a cell…) and its find contract (`./model`).
 *
 * The host-app deprecation registry that used to live here moved to
 * `@synap-core/types/hosts` (founder, 23 Nov 2026: "surface" now means UI
 * anchored to an object; a browser app or a relay tab is a place in a HOST
 * app). Its old names below are aliases, kept so every importer keeps working.
 *
 * Pure + dependency-free — safe to import from browser (Electron), relay
 * (React Native), CLI, or server contexts (same contract as `./vocabulary`).
 */

// The Surface model (UI anchored to an object) and its find contract.
export * from "./model.js";

import {
  DEPRECATED_IN_HOSTS,
  deprecatedInHost,
  isDeprecatedInHost,
  type DeprecatedInHost,
  type HostApp,
} from "../hosts/index.js";

/** @deprecated `HostApp` (`@synap-core/types/hosts`). */
export type DeprecatedSurfaceHost = HostApp;
/** @deprecated `DeprecatedInHost` (`@synap-core/types/hosts`). */
export type DeprecatedSurface = DeprecatedInHost;
/** @deprecated `DEPRECATED_IN_HOSTS` (`@synap-core/types/hosts`). */
export const DEPRECATED_SURFACES = DEPRECATED_IN_HOSTS;
/** @deprecated `deprecatedInHost` (`@synap-core/types/hosts`). */
export const deprecatedSurfacesFor = deprecatedInHost;
/** @deprecated `isDeprecatedInHost` (`@synap-core/types/hosts`). */
export const isDeprecatedSurface = isDeprecatedInHost;
