import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycleGuard } from "../src/desktop/lifecycle-guard.js";
import { DesktopAgentService } from "../src/desktop/agent-service.js";

test("lifecycle guard rejects overlapping mutations and releases after failure", async () => {
  const guard = createLifecycleGuard();
  const release = guard.enter("start");
  assert.equal(guard.activeOperation, "start");
  assert.throws(() => guard.enter("resume"), (error) => error.code === "DESKTOP_LIFECYCLE_BUSY");
  let idle = false;
  const waiting = guard.waitForIdle().then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false);
  release();
  release();
  await waiting;
  assert.equal(guard.activeOperation, null);
  const nextRelease = guard.enter("resume");
  nextRelease();
});

test("cancel resolves and removes every pending approval exactly once", async () => {
  const service = new DesktopAgentService();
  service.adapter = { escCancelRequested: false };
  service.running = true;
  const outcomes = [];
  service.pendingApprovals.set("one", { resolve: (value) => outcomes.push(["one", value]), toolName: "file.write" });
  service.pendingApprovals.set("two", { resolve: (value) => outcomes.push(["two", value]), toolName: "terminal.exec" });

  assert.equal(service.cancel(), true);
  assert.equal(service.adapter.escCancelRequested, true);
  assert.deepEqual(outcomes, [["one", false], ["two", false]]);
  assert.equal(service.pendingApprovals.size, 0);
  assert.equal(await service.respondApproval("one", "allow"), false);
  assert.equal(outcomes.length, 2);
});

test("close denies approvals before closing the adapter and is idempotent", async () => {
  const service = new DesktopAgentService();
  const order = [];
  service.adapter = { close: async () => { order.push("adapter-close"); } };
  service.pendingApprovals.set("pending", {
    resolve: (value) => order.push(value ? "approved" : "denied"),
    toolName: "file.write",
  });

  await service.close();
  await service.close();
  assert.deepEqual(order, ["denied", "adapter-close"]);
  assert.equal(service.pendingApprovals.size, 0);
  assert.equal(service.closed, true);
});

test("concurrent close calls await the same adapter shutdown", async () => {
  const service = new DesktopAgentService();
  let releaseAdapter;
  let closeCalls = 0;
  service.adapter = {
    close: () => {
      closeCalls += 1;
      return new Promise((resolve) => { releaseAdapter = resolve; });
    },
  };
  let firstSettled = false;
  let secondSettled = false;
  const first = service.close().then(() => { firstSettled = true; });
  const second = service.close().then(() => { secondSettled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closeCalls, 1);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  releaseAdapter();
  await Promise.all([first, second]);
  assert.equal(firstSettled, true);
  assert.equal(secondSettled, true);
  assert.equal(closeCalls, 1);
});
