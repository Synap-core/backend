/**
 * Widget Compiler
 *
 * Compiles JSX/TSX widget source into an IIFE bundle with shared externals.
 * Platform packages (React, Tamagui, tRPC, etc.) are resolved from
 * `window.__SYNAP_MODULES__` at runtime — not bundled into the output.
 *
 * This is the server-side counterpart of the browser's NativeWidgetLoader:
 *   AI writes JSX → compileWidgetSource() → stored in DB →
 *   browser loads via NativeWidgetLoader → cellRegistry.register()
 */

import * as esbuild from "esbuild";

/**
 * Packages that are provided by the host app and must NOT be bundled.
 * These are resolved from `window.__SYNAP_MODULES__` at runtime.
 * Must match the keys in `shared-externals.ts` on the frontend.
 */
const SHARED_EXTERNALS = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "@synap-core/ui-system",
  "@synap/cell-runtime",
  "@synap/client",
  "zustand",
  "lucide-react",
];

/**
 * esbuild plugin that resolves shared externals to `window.__SYNAP_MODULES__[name]`.
 *
 * For each import like `import { YStack } from '@synap-core/ui-system'`,
 * the output becomes `const { YStack } = window.__SYNAP_MODULES__['@synap-core/ui-system']`.
 */
const synapExternalsPlugin: esbuild.Plugin = {
  name: "synap-externals",
  setup(build) {
    // Build a filter that matches any of the external package names
    const filter = new RegExp(
      `^(${SHARED_EXTERNALS.map((ext) =>
        ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      ).join("|")})$`
    );

    build.onResolve({ filter }, (args) => ({
      path: args.path,
      namespace: "synap-external",
    }));

    build.onLoad({ filter: /.*/, namespace: "synap-external" }, (args) => ({
      contents: `module.exports = window.__SYNAP_MODULES__["${args.path}"];`,
      loader: "js",
    }));
  },
};

/**
 * Compile a JSX/TSX widget source string into an IIFE bundle.
 *
 * The output is a self-contained script that:
 * 1. Reads shared deps from `window.__SYNAP_MODULES__`
 * 2. Defines the widget component
 * 3. Writes a CellRegistration to `window.__SYNAP_MODULES__.__EXPORT__`
 *
 * The wrapper at the end extracts the default export and creates the
 * registration object that NativeWidgetLoader expects.
 *
 * @param source - JSX/TSX source with a default-exported React component
 * @returns Compiled JavaScript string (IIFE)
 * @throws Error if compilation fails (syntax errors, etc.)
 */
export async function compileWidgetSource(source: string): Promise<string> {
  // Wrap the user source to capture the default export into __EXPORT__
  const wrappedSource = `
${source}

// Auto-generated: export the default component as a CellRegistration
if (typeof exports.default === 'function') {
  const _mod = window.__SYNAP_MODULES__;
  _mod.__EXPORT__ = {
    component: exports.default,
    meta: exports.meta || {
      name: exports.default.displayName || exports.default.name || 'Widget',
      displayModes: ['compact', 'medium', 'full'],
    },
    defaultProps: exports.defaultProps || {},
    settingsComponent: exports.settingsComponent,
  };
}
`;

  const result = await esbuild.build({
    stdin: {
      contents: wrappedSource,
      loader: "tsx",
      resolveDir: "/tmp",
    },
    bundle: true,
    format: "iife",
    globalName: "__WIDGET__",
    plugins: [synapExternalsPlugin],
    write: false,
    minify: true,
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "react",
    // Avoid any file system access
    logLevel: "silent",
  });

  if (result.errors.length > 0) {
    const messages = result.errors.map((e) => e.text).join("\n");
    throw new Error(`Widget compilation errors:\n${messages}`);
  }

  const output = result.outputFiles?.[0]?.text;
  if (!output) {
    throw new Error("Widget compilation produced no output");
  }

  return output;
}
