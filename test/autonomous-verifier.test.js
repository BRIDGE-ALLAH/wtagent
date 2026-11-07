import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  recordAutonomousMachineVerification,
  resolveAutonomousChecks,
  runAutonomousVerification,
  mergeAutonomousVerificationResults,
} from "../src/desktop/autonomous-verifier.js";
import { createAutonomousWorkflow, storeAutonomousPlan, beginAutonomousImplementation } from "../src/desktop/autonomous-workflow.js";

async function fixture(t, scripts = { test: "node scripts/run-tests.js", check: "node scripts/check-syntax.js" }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-verifier-"));
  await fs.mkdir(path.join(root, "scripts"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts }));
  await fs.writeFile(path.join(root, "scripts", "run-tests.js"), "process.exit(0);");
  await fs.writeFile(path.join(root, "scripts", "check-syntax.js"), "process.exit(0);");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function fakeChild(pid = 1234) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test("resolver discovers only literal workspace-relative Node test and check scripts", async (t) => {
  const root = await fixture(t);
  const resolved = await resolveAutonomousChecks({ workspace: root });
  assert.equal(resolved.status, "ready");
  assert.deepEqual(resolved.checks.map((item) => item.id), ["package:test", "package:check"]);
  assert.ok(resolved.checks.every((item) => item.executable === process.execPath));
  assert.ok(resolved.checks.every((item) => item.cwd === root));
  assert.ok(resolved.checks.every((item) => item.args.length === 1));
});

test("resolver rejects shell commands, chains, traversal, and external scripts", async (t) => {
  const root = await fixture(t, {
    test: "npm test",
    check: "node ../outside.js",
  });
  const resolved = await resolveAutonomousChecks({ workspace: root });
  assert.equal(resolved.status, "unsupported");
  assert.equal(resolved.checks.length, 0);
  assert.equal(resolved.unsupported.length, 2);
  assert.ok(resolved.unsupported.every((item) => item.status === "unsupported"));
});

test("resolver reports missing or malformed manifests as unavailable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-verifier-missing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal((await resolveAutonomousChecks({ workspace: root })).status, "unavailable");
  await fs.writeFile(path.join(root, "package.json"), "{bad json");
  assert.equal((await resolveAutonomousChecks({ workspace: root })).status, "unavailable");
});

test("runner captures bounded output and records confirmed success", async (t) => {
  const root = await fixture(t, { test: "node scripts/run-tests.js" });
  let child;
  const result = await runAutonomousVerification({
    workspace: root,
    spawnImpl: (_program, _args, options) => {
      assert.equal(options.shell, false);
      assert.equal(options.cwd, root);
      assert.equal(options.env.CI, "1");
      assert.equal("WTAGENT_TEST_SECRET" in options.env, false);
      child = fakeChild();
      setImmediate(() => {
        child.stdout.write("tests passed");
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.checks[0].status, "passed");
  assert.equal(result.checks[0].completionKnown, true);
  assert.equal(result.checks[0].stdout, "tests passed");
});

test("runner records failure and never treats a nonzero exit as success", async (t) => {
  const root = await fixture(t, { test: "node scripts/run-tests.js" });
  const result = await runAutonomousVerification({
    workspace: root,
    spawnImpl: () => {
      const child = fakeChild();
      setImmediate(() => child.emit("close", 2, null));
      return child;
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.checks[0].exitCode, 2);
});

test("runner escalates timed-out processes and records unknown completion", async (t) => {
  const root = await fixture(t, { test: "node scripts/run-tests.js" });
  const calls = [];
  const result = await runAutonomousVerification({
    workspace: root,
    stopGraceMs: 5,
    forceGraceMs: 5,
    timeoutOverrides: { "package:test": 5 },
    killProcessTreeImpl: async (pid, signal) => calls.push({ pid, signal }),
    spawnImpl: () => fakeChild(),
  });
  assert.equal(result.status, "timed_out");
  assert.equal(result.checks[0].completionKnown, false);
  assert.deepEqual(calls.map((call) => call.signal), ["SIGTERM", "SIGKILL"]);
});

test("machine completion requires every required check to pass with confirmed exit", () => {
  const planned = storeAutonomousPlan(createAutonomousWorkflow("Add feature"), "Plan");
  const implementing = beginAutonomousImplementation(planned);
  const completed = recordAutonomousMachineVerification(implementing, {
    status: "passed",
    startedAt: "2026-11-07T00:00:00.000Z",
    finishedAt: "2026-11-07T00:01:00.000Z",
    checks: [{ id: "package:test", status: "passed", exitCode: 0, completionKnown: true }],
  });
  assert.equal(completed.phase, "completed");
  assert.equal(completed.verificationStatus, "machine_verified");
  assert.ok(completed.completedAt);

  const blocked = recordAutonomousMachineVerification(implementing, {
    status: "timed_out",
    checks: [{ id: "package:test", status: "timed_out", exitCode: null, completionKnown: false }],
  });
  assert.equal(blocked.phase, "verification_required");
  assert.equal(blocked.completedAt, null);
});

test("targeted repair verification merges only rerun results and preserves prior passing checks", () => {
  const merged = mergeAutonomousVerificationResults(
    {
      status: "failed",
      checks: [
        { id: "package:test", status: "failed", exitCode: 1, completionKnown: true },
        { id: "package:check", status: "passed", exitCode: 0, completionKnown: true },
      ],
    },
    {
      status: "passed",
      checks: [{ id: "package:test", status: "passed", exitCode: 0, completionKnown: true }],
      unsupported: [],
    },
  );
  assert.equal(merged.status, "passed");
  assert.deepEqual(merged.checks.map((check) => check.status), ["passed", "passed"]);
});

test("targeted verifier runs only the requested failed check", async (t) => {
  const root = await fixture(t);
  const launched = [];
  const result = await runAutonomousVerification({
    workspace: root,
    checkIds: ["package:test"],
    spawnImpl: (_program, args) => {
      launched.push(args[0]);
      const child = fakeChild();
      setImmediate(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].id, "package:test");
  assert.equal(launched.length, 1);
});
