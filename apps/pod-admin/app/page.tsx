import { redirect } from "next/navigation";

/**
 * Root → Overview. The pod-admin shell never renders at `/` directly;
 * every operator surface is a tab under `(admin)/<tab>`. The default
 * tab is Overview.
 */
export default function RootPage() {
  redirect("/overview");
}
