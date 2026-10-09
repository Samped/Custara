import assert from "node:assert/strict";
import test from "node:test";
import { docHrefFromMarkdown, normalizeDocSource } from "../src/lib/docs";

test("markdown links resolve to /docs routes", () => {
  assert.equal(docHrefFromMarkdown("getting-started.md"), "/docs/getting-started");
  assert.equal(docHrefFromMarkdown("./README.md"), "/docs");
  assert.equal(docHrefFromMarkdown("security.md#mfa"), "/docs/security#mfa");
  assert.equal(docHrefFromMarkdown("https://example.com"), "https://example.com");
  assert.equal(docHrefFromMarkdown("../fixtures/README.md"), null);
});

test("hash-comment notes become a code block", () => {
  const source = ["# ERP adapters", "#", "#   POST /api/v1/erp/ingest", "# another", "# line", "# five", "# six", "# seven", "# eight"].join(
    "\n",
  );
  const normalized = normalizeDocSource(source);
  assert.match(normalized, /```/);
  assert.doesNotMatch(normalized.split("\n").slice(1).join("\n"), /^# /m);
});
