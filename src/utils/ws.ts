/**
 * Sanitize a WebSocket close reason to be a valid ByteString (chars <= 255)
 * and at most 123 bytes (WebSocket spec limit).
 */
export function sanitizeCloseReason(reason: string): string {
  // Replace characters outside ByteString range (> 255) with '?'
  let sanitized = '';
  for (const ch of reason) {
    sanitized += ch.charCodeAt(0) > 255 ? '?' : ch;
  }
  if (sanitized.length > 123) {
    sanitized = sanitized.slice(0, 120) + '...';
  }
  return sanitized;
}
