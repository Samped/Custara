import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function keyMaterial() {
  const secret = process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("ENCRYPTION_KEY (or SESSION_SECRET) must be set to at least 16 characters");
  }
  return createHash("sha256").update(secret).digest();
}

/** AES-256-GCM encrypt; returns base64(iv:tag:ciphertext) */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptField(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyMaterial(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function last4(value: string) {
  const cleaned = value.replace(/\s+/g, "");
  return cleaned.slice(-4);
}

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function maskAccount(last4Digits: string) {
  return `••••${last4Digits}`;
}

export function encryptWebhookSecret(secret: string): string {
  if (secret.startsWith("enc:")) return secret;
  return `enc:${encryptField(secret)}`;
}

export function decryptWebhookSecret(stored: string): string {
  if (stored.startsWith("enc:")) return decryptField(stored.slice(4));
  return stored;
}
