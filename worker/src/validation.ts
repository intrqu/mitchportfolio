import type { NewOrder } from "./types.js";

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} is required.`);
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

export function parseNewOrder(data: unknown): NewOrder {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Order details are required.");
  }
  const input = data as Record<string, unknown>;
  if (!Number.isSafeInteger(input.amountCents) || Number(input.amountCents) < 1) {
    throw new Error("Enter a valid amount greater than zero.");
  }
  if (input.recipientType !== "self" && input.recipientType !== "other") {
    throw new Error("Choose whether the certificate is for you or someone else.");
  }
  const purchaserName = requiredString(input.purchaserName, "Your name", 120);
  const purchaserEmail = email(input.purchaserEmail, "Your email");
  const recipientName = input.recipientType === "self"
    ? purchaserName
    : requiredString(input.recipientName, "Recipient name", 120);
  const recipientEmail = input.recipientType === "self"
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
    recipientType: input.recipientType,
    message: input.message.trim()
  };
}

export function parseEmailAllowlist(value: string): Set<string> {
  return new Set(value.split(",").map((emailAddress) => emailAddress.trim().toLowerCase()).filter(Boolean));
}

export function assertAllowedRecipients(recipients: string[], allowlistValue: string): void {
  const allowed = parseEmailAllowlist(allowlistValue);
  if (!allowed.size || recipients.some((recipient) => !allowed.has(recipient.toLowerCase()))) {
    throw new Error("Staging email is limited to configured test inboxes.");
  }
}

export function normalizeRedemptionCode(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a redemption code.");
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^MHTTEST[0-9A-F]{32}$/.test(normalized)) {
    throw new Error("That test redemption code is not valid.");
  }
  return normalized;
}

export function validateRequestId(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("A valid request ID is required.");
  }
  return value.toLowerCase();
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
