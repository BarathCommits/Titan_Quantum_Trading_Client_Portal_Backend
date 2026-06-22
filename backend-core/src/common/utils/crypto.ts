import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Encrypts plaintext using AES-256-GCM.
 * Outputs format: cipher:ciphertext_base64:iv_base64:auth_tag_base64
 */
export function encryptPII(
  plainText: string,
  encryptionKeyHex: string,
): string {
  if (!plainText) {
    return plainText;
  }
  const key = Buffer.from(encryptionKeyHex, 'hex'); // 32-byte key
  const iv = randomBytes(12); // Cryptographically secure 12-byte IV
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plainText, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');

  return `cipher:${encrypted}:${iv.toString('base64')}:${authTag}`;
}

/**
 * Decrypts ciphertext formatted as cipher:ciphertext_base64:iv_base64:auth_tag_base64.
 * Falls back to returning the input string unchanged if not prefixed with 'cipher:'.
 */
export function decryptPII(
  cipherTextWithMetadata: string,
  encryptionKeyHex: string,
): string {
  if (!cipherTextWithMetadata) {
    return cipherTextWithMetadata;
  }

  const parts = cipherTextWithMetadata.split(':');
  if (parts[0] !== 'cipher' || parts.length < 4) {
    return cipherTextWithMetadata; // Return plaintext fallback
  }

  const key = Buffer.from(encryptionKeyHex, 'hex');
  const [, encrypted, ivBase64, authTagBase64] = parts;

  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
