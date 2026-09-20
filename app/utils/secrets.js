import crypto from "node:crypto";

// Merchants' carrier keys are their money, so they're encrypted before they touch the
// database. Without ENCRYPTION_KEY the app refuses to store one rather than saving it in
// the clear: failing shut is the only safe direction here.
const ALGORITHM = "aes-256-gcm";

function key() {
  // eslint-disable-next-line no-undef
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;

  // eslint-disable-next-line no-undef
  const bytes = Buffer.from(raw, raw.length === 64 ? "hex" : "base64");
  return bytes.length === 32 ? bytes : null;
}

export function encryptionAvailable() {
  return key() !== null;
}

// Returns "iv.ciphertext.tag", all base64, so one column holds everything needed to read it.
export function encryptSecret(plain) {
  const secret = key();
  if (!secret || !plain) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, secret, iv);
  // eslint-disable-next-line no-undef
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);

  return [iv.toString("base64"), encrypted.toString("base64"), cipher.getAuthTag().toString("base64")].join(".");
}

export function decryptSecret(payload) {
  const secret = key();
  if (!secret || !payload) return null;

  const [iv, encrypted, tag] = payload.split(".");
  if (!iv || !encrypted || !tag) return null;

  try {
    // eslint-disable-next-line no-undef
    const decipher = crypto.createDecipheriv(ALGORITHM, secret, Buffer.from(iv, "base64"));
    // eslint-disable-next-line no-undef
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    // eslint-disable-next-line no-undef
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // A key that was rotated, or a tampered value. Either way it's unusable.
    return null;
  }
}
