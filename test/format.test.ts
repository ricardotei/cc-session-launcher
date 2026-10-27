import assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import { relativeTime, tildify, truncate } from "../src/core/format";

const NOW = 1_800_000_000_000;
const s = (n: number) => n * 1000;
const m = (n: number) => n * 60_000;
const h = (n: number) => n * 3_600_000;
const d = (n: number) => n * 86_400_000;

describe("relativeTime", () => {
  it("says now under a minute", () => {
    assert.equal(relativeTime(NOW, NOW), "now");
    assert.equal(relativeTime(NOW - s(59), NOW), "now");
  });

  it("rounds down to minutes, hours, days, weeks", () => {
    assert.equal(relativeTime(NOW - s(60), NOW), "1m");
    assert.equal(relativeTime(NOW - m(5), NOW), "5m");
    assert.equal(relativeTime(NOW - m(59), NOW), "59m");
    assert.equal(relativeTime(NOW - h(1), NOW), "1h");
    assert.equal(relativeTime(NOW - h(3) - m(40), NOW), "3h");
    assert.equal(relativeTime(NOW - h(23), NOW), "23h");
    assert.equal(relativeTime(NOW - d(1), NOW), "1d");
    assert.equal(relativeTime(NOW - d(2), NOW), "2d");
    assert.equal(relativeTime(NOW - d(6), NOW), "6d");
    assert.equal(relativeTime(NOW - d(7), NOW), "1w");
    assert.equal(relativeTime(NOW - d(21), NOW), "3w");
    assert.equal(relativeTime(NOW - d(29), NOW), "4w");
  });

  it("switches to months and years", () => {
    assert.equal(relativeTime(NOW - d(30), NOW), "1mo");
    assert.equal(relativeTime(NOW - d(150), NOW), "5mo");
    assert.equal(relativeTime(NOW - d(364), NOW), "11mo");
    assert.equal(relativeTime(NOW - d(365), NOW), "1y");
    assert.equal(relativeTime(NOW - d(800), NOW), "2y");
  });

  it("treats future timestamps as now", () => {
    assert.equal(relativeTime(NOW + h(5), NOW), "now");
  });

  it("defaults now to the current time", () => {
    assert.equal(relativeTime(Date.now() - h(2) - m(1)), "2h");
  });
});

describe("truncate", () => {
  it("returns short text unchanged", () => {
    assert.equal(truncate("hello", 10), "hello");
    assert.equal(truncate("hello", 5), "hello");
  });

  it("collapses whitespace and trims", () => {
    assert.equal(truncate("  hello \n\t  world  ", 50), "hello world");
  });

  it("counts the ellipsis inside max", () => {
    const out = truncate("abcdefghij", 6);
    assert.equal(out, "abcde…");
    assert.equal(out.length, 6);
  });

  it("does not leave a space before the ellipsis", () => {
    assert.equal(truncate("hello world again", 7), "hello…");
  });

  it("handles degenerate limits", () => {
    assert.equal(truncate("abc", 1), "…");
    assert.equal(truncate("abc", 0), "");
    assert.equal(truncate("", 5), "");
  });

  it("never splits a surrogate pair", () => {
    const out = truncate("ab😀cd", 4); // cut would land inside the emoji
    assert.equal(out, "ab…");
    assert.doesNotThrow(() => encodeURIComponent(out));
  });
});

describe("tildify", () => {
  const home = os.homedir();

  it("replaces the home prefix", () => {
    assert.equal(tildify(`${home}/Projects/app`), "~/Projects/app");
    assert.equal(tildify(home), "~");
  });

  it("leaves other paths alone", () => {
    assert.equal(tildify("/var/tmp/x"), "/var/tmp/x");
    assert.equal(tildify(`${home}-other/x`), `${home}-other/x`);
  });
});
