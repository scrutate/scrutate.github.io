// Unit tests of the playground's input parsing: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { parseRepo, cleanPath } from "../playground/load.js";

const repo = (owner, name, ref = "", sub = "") => ({ owner, repo: name, ref, sub });

test("owner/name and its @ref form", () => {
  assert.deepEqual(parseRepo("o/r"), repo("o", "r"));
  assert.deepEqual(parseRepo("o/r@v1.2"), repo("o", "r", "v1.2"));
  // git allows # in a branch name; only a URL has a fragment to drop
  assert.deepEqual(parseRepo("o/r@fix#12"), repo("o", "r", "fix#12"));
});

test("github.com links", () => {
  assert.deepEqual(parseRepo("https://github.com/o/r"), repo("o", "r"));
  assert.deepEqual(parseRepo("github.com/o/r.git#readme"), repo("o", "r"));
  assert.deepEqual(parseRepo("https://github.com/o/r/tree/v1.2/"), repo("o", "r", "v1.2"));
  assert.deepEqual(parseRepo("https://github.com/o/r/tree/main/src/lib?x=1#y"), repo("o", "r", "main", "src/lib"));
  assert.deepEqual(parseRepo("https://github.com/o/r/blob/main/src/a.rs"), repo("o", "r", "main", "src"));
  // a pasted link has its folder names percent-encoded
  assert.deepEqual(parseRepo("https://github.com/o/r/tree/main/my%20dir"), repo("o", "r", "main", "my dir"));
});

test("an SSH remote", () => {
  assert.deepEqual(parseRepo("git@github.com:o/r.git"), repo("o", "r"));
});

test("text that names no repository", () => {
  assert.equal(parseRepo("not a repo"), null);
  assert.equal(parseRepo("https://gitlab.com/o/r"), null);
});

test("a folder path written by hand", () => {
  assert.equal(cleanPath("/a//b/"), "a/b");
  assert.equal(cleanPath("a"), "a");
  assert.equal(cleanPath("/"), "");
  assert.equal(cleanPath(""), "");
});
