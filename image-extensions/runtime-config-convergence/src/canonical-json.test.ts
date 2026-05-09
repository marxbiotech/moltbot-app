import { describe, it, expect } from "vitest";
import { canonicalStringify, hashValue, sha256Hex } from "./canonical-json.js";

describe("canonicalStringify", () => {
  it("produces stable output regardless of object key order", () => {
    const a = { b: 1, a: 2, c: { d: 3, e: 4 } };
    const b = { c: { e: 4, d: 3 }, a: 2, b: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("preserves array order", () => {
    expect(canonicalStringify([1, 2, 3])).toBe("[1,2,3]");
    expect(canonicalStringify([3, 2, 1])).toBe("[3,2,1]");
  });

  it("strips undefined keys but preserves null", () => {
    expect(canonicalStringify({ a: undefined, b: null })).toBe(`{"b":null}`);
  });

  it("normalizes non-finite numbers to null", () => {
    expect(canonicalStringify(NaN)).toBe("null");
    expect(canonicalStringify(Infinity)).toBe("null");
  });

  it("handles deeply nested objects with mixed key orders identically", () => {
    const a = { x: { y: { z: 1, a: 2 }, m: 3 } };
    const b = { x: { m: 3, y: { a: 2, z: 1 } } };
    expect(hashValue(a)).toBe(hashValue(b));
  });
});

describe("hashValue / sha256Hex", () => {
  it("returns 64-char hex strings", () => {
    expect(hashValue("hello")).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256Hex("hello")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("differs for different values", () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });

  it("hash of canonical string equals direct sha256", () => {
    const v = { z: 1, a: 2 };
    expect(hashValue(v)).toBe(sha256Hex(canonicalStringify(v)));
  });
});
