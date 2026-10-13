import { redirect } from "next/navigation";
import { navHref } from "../lib/console-nav";

/**
 * Root → Home. The console shell never renders at `/` directly; every
 * surface is a page under `(admin)/<page>`, and Home is where it opens.
 */
export default function RootPage() {
  redirect(navHref("home"));
}
