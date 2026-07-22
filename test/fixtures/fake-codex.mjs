#!/usr/bin/env node
import { createInterface } from "node:readline";
import WebSocket from "ws";

if (process.argv.includes("app-server")) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    } else if (message.method === "thread/read") {
      process.stdout.write(
        `${JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: message.params.threadId,
              name: "Fake Router Session",
              preview: "Inspect and fix the Router timing",
              cwd: "/tmp/fake-project",
              source: "vscode",
              createdAt: 100,
              updatedAt: 200,
              recencyAt: 300,
            },
          },
        })}\n`,
      );
    } else if (message.method === "model/list") {
      process.stdout.write(
        `${JSON.stringify({
          id: message.id,
          result: {
            data: [
              {
                id: "gpt-5.6-luna",
                supportedReasoningEfforts: [{ reasoningEffort: "low" }],
                serviceTiers: [{ id: "priority" }],
              },
              {
                id: "gpt-5.6-terra",
                supportedReasoningEfforts: [
                  { reasoningEffort: "medium" },
                  { reasoningEffort: "max" },
                ],
                serviceTiers: [{ id: "priority" }],
              },
              {
                id: "gpt-5.6-sol",
                supportedReasoningEfforts: [
                  { reasoningEffort: "high" },
                  { reasoningEffort: "xhigh" },
                ],
                serviceTiers: [{ id: "priority" }],
              },
            ],
          },
        })}\n`,
      );
    } else if (message.method === "turn/start") {
      process.stdout.write(`${JSON.stringify({ id: 99, result: message.params })}\n`);
      process.stdout.write(
        `${JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: message.params.threadId,
            turn: { id: "fake-turn", status: "completed", items: [] },
          },
        })}\n`,
      );
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
  process.exit(0);
}

if (process.argv.includes("exec") || process.argv.includes("e")) {
  await new Promise((resolve) => setTimeout(resolve, 600));
  process.stdout.write("fake exec complete\n");
  process.exit(0);
}

const remoteIndex = process.argv.indexOf("--remote");
const remote = remoteIndex >= 0 ? process.argv[remoteIndex + 1] : undefined;
if (!remote) process.exit(2);
const socket = new WebSocket(remote);
socket.on("open", () => {
  socket.send(JSON.stringify({ id: 1, method: "model/list", params: {} }));
});
socket.on("message", (data) => {
  const message = JSON.parse(data.toString());
  if (message.id === 1) {
    socket.send(
      JSON.stringify({
        id: 2,
        method: "turn/start",
        params: {
          threadId: "fake-thread",
          input: [{ type: "text", text: "请解释什么是幂等性" }],
          model: "original",
          effort: "medium",
          serviceTier: null,
        },
      }),
    );
  } else if (message.id === 99) {
    process.stdout.write(`${JSON.stringify(message.result)}\n`);
    socket.close();
  }
});
socket.on("close", () => process.exit(0));
socket.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(3);
});
