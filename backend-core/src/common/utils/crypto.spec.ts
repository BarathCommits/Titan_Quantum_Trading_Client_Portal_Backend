import { encryptPII, decryptPII } from './crypto';

describe('Crypto Utility (AES-256-GCM)', () => {
  const testKeyHex =
    'd6f3e0a2b4c6d8e0f2a4b6c8d0e2f4a6d6f3e0a2b4c6d8e0f2a4b6c8d0e2f4a6';

  it('should encrypt and decrypt plaintext correctly', () => {
    const plainText = '123 Main St, Dublin, Ireland';
    const cipherText = encryptPII(plainText, testKeyHex);

    expect(cipherText).toBeDefined();
    expect(cipherText.startsWith('cipher:')).toBe(true);
    expect(cipherText.split(':').length).toBe(4);

    const decrypted = decryptPII(cipherText, testKeyHex);
    expect(decrypted).toBe(plainText);
  });

  it('should produce different ciphertexts for the same plaintext due to random IV', () => {
    const plainText = 'hello world';
    const cipherText1 = encryptPII(plainText, testKeyHex);
    const cipherText2 = encryptPII(plainText, testKeyHex);

    expect(cipherText1).not.toBe(cipherText2);
  });

  it('should return input string unchanged if not starting with cipher: prefix', () => {
    const plainText = 'plain unencrypted text';
    const decrypted = decryptPII(plainText, testKeyHex);
    expect(decrypted).toBe(plainText);
  });

  it('should handle empty or null values', () => {
    expect(encryptPII('', testKeyHex)).toBe('');
    expect(decryptPII('', testKeyHex)).toBe('');
  });
});
