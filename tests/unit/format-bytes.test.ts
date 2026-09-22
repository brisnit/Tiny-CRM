import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { formatBytes } from "../../src/lib/utils";
import { LIMITS } from "../../src/lib/validation/limits";

/**
 * File sizes, as a person reads them.
 *
 * This exists because the five record pages that list files each inlined
 * `Math.round(sizeBytes / 1024) + " KB"`, and that expression is wrong in two
 * ways that matter: anything under half a kilobyte reports "0 KB" — so an empty
 * file and a real one look identical — and it never leaves kilobytes, so a
 * 40 MB video reads as "40960 KB".
 */

describe("formatBytes", () => {
  test("keeps the exact count below a kilobyte", () => {
    // The case the old inline expression got wrong.
    assert.equal(formatBytes(0), "0 bytes");
    assert.equal(formatBytes(1), "1 byte");
    assert.equal(formatBytes(511), "511 bytes");
    assert.equal(formatBytes(1023), "1023 bytes");
  });

  test("never reports a non-empty file as empty", () => {
    for (const size of [1, 12, 100, 511]) {
      assert.notEqual(formatBytes(size), "0 bytes", `${size} bytes rendered as empty`);
    }
  });

  test("switches to kilobytes at 1024", () => {
    assert.equal(formatBytes(1024), "1 KB");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(10 * 1024), "10 KB");
  });

  test("keeps one decimal only while it says something", () => {
    // 1.4 MB is meaningfully different from 1 MB; 512 MB and 512.3 MB are not.
    assert.equal(formatBytes(1.4 * 1024 * 1024), "1.4 MB");
    assert.equal(formatBytes(512.3 * 1024 * 1024), "512 MB");
  });

  test("climbs through the units", () => {
    assert.equal(formatBytes(1024 ** 2), "1 MB");
    assert.equal(formatBytes(1024 ** 3), "1 GB");
    assert.equal(formatBytes(1024 ** 4), "1 TB");
    // Past the last unit it stays in terabytes rather than inventing one.
    assert.equal(formatBytes(2048 * 1024 ** 4), "2048 TB");
  });

  test("describes the upload limit the way the error message does", () => {
    // src/lib/uploads.ts tells a user "Files must be 25 MB or smaller".
    assert.equal(formatBytes(LIMITS.maxUploadBytes), "25 MB");
  });

  test("refuses to invent a number it does not have", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.equal(formatBytes(bad), "—", `${bad} produced a size`);
    }
  });
});
