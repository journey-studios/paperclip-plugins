import test from "node:test";
import assert from "node:assert/strict";
import { sanitize, sanitizeModelText, stripCommentDelimiters } from "./github-text.js";

test("comment delimiters cannot be reassembled", () => {
  assert.equal(stripCommentDelimiters("<!<!----"), "");
  assert.equal(stripCommentDelimiters("a <!-- hidden --> b"), "a  hidden  b");
});

test("sanitize defuses mentions and control characters and bounds the length", () => {
  assert.equal(sanitize("ping @octocat now", 100), "ping @\u200boctocat now");
  assert.equal(sanitize("a\u0000b", 100), "ab");
  assert.equal(sanitize("x".repeat(50), 10).length, 10);
});

test("model text loses images, link targets and raw HTML", () => {
  const out = sanitizeModelText("see ![t](http://evil/p.png) and [docs](http://evil/x) <img src=x onerror=1> <b>bold</b>\n\nnext @user", 500);
  assert.ok(!out.includes("http://evil"));
  assert.ok(!out.includes("<"));
  assert.ok(out.includes("docs"));
  assert.ok(out.includes("@\u200buser"));
  assert.ok(!out.includes("\n"));
});
