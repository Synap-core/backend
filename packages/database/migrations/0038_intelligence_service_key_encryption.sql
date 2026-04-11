-- Migration: Intelligence service API key encryption (application-layer)
--
-- The intelligence_services.api_key column now stores AES-256-GCM encrypted
-- values produced by encryptServiceKey() in packages/api/src/utils/service-key-crypto.ts
--
-- Encryption key: SYNAP_SERVICE_ENCRYPTION_KEY (or HUB_PROTOCOL_API_KEY fallback)
-- Cipher:         AES-256-GCM
-- Format:         JSON {"e": "<b64 ciphertext>", "i": "<b64 iv>", "t": "<b64 authTag>"}
--
-- Existing plaintext rows are handled by resolveServiceKey() which detects the
-- JSON format via isEncryptedServiceKey() and transparently falls back to
-- plaintext for legacy values — so no DB-level migration of existing rows is needed.
--
-- All new registrations (intelligenceRegistry.register) and key rotations
-- (intelligenceRegistry.rotateKey) write encrypted values automatically.

-- No DDL change needed: the column remains TEXT and holds either plaintext
-- (legacy) or the JSON cipher envelope (new).
SELECT 1; -- no-op to satisfy migration runner
