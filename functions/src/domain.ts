import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";

export type NewOrderInput = {
  amountCents: number;
  purchaserName: string;
  purchaserEmail: string;
  recipientName: string;
  recipientEmail: string;
  recipientType: "self" | "other";
  message: string;
};

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required.`);
  }
  const clean = value.trim();
  if (!clean || clean.length > maximum) {
    throw new Error(`${field} must be between 1 and ${maximum} characters.`);
  }
  return clean;
}

function email(value: unknown, field: string): string {
  const clean = requiredString(value, field, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new Error(`${field} must be a valid email address.`);
  }
  return clean;
}

export function parseNewOrder(data: unknown): NewOrderInput {
  if (!data || typeof data !== "object") {
    throw new Error("Order details are required.");
  }
  const input = data as Record<string, unknown>;
  if (!Number.isSafeInteger(input.amountCents) || Number(input.amountCents) < 1) {
    throw new Error("Enter a valid amount greater than zero.");
  }
  const recipientType = input.recipientType;
  if (recipientType !== "self" && recipientType !== "other") {
    throw new Error("Choose whether the certificate is for you or someone else.");
  }
  const purchaserName = requiredString(input.purchaserName, "Your name", 120);
  const purchaserEmail = email(input.purchaserEmail, "Your email");
  const recipientName = recipientType === "self"
    ? purchaserName
    : requiredString(input.recipientName, "Recipient name", 120);
  const recipientEmail = recipientType === "self"
    ? purchaserEmail
    : email(input.recipientEmail, "Recipient email");
  if (typeof input.message !== "string" || input.message.length > 500) {
    throw new Error("The personal message must be 500 characters or fewer.");
  }
  return {
    amountCents: Number(input.amountCents),
    purchaserName,
    purchaserEmail,
    recipientName,
    recipientEmail,
    recipientType,
    message: input.message.trim()
  };
}

export function createRedemptionCode(): string {
  const raw = randomBytes(16).toString("hex").toUpperCase();
  const groups = raw.match(/.{4}/g);
  if (!groups) throw new Error("Could not generate a redemption code.");
  return `MHT-${groups.join("-")}`;
}

export function validateAccessToken(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, "base64url").length !== 32) {
    throw new Error("Order access token is not valid.");
  }
  return value;
}

export function normalizeRedemptionCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Enter a redemption code.");
  }
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^MHT[0-9A-F]{32}$/.test(normalized)) {
    throw new Error("That redemption code is not valid.");
  }
  return normalized;
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type EncryptedValue = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

function decodeEncryptionKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("Certificate encryption key must decode to exactly 32 bytes.");
  }
  return key;
}

export function encryptValue(value: string, keyBase64: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeEncryptionKey(keyBase64), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}

export function decryptValue(encrypted: EncryptedValue, keyBase64: string): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    decodeEncryptionKey(keyBase64),
    Buffer.from(encrypted.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

export function validateRequestId(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("A valid request ID is required.");
  }
  return value.toLowerCase();
}

export function isSameRedemption(
  existing: { amountCents: number; note: string } | undefined,
  amountCents: number,
  note: string
): boolean {
  if (!existing) return false;
  if (existing.amountCents !== amountCents || existing.note !== note) {
    throw new Error("This redemption request ID was already used for a different request.");
  }
  return true;
}

export function applyRedemption(amountRemaining: number, amountCents: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) {
    throw new Error("Enter a valid redemption amount greater than zero.");
  }
  if (!Number.isSafeInteger(amountRemaining) || amountRemaining < 0 || amountCents > amountRemaining) {
    throw new Error("Redemption exceeds the remaining balance.");
  }
  return amountRemaining - amountCents;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}
