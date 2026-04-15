type TrustedIssuerSeedHealth = {
  ok: boolean;
  checkedAt: string;
  error?: string;
};

let trustedIssuerSeedHealth: TrustedIssuerSeedHealth = {
  ok: false,
  checkedAt: new Date(0).toISOString(),
  error: "not_checked",
};

export function setTrustedIssuerSeedHealth(
  status: Omit<TrustedIssuerSeedHealth, "checkedAt">
): void {
  trustedIssuerSeedHealth = {
    ...status,
    checkedAt: new Date().toISOString(),
  };
}

export function getTrustedIssuerSeedHealth(): TrustedIssuerSeedHealth {
  return trustedIssuerSeedHealth;
}
