/**
 * Constant-time string comparison to prevent timing attacks.
 * Iterates max(a, b) length; leaks only max length, not the secret's exact length.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

/**
 * Compute HMAC-SHA256 hex string using Web Crypto API.
 */
async function hmacSha256(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a Slack request signature.
 * Slack signs: v0=HMAC-SHA256(signing_secret, "v0:timestamp:body")
 */
export async function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const expected = `v0=${await hmacSha256(signingSecret, `v0:${timestamp}:${body}`)}`;
  return timingSafeEqual(expected, signature);
}

/**
 * Generate a fresh Slack-format signature for internal delivery.
 * Used by queue consumer to re-sign messages after queue delay
 * would make the original timestamp stale (>5min Bolt limit).
 */
export async function signSlackRequest(
  signingSecret: string,
  body: string,
): Promise<{ timestamp: string; signature: string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `v0=${await hmacSha256(signingSecret, `v0:${timestamp}:${body}`)}`;
  return { timestamp, signature };
}
