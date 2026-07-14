"use strict";

/**
 * Durable replay receipts for the optional Pod agent.
 *
 * The Pod agent cannot assume a Pod database is available while it is asked to
 * restore, suspend, or update that same Pod. A named local volume therefore
 * stores an issuer-qualified, hashed JWT ID with atomic create semantics.
 * This remains provider-agnostic and continues to work across agent restarts.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RECEIPT_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;

function receiptFileName(issuerUrl, jti) {
  return `${crypto
    .createHash("sha256")
    .update(`${issuerUrl}\u0000${jti}`)
    .digest("hex")}.json`;
}

function ensureReceiptDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function fsyncReceiptDirectory(directory) {
  const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
}

function cleanupExpiredReceipts(directory, now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (!RECEIPT_FILE_PATTERN.test(entry)) continue;
    const filePath = path.join(directory, entry);
    try {
      const receipt = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (
        typeof receipt.expiresAt !== "number" ||
        !Number.isFinite(receipt.expiresAt) ||
        receipt.expiresAt <= now
      ) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      // A corrupted or unreadable receipt must remain fail-closed: retaining
      // the filename is safer than reopening a possibly replayed command.
      if (error && error.code === "ENOENT") continue;
    }
  }
}

/**
 * Atomically consume one issuer-scoped signed-command ID.
 *
 * @returns {"consumed" | "replayed"}
 */
function consumePodAgentReceipt({
  directory,
  issuerUrl,
  jti,
  expiresAt,
  now = Date.now(),
}) {
  if (!issuerUrl || !jti || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("invalid pod-agent replay receipt");
  }

  ensureReceiptDirectory(directory);
  cleanupExpiredReceipts(directory, now);

  const filePath = path.join(directory, receiptFileName(issuerUrl, jti));
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(filePath, "wx", 0o600);
  } catch (error) {
    if (error && error.code === "EEXIST") return "replayed";
    throw error;
  }

  try {
    fs.writeFileSync(
      fileDescriptor,
      JSON.stringify({ expiresAt, consumedAt: now })
    );
    // Make the receipt durable before the command can mutate Pod state.
    fs.fsyncSync(fileDescriptor);
  } catch (error) {
    // Keep a partially-written receipt fail-closed. Retrying the command is
    // safer only after an operator has inspected the local state directory.
    fs.closeSync(fileDescriptor);
    throw error;
  }

  fs.closeSync(fileDescriptor);
  // The receipt file's contents are durable only after the directory entry is
  // durable too. Without this sync, a power loss could resurrect the command
  // after a successful response but before the filesystem journals its name.
  fsyncReceiptDirectory(directory);
  return "consumed";
}

module.exports = {
  cleanupExpiredReceipts,
  consumePodAgentReceipt,
  fsyncReceiptDirectory,
  receiptFileName,
};
