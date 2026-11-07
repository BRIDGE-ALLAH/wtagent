import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import supervisor from "../desktop/terminal-supervisor.cjs";
const { stopTerminalProcess, writeTerminalInput } = supervisor;

function terminalFixture() {
  const child = new EventEmitter();
  child.pid = 4567;
  const stdin = new EventEmitter();
  stdin.writable = true;
  stdin.destroyed = false;
  stdin.removeListener = EventEmitter.prototype.removeListener;
  child.stdin = stdin;
  let resolveClose;
  const terminal = {
    child,
    closed: false,
    closePromise: new Promise((resolve) => { resolveClose = resolve; }),
    stopPromise: null,
  };
  child.once("close", () => {
    terminal.closed = true;
    resolveClose();
  });
  return { terminal, child, stdin };
}

test("terminal stop shares one process-tree termination and awaits observed close", async () => {
  const { terminal, child } = terminalFixture();
  let calls = 0;
  const kill = async () => {
    calls += 1;
    setImmediate(() => child.emit("close", 0, null));
  };
  const [first, second] = await Promise.all([
    stopTerminalProcess(terminal, { killProcessTreeImpl: kill }),
    stopTerminalProcess(terminal, { killProcessTreeImpl: kill }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, { status: "exited" });
  assert.deepEqual(second, { status: "exited" });
});

test("terminal stop escalates and reports unknown completion if close is never observed", async () => {
  const { terminal } = terminalFixture();
  const signals = [];
  const result = await stopTerminalProcess(terminal, {
    stopGraceMs: 5,
    forceGraceMs: 5,
    killProcessTreeImpl: async (_pid, signal) => signals.push(signal),
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(result, { status: "completion_unknown" });
});

test("terminal writes wait for drain after backpressure", async () => {
  const { terminal, stdin } = terminalFixture();
  stdin.write = () => false;
  const pending = writeTerminalInput(terminal, "hello");
  setImmediate(() => stdin.emit("drain"));
  assert.equal(await pending, true);
});

test("terminal writes reject when the child exits during backpressure", async () => {
  const { terminal, child, stdin } = terminalFixture();
  stdin.write = () => false;
  const pending = writeTerminalInput(terminal, "hello");
  setImmediate(() => child.emit("close", 0, null));
  await assert.rejects(pending, (error) => error.code === "TERMINAL_CLOSED");
});

test("terminal writes reject immediately after shutdown", async () => {
  const { terminal, stdin } = terminalFixture();
  terminal.closed = true;
  stdin.write = () => true;
  await assert.rejects(writeTerminalInput(terminal, "hello"), (error) => error.code === "TERMINAL_CLOSED");
});
