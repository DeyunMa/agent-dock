import assert from "node:assert/strict";
import test from "node:test";
import { parseOpenCodexModels } from "../../src/gateway/open-codex-catalog.js";

test("OpenCodex rich catalog exposes provider, effort and Fast capabilities", () => {
  assert.deepEqual(
    parseOpenCodexModels({
      models: [
        {
          slug: "google/gemini-test",
          display_name: "Gemini Test",
          default_reasoning_level: "high",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "high" },
          ],
          service_tiers: [],
        },
        {
          slug: "gpt-native",
          display_name: "GPT Native",
          supported_reasoning_levels: [{ effort: "medium" }],
          service_tiers: [{ id: "priority" }],
        },
      ],
    }),
    [
      {
        id: "google/gemini-test",
        displayName: "Gemini Test",
        provider: "google",
        requiresGateway: true,
        reasoningEfforts: ["low", "high"],
        serviceTiers: [],
        capabilitiesKnown: true,
        defaultReasoningEffort: "high",
      },
      {
        id: "gpt-native",
        displayName: "GPT Native",
        provider: "openai",
        requiresGateway: false,
        reasoningEfforts: ["medium"],
        serviceTiers: ["priority"],
        capabilitiesKnown: true,
      },
    ],
  );
});

test("OpenCodex list fallback keeps unknown capabilities explicit", () => {
  assert.deepEqual(
    parseOpenCodexModels({
      data: [{ id: "deepseek/model", owned_by: "deepseek" }],
    }),
    [
      {
        id: "deepseek/model",
        displayName: "deepseek/model",
        provider: "deepseek",
        requiresGateway: true,
        reasoningEfforts: [],
        serviceTiers: [],
        capabilitiesKnown: false,
      },
    ],
  );
});
