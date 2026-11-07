import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ProcessManager } from "../src/tools/process-manager.js";

function makeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function makeManager(options = {}) {
  const children = [];
  const killCalls = [];
  const manager = new ProcessManager({
    platform: "linux",
    resolveLaunchPlanImpl: ({ program, argv }) => ({ command: program, args: argv, shell: false }),
    spawnImpl: () => {
      const child = makeChild(1000 + children.length);
      children.push(child);
      return child;
    },
    killProcessTreeImpl: async (pid, signal) => {
      killCalls.push({ pid, signal });
      return options.kill?.(children[pid - 1000], signal, killCalls.length);
    },
    ...options.managerOptions,
  });
  return { manager, children, killCalls };
}

function start(manager) {
  return manager.start({ program: "node", argv: ["-e", "0"], cwd: process.cwd() });
}

test("concurrent stop calls share one process-tree termination and await close", async () => {
  const { manager, children, killCalls } = makeManager({
    kill: (child) => setImmediate(() => child.emit("close", 0, null)),
  });
  const started = start(manager);
  const [first, second] = await Promise.all([
    manager.stop(started.processId),
    manager.stop(started.processId),
  ]);
  assert.equal(killCalls.length, 1);
  assert.equal(first.status, "exited");
  assert.equal(second.status, "exited");
  assert.equal(manager.read(started.processId).status, "exited");
  children[0].stdout.end();
  children[0].stderr.end();
});

test("stop escalates from SIGTERM to SIGKILL when graceful exit is not observed", async () => {
  const { manager, children, killCalls } = makeManager({
    managerOptions: { stopGraceMs: 5, forceStopGraceMs: 20 },
    kill: (child, signal, count) => {
      if (count === 2) setImmediate(() => child.emit("close", null, "SIGKILL"));
    },
  });
  const started = start(manager);
  const result = await manager.stop(started.processId);
  assert.deepEqual(killCalls.map((call) => call.signal), ["SIGTERM", "SIGKILL"]);
  assert.equal(result.status, "exited");
  children[0].stdout.end();
  children[0].stderr.end();
});

test("unconfirmed process exit is never reported as exited", async () => {
  const { manager, children } = makeManager({
    managerOptions: { stopGraceMs: 5, forceStopGraceMs: 5 },
  });
  const started = start(manager);
  const result = await manager.stop(started.processId);
  assert.equal(result.status, "completion_unknown");
  children[0].emit("close", null, "SIGKILL");
  assert.equal(manager.read(started.processId).status, "exited");
  children[0].stdout.end();
  children[0].stderr.end();
});

test("process history evicts only oldest confirmed-closed records", async () => {
  const { manager, children } = makeManager({
    managerOptions: { maxProcesses: 2 },
  });
  const first = start(manager);
  children[0].emit("close", 0, null);
  const second = start(manager);
  children[1].emit("close", 0, null);
  const third = start(manager);
  assert.throws(() => manager.read(first.processId), /Unknown process/);
  assert.equal(manager.list().length, 2);
  assert.equal(manager.read(second.processId).status, "exited");
  assert.equal(manager.read(third.processId).status, "running");
  children[2].emit("close", 0, null);
  for (const child of children) {
    child.stdout.end();
    child.stderr.end();
  }
});

test("capacity rejects new process when every retained process is active", () => {
  const { manager, children } = makeManager({
    managerOptions: { maxProcesses: 1 },
  });
  start(manager);
  assert.throws(() => start(manager), (error) => error.code === "PROCESS_CAPACITY_REACHED");
  children[0].emit("close", 0, null);
  children[0].stdout.end();
  children[0].stderr.end();
});

test("detected URL metadata has a unique-item cap and explicit truncation flag", () => {
  const { manager, children } = makeManager({
    managerOptions: { maxDetectedUrls: 1 },
  });
  const started = start(manager);
  children[0].stdout.write("http://localhost:3000 http://127.0.0.1:4000 http://localhost:3000");
  const result = manager.read(started.processId);
  assert.deepEqual(result.detectedUrls, ["http://localhost:3000"]);
  assert.equal(result.detectedUrlsTruncated, true);
  children[0].emit("close", 0, null);
  children[0].stdout.end();
  children[0].stderr.end();
});

test("stop remains bounded when process-tree kill requests never settle", async () => {
  const { manager } = makeManager({
    managerOptions: {
      stopGraceMs: 5,
      forceStopGraceMs: 5,
      killRequestTimeoutMs: 5,
    },
    kill: () => new Promise(() => {}),
  });
  const started = start(manager);
  const before = Date.now();
  const result = await manager.stop(started.processId);
  assert.equal(result.status, "completion_unknown");
  assert.ok(Date.now() - before < 500);
});
