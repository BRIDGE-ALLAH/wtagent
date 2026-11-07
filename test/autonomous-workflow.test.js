import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTONOMOUS_PLAN_MAX_BYTES,
  approveAutonomousWorkflow,
  assertAutonomousPlanApprovable,
  buildApprovedImplementationInstruction,
  buildAutonomousPlanningInstruction,
  createAutonomousWorkflow,
  normalizeWorkflowMode,
  rejectAutonomousWorkflow,
  shouldEnforceReadOnlyPolicy,
  storeAutonomousPlan,
} from "../src/desktop/autonomous-workflow.js";

test("normalizes supported desktop workflow modes", () => {
  for (const mode of ["agent", "plan", "verify", "autonomous"]) assert.equal(normalizeWorkflowMode(mode), mode);
  assert.equal(normalizeWorkflowMode("unexpected"), "agent");
  assert.equal(normalizeWorkflowMode(null), "agent");
});

test("autonomous planning remains read-only until explicit approval", () => {
  const workflow = createAutonomousWorkflow("Add a settings page");
  assert.equal(shouldEnforceReadOnlyPolicy({ workflowMode: "autonomous", autonomousWorkflow: workflow }), true);
  assert.equal(shouldEnforceReadOnlyPolicy({ workflowMode: "autonomous", autonomousWorkflow: { ...workflow, phase: "awaiting_approval" } }), false);
  assert.equal(shouldEnforceReadOnlyPolicy({ workflowMode: "autonomous", autonomousWorkflow: { ...workflow, phase: "implementing" } }), false);
  assert.equal(shouldEnforceReadOnlyPolicy({ workflowMode: "plan", autonomousWorkflow: null }), true);
  assert.equal(shouldEnforceReadOnlyPolicy({ workflowMode: "agent", autonomousWorkflow: null }), false);
});

test("stores a bounded checksummed plan and allows one explicit approval", () => {
  const planned = storeAutonomousPlan(createAutonomousWorkflow("Add a settings page"), "## Objective\nAdd settings.", "2026-11-07T00:00:00.000Z");
  assert.equal(planned.phase, "awaiting_approval");
  assert.equal(planned.plan, "## Objective\nAdd settings.");
  assert.match(planned.planSha256, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => assertAutonomousPlanApprovable(planned));
  const approved = approveAutonomousWorkflow(planned, "2026-11-07T00:01:00.000Z");
  assert.equal(approved.phase, "implementing");
  assert.equal(approved.approvedAt, "2026-11-07T00:01:00.000Z");
  assert.throws(() => approveAutonomousWorkflow(approved), /Rencana tidak valid/);
});

test("rejects empty plans, invalid phases, and modified plan content", () => {
  const initial = createAutonomousWorkflow("Refactor settings");
  assert.throws(() => storeAutonomousPlan(initial, "  "), /tidak menghasilkan rencana/);
  assert.throws(() => storeAutonomousPlan({ ...initial, phase: "completed" }, "A plan"), /fase perencanaan/);
  const planned = storeAutonomousPlan(initial, "Verified plan");
  assert.throws(() => assertAutonomousPlanApprovable({ ...planned, plan: "Modified plan" }), /checksum/);
  assert.throws(() => rejectAutonomousWorkflow({ ...planned, planSha256: "bad" }), /checksum/);
});

test("truncates by UTF-8 byte size without splitting Unicode characters", () => {
  const planned = storeAutonomousPlan(createAutonomousWorkflow("Large project"), "🧪".repeat(AUTONOMOUS_PLAN_MAX_BYTES));
  assert.ok(Buffer.byteLength(planned.plan, "utf8") <= AUTONOMOUS_PLAN_MAX_BYTES);
  assert.match(planned.plan, /Plan dipotong/);
  assert.doesNotMatch(planned.plan, /�/);
});

test("approved implementation prompt carries the user task and approved plan as data", () => {
  const planned = storeAutonomousPlan(createAutonomousWorkflow("Add a settings page"), "## Files\n- src/settings.js");
  const prompt = buildApprovedImplementationInstruction(planned);
  assert.match(prompt, /USER APPROVED IMPLEMENTATION/);
  assert.match(prompt, /Add a settings page/);
  assert.match(prompt, /src\/settings\.js/);
  assert.match(prompt, /Never push, publish, release, deploy/);
  assert.match(prompt, /SHA-256/);
});

test("planning prompt prohibits mutations and command execution", () => {
  const prompt = buildAutonomousPlanningInstruction("Add a settings page");
  assert.match(prompt, /STRICT PLAN PHASE/);
  assert.match(prompt, /Do not create, edit, overwrite, rename, or delete files/);
  assert.match(prompt, /USER REQUEST:/);
});
