import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hintFeedPath, publishHookHint, readRecentHookHints } from "../../src/hooks/hint-feed.js";
import { defaultConfig } from "../../src/router/core/config.js";

test("Hook display feed keeps five recent summaries without prompt text or skill paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-hook-feed-"));
  const config = defaultConfig();
  config.logging.auditFile = join(directory, "events.jsonl");
  for (let index = 0; index < 6; index += 1) {
    await publishHookHint(config, { cwd: "/workspace/example", sessionId: `thread-${index}` }, index === 5
      ? "Agent Dock Skill 候选（仅供核对）：\n- pdf: /private/skills/pdf/SKILL.md\n可能互斥：pdf / documents。用户留有会影响结果的选择"
      : undefined);
  }
  const events = await readRecentHookHints(config);
  assert.equal(events.length, 5);
  assert.equal(events[0]?.threadId, "thread-5");
  assert.deepEqual(events[0]?.candidateNames, ["pdf"]);
  assert.equal(events[0]?.hasAlternatives, true);
  assert.equal(events[0]?.unresolvedChoice, true);
  assert.equal(events[0]?.projectName, "example");
  assert.equal(events[4]?.threadId, "thread-1");
  const path = hintFeedPath(config);
  assert(path);
  const files = await readdir(path);
  assert.equal(files.length, 5);
  for (const file of files) {
    const saved = await readFile(join(path, file), "utf8");
    assert.doesNotMatch(saved, /\/private\/skills|用户原始提示/);
  }
});
