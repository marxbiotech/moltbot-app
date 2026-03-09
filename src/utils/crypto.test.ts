import { describe, it, expect } from 'vitest';
import { timingSafeEqual, verifySlackSignature, signSlackRequest } from './crypto';

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });

  it('returns false for strings of different lengths', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('returns false when one string is empty', () => {
    expect(timingSafeEqual('', 'a')).toBe(false);
  });

  it('handles long strings', () => {
    const a = 'x'.repeat(1000);
    const b = 'x'.repeat(1000);
    expect(timingSafeEqual(a, b)).toBe(true);
  });

  it('detects single character difference', () => {
    const a = 'secret-token-abc123';
    const b = 'secret-token-abc124';
    expect(timingSafeEqual(a, b)).toBe(false);
  });
});

describe('verifySlackSignature', () => {
  const secret = 'test-signing-secret';
  const body = '{"type":"event_callback"}';

  it('returns true for a known-good signature', async () => {
    const signed = await signSlackRequest(secret, body);
    expect(await verifySlackSignature(secret, signed.timestamp, body, signed.signature)).toBe(true);
  });

  it('returns false for tampered signature', async () => {
    const signed = await signSlackRequest(secret, body);
    // Flip the last hex char
    const lastChar = signed.signature.slice(-1);
    const flipped = lastChar === '0' ? '1' : '0';
    const tampered = signed.signature.slice(0, -1) + flipped;
    expect(await verifySlackSignature(secret, signed.timestamp, body, tampered)).toBe(false);
  });

  it('returns false for tampered body', async () => {
    const signed = await signSlackRequest(secret, body);
    const alteredBody = body + 'x';
    expect(await verifySlackSignature(secret, signed.timestamp, alteredBody, signed.signature)).toBe(false);
  });

  it('returns false for wrong signing secret', async () => {
    const signed = await signSlackRequest(secret, body);
    expect(await verifySlackSignature('wrong-secret', signed.timestamp, body, signed.signature)).toBe(false);
  });
});

describe('signSlackRequest', () => {
  const secret = 'test-signing-secret';
  const body = '{"type":"event_callback"}';

  it('returns signature in v0= + 64 hex chars format', async () => {
    const { signature } = await signSlackRequest(secret, body);
    expect(signature).toMatch(/^v0=[0-9a-f]{64}$/);
  });

  it('returns numeric timestamp string', async () => {
    const { timestamp } = await signSlackRequest(secret, body);
    expect(timestamp).toMatch(/^\d+$/);
  });

  it('round-trips with verifySlackSignature', async () => {
    const { timestamp, signature } = await signSlackRequest(secret, body);
    expect(await verifySlackSignature(secret, timestamp, body, signature)).toBe(true);
  });

  it('round-trip fails with different body', async () => {
    const { timestamp, signature } = await signSlackRequest(secret, body);
    expect(await verifySlackSignature(secret, timestamp, 'different-body', signature)).toBe(false);
  });
});
