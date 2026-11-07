import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTONOMOUS_PLAN_MAX_BYTES,
  acceptAutonomousVerification,
  approveAutonomousWorkflow,
  assertAutonomousPlanApprovable,
  buildApprovedImplementationInstruction,
  beginAutonomousImplementation,
  buildAutonomousImplementationInstruction,
  buildAutonomousRepairInstruction,
  recordAutonomousVerificationAttempt,
  buildAutonomousPlanningInstruction,
  createAutonomousWorkflow,
  normalizeWorkflowMode,
  rejectAutonomousWorkflow,
  requireAutonomousVerification,
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
  for (let index = 0; index < planned.plan.length; index += 1) {
    const code = planned.plan.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      assert.ok(index + 1 < planned.plan.length);
      const next = planned.plan.charCodeAt(index + 1);
      assert.ok(next >= 0xDC00 && next <= 0xDFFF, "high surrogate must be paired");
      index += 1;
    } else {
      assert.ok(code < 0xDC00 || code > 0xDFFF, "low surrogate must be paired");
    }
  }
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


test("implementation completion requires a separate verification phase", () => {
  const planned = storeAutonomousPlan(createAutonomousWorkflow("Add a settings page"), "Verified plan");
  const implementing = approveAutonomousWorkflow(planned, "2026-11-07T00:01:00.000Z");
  const pending = requireAutonomousVerification(implementing, "2026-11-07T00:02:00.000Z");
  assert.equal(pending.phase, "verification_required");
  assert.equal(pending.verificationStatus, "pending");
  assert.equal(pending.implementationCompletedAt, "2026-11-07T00:02:00.000Z");
  assert.equal(pending.completedAt, null);
  assert.throws(() => requireAutonomousVerification(pending), /tidak berada pada fase/);
  assert.throws(() => requireAutonomousVerification({ ...implementing, phase: "completed" }), /tidak berada pada fase/);
});


test("user acceptance is explicit, bounded, and distinct from machine verification", () => {
  const planned = storeAutonomousPlan(createAutonomousWorkflow("Add a settings page"), "Verified plan");
  const implementing = approveAutonomousWorkflow(planned);
  const pending = requireAutonomousVerification(implementing);
  assert.throws(() => acceptAutonomousVerification(pending, ""), /12 byte hingga 4 KB/);
  const accepted = acceptAutonomousVerification(pending, "npm test: 42 passed; reviewed final diff.");
  assert.equal(accepted.phase, "accepted");
  assert.equal(accepted.verificationStatus, "user_attested");
  assert.equal(accepted.completedAt, null);
  assert.equal(accepted.verificationSummary, "npm test: 42 passed; reviewed final diff.");
  assert.throws(() => acceptAutonomousVerification(accepted, "Already accepted"), /fase verifikasi pengguna/);
});

test("autonomous plan can advance to implementation without claiming user approval", () => {
  const planned = storeAutonomousPlan(createAutonomousWorkflow("Add a settings page"), "Verified plan");
  const started = beginAutonomousImplementation(planned, "2026-11-07T00:01:00.000Z");
  assert.equal(started.phase, "implementing");
  assert.equal(started.approvedAt, null);
  assert.equal(started.implementationStartedAt, "2026-11-07T00:01:00.000Z");
  assert.throws(() => beginAutonomousImplementation(started), /Rencana tidak valid/);
  const instruction = buildAutonomousImplementationInstruction(planned);
  assert.match(instruction, /AUTONOMOUS IMPLEMENTATION/);
  assert.doesNotMatch(instruction, /user explicitly approved/i);
  assert.match(instruction, /Never push, publish, release, deploy/);
});

test("autonomous repair prompt is scoped and hard-limited to two attempts", () => {
  const planned = storeAutonomousPlan(createAutonomousWorkflow("Fix parser"), "Plan");
  const implementing = beginAutonomousImplementation(planned);
  const failed = [{ id: "package:test", status: "failed", exitCode: 1, completionKnown: true, stderr: "assertion failed" }];
  const prompt = buildAutonomousRepairInstruction(implementing, failed, 1);
  assert.match(prompt, /ATTEMPT 1 OF 2/);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /Do not run shell commands/);
  assert.throws(() => buildAutonomousRepairInstruction(implementing, failed, 3), /attempt budget/);
});

test("verification attempts are persisted as bounded machine summaries", () => {
  const planned = storeAutonomousPlan(createAutonomousWorkflow("Fix parser"), "Plan");
  const implementing = beginAutonomousImplementation(planned);
  const recorded = recordAutonomousVerificationAttempt(implementing, {
    status: "failed",
    startedAt: "2026-11-07T00:00:00.000Z",
    finishedAt: "2026-11-07T00:00:01.000Z",
    durationMs: 1000,
    checks: [{ id: "package:test", status: "failed", exitCode: 1, completionKnown: true, stdout: "x".repeat(100) }],
  });
  assert.equal(recorded.verificationAttempts.length, 1);
  assert.equal(recorded.verificationAttempts[0].checks[0].exitCode, 1);
  assert.equal(recorded.machineVerification.checks[0].stdout.length, 100);
});
