import type { Env } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomBase64Url(byteLength: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(encoder.encode(value))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(value: string, keyBase64: string): Promise<string> {
  const keyBytes = base64ToBytes(keyBase64);
  if (keyBytes.length !== 32) throw new Error("RATE_LIMIT_HMAC_KEY must decode to 32 bytes.");
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, toArrayBuffer(encoder.encode(value))));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function encryptSecret(value: string, keyBase64: string): Promise<{
  ciphertext: string;
  iv: string;
  authTag: string;
}> {
  const keyBytes = base64ToBytes(keyBase64);
  if (keyBytes.length !== 32) throw new Error("CERTIFICATE_ENCRYPTION_KEY must decode to 32 bytes.");
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), tagLength: 128 },
    key,
    toArrayBuffer(encoder.encode(value))
  ));
  const split = sealed.length - 16;
  return {
    ciphertext: bytesToBase64(sealed.subarray(0, split)),
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(sealed.subarray(split))
  };
}

export async function decryptSecret(
  encrypted: { ciphertext: string; iv: string; authTag: string },
  keyBase64: string
): Promise<string> {
  const keyBytes = base64ToBytes(keyBase64);
  if (keyBytes.length !== 32) throw new Error("CERTIFICATE_ENCRYPTION_KEY must decode to 32 bytes.");
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["decrypt"]);
  const sealed = new Uint8Array([
    ...base64ToBytes(encrypted.ciphertext),
    ...base64ToBytes(encrypted.authTag)
  ]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(encrypted.iv)), tagLength: 128 },
    key,
    toArrayBuffer(sealed)
  );
  return decoder.decode(plaintext);
}

export function equalHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/i.test(left) || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function validateAccessToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("Order access token is not valid.");
  }
  if (base64UrlToBytes(value).length !== 32) {
    throw new Error("Order access token is not valid.");
  }
  return value;
}

export async function rateLimitIpHash(ip: string, env: Env): Promise<string> {
  return hmacHex(ip, env.RATE_LIMIT_HMAC_KEY);
}
