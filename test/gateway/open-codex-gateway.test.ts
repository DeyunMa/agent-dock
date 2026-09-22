import assert from "node:assert/strict";
import test from "node:test";
import { isOpenCodexRouteUrl } from "../../src/gateway/open-codex-gateway.js";

test("OpenCodex routing recognizes legacy and context-compatible Codex paths", () => {
  const base = "http://127.0.0.1:10100";
  assert.equal(isOpenCodexRouteUrl("http://127.0.0.1:10100/v1", base), true);
  assert.equal(isOpenCodexRouteUrl("http://127.0.0.1:10100/v1/", base), true);
  assert.equal(
    isOpenCodexRouteUrl("http://127.0.0.1:10100/backend-api/codex", base),
    true,
  );
});

test("OpenCodex routing rejects a different origin or endpoint", () => {
  const base = "http://127.0.0.1:10100";
  assert.equal(isOpenCodexRouteUrl("http://127.0.0.1:10101/backend-api/codex", base), false);
  assert.equal(isOpenCodexRouteUrl("https://127.0.0.1:10100/backend-api/codex", base), false);
  assert.equal(isOpenCodexRouteUrl("http://127.0.0.1:10100/backend-api/codex/responses", base), false);
  assert.equal(isOpenCodexRouteUrl("http://127.0.0.1:10100/v1?target=other", base), false);
});
