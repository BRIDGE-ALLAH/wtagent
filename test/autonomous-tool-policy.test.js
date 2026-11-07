import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateAutonomousToolPolicy } from "../src/desktop/autonomous-tool-policy.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-autonomous-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function definition(name, risk) {
  return { name, risk };
}

test("autonomous policy allows read-only workspace tools and workspace file writes", async (t) => {
  const root = await fixture(t);
  for (const [name, risk] of [
    ["fs.read", "read"],
    ["fs.list", "read"],
    ["fs.search", "read"],
    ["fs.write", "write"],
    ["fs.edit", "write"],
  ]) {
    const result = await evaluateAutonomousToolPolicy({
      toolCall: { name, args: { path: "src/file.js" } },
      definition: definition(name, risk),
      projectRoot: root,
    });
    assert.equal(result.action, "allow", name);
    assert.equal(result.grants.allowOutside, false);
  }
});

test("autonomous policy denies external paths and all unmanaged execution tools", async (t) => {
  const root = await fixture(t);
  const outside = path.resolve(root, "..", "outside.txt");
  const external = await evaluateAutonomousToolPolicy({
    toolCall: { name: "fs.write", args: { path: outside } },
    definition: definition("fs.write", "write"),
    projectRoot: root,
  });
  assert.equal(external.action, "deny");
  assert.equal(external.code, "AUTONOMOUS_PATH_OUTSIDE_WORKSPACE");

  for (const name of ["terminal.exec", "process.start", "process.stop", "image.generate", "unknown.tool"]) {
    const result = await evaluateAutonomousToolPolicy({
      toolCall: { name, args: {} },
      definition: definition(name, name === "unknown.tool" ? "read" : "execute"),
      projectRoot: root,
    });
    assert.equal(result.action, "deny", name);
    assert.equal(result.grants.allowOutside, false);
  }
});

test("autonomous policy fails closed on missing definitions and risk mismatches", async (t) => {
  const root = await fixture(t);
  const missing = await evaluateAutonomousToolPolicy({
    toolCall: { name: "fs.read", args: { path: "." } },
    definition: null,
    projectRoot: root,
  });
  assert.equal(missing.code, "AUTONOMOUS_UNKNOWN_TOOL");

  const mismatch = await evaluateAutonomousToolPolicy({
    toolCall: { name: "fs.write", args: { path: "." } },
    definition: definition("fs.write", "execute"),
    projectRoot: root,
  });
  assert.equal(mismatch.code, "AUTONOMOUS_TOOL_RISK_MISMATCH");
});
