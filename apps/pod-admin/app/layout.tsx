import type { Metadata } from "next";
import { DM_Sans, Fraunces, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-heading",
  display: "swap",
});

const jetMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
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
