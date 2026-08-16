import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "./providers";

/**
 * SELF-HOSTED, deliberately — `next/font/google` fetches from
 * `fonts.gstatic.com` AT BUILD TIME, which made `docker build` depend on
 * Google being reachable from the build host. That is a real dependency, not a
 * theoretical one: the team pod's builder can reach the npm registry (its
 * `pnpm install --frozen-lockfile` succeeds) but not gstatic, so the image
 * build failed on `Failed to fetch JetBrains Mono` while the same commit built
 * fine on a host with open egress.
 *
 * The woff2 files in ./fonts are the same latin-subset files Google serves,
 * committed once. The build is now hermetic: no network, no third-party
 * uptime, identical output on every host.
 *
 * Keep `variable` and `display` identical to the previous google-font config —
 * `globals.css` consumes these CSS variables and nothing else changes.
 */
const dmSans = localFont({
  src: [
    { path: "./fonts/dm-sans-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/dm-sans-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/dm-sans-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/dm-sans-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-sans",
  display: "swap",
});

const fraunces = localFont({
  src: [
    { path: "./fonts/fraunces-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/fraunces-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/fraunces-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-heading",
  display: "swap",
});

const jetMono = localFont({
  src: [
    {
      path: "./fonts/jetbrains-mono-400.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/jetbrains-mono-500.woff2",
      weight: "500",
      style: "normal",
    },
  ],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pod Admin",
  description: "Operator-facing pod administration surface.",
};

// A managed Pod can move from a warm hostname to its claimed hostname without
// rebuilding the shared Pod Admin image. Read its public API origin at request
// time and expose only that safe, browser-required value to client modules.
export const dynamic = "force-dynamic";

function runtimeConfigScript(): string {
  const podUrl = process.env.POD_PUBLIC_URL?.trim() ?? "";
  return `window.__SYNAP_POD_ADMIN_RUNTIME__=${JSON.stringify({ podUrl }).replace(/</g, "\\u003c")};`;
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${dmSans.variable} ${fraunces.variable} ${jetMono.variable}`}
    >
      <body
        suppressHydrationWarning
        className="bg-background text-foreground antialiased min-h-screen font-sans"
      >
        <script dangerouslySetInnerHTML={{ __html: runtimeConfigScript() }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
