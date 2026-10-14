import { redirect } from "next/navigation";

/** `/governance` opens its first page. */
export default function GovernancePage() {
  redirect("/governance/agents");
}
