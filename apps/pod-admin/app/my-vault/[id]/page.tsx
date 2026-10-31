"use client";

/**
 * /my-vault/[id] — one of YOUR secrets: who may use it, what uses it, what
 * happened to it. Owner-only server-side (`secretsVault.getDetailBundle`
 * answers NOT_FOUND for a secret that is not yours); the `/my-vault` sub-path
 * is self-service in `lib/route-policy.ts`. Drawn by `SecretObject`.
 */

import { useParams } from "next/navigation";
import { useMemo } from "react";
import { useT } from "../../../lib/i18n/locale-provider";
import { consoleFrame } from "../../_lib/object/views/object-frame";
import { SECRET_CATALOGS } from "../_lib/copy";
import { SecretObject } from "../_lib/secret-object";

export default function MySecretPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT(SECRET_CATALOGS);
  const frame = useMemo(
    () =>
      consoleFrame({
        label: t("list"),
        href: "/my-vault",
        width: "personal",
      }),
    [t]
  );
  return <SecretObject id={id} frame={frame} />;
}
