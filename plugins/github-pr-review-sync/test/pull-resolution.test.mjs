import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPullRefsFromText,
  pullRefFromWorkProductMetadata,
} from "../src/pull-resolution.js";

test("extractPullRefsFromText finds GitHub pull URLs", () => {
  const text = "See https://github.com/wallynm/tesselapp/pull/372 and also https://github.com/org/repo/pull/1/files";
  const refs = extractPullRefsFromText(text);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], { owner: "wallynm", repo: "tesselapp", number: 372 });
});

test("pullRefFromWorkProductMetadata parses repo metadata", () => {
  assert.deepEqual(pullRefFromWorkProductMetadata({ repo: "wallynm/tesselapp", number: 372 }), {
    owner: "wallynm",
    repo: "tesselapp",
    number: 372,
  });
  assert.equal(pullRefFromWorkProductMetadata({}), null);
});
