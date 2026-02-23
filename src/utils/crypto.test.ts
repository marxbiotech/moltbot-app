import { describe, it, expect } from 'vitest';
import { timingSafeEqual } from './crypto';

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
