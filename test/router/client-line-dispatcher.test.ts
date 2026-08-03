import assert from "node:assert/strict";
import test from "node:test";
import { ClientLineDispatcher } from "../../src/router/adapters/client-line-dispatcher.js";

test("slow classification blocks only its own thread", async () => {
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const written: string[] = [];
  const dispatcher = new ClientLineDispatcher(
    async (line) => {
      const message = JSON.parse(line) as { method: string; params?: { threadId?: string } };
      if (message.method === "turn/start" && message.params?.threadId === "thread-a") {
        await slow;
      }
      return line;
    },
    async (line) => {
      written.push(line);
    },
  );

  const slowTurn = JSON.stringify({ method: "turn/start", params: { threadId: "thread-a" } });
  const sameThread = JSON.stringify({ method: "turn/steer", params: { threadId: "thread-a" } });
  const otherThread = JSON.stringify({ method: "thread/read", params: { threadId: "thread-b" } });
  const global = JSON.stringify({ id: 1, method: "model/list", params: {} });
  dispatcher.dispatch(slowTurn);
  dispatcher.dispatch(sameThread);
  dispatcher.dispatch(otherThread);
  dispatcher.dispatch(global);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, [otherThread, global]);

  releaseSlow();
  await dispatcher.drain();
  assert.deepEqual(written, [otherThread, global, slowTurn, sameThread]);
});
