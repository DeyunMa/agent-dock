import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { VERSION } from "../../src/version.js";

test("CLI, package and macOS bundle versions stay aligned", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  const infoPlist = await readFile(
    new URL(
      "../../apps/macos/AgentDockBar/Resources/Info.plist",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(VERSION, "1.4.0");
  assert.equal(packageJson.version, VERSION);
  assert.match(
    infoPlist,
    new RegExp(
      `<key>CFBundleShortVersionString</key>\\s*<string>${VERSION.replaceAll(".", "\\.")}</string>`,
    ),
  );
});
