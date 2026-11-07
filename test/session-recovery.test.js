import assert from "node:assert/strict";
import test from "node:test";
import { assertSessionCanAcceptInstruction, getSessionRecoveryStatus } from "../src/desktop/session-recovery.js";

test("no pending state does not require recovery", () => {
  assert.deepEqual(getSessionRecoveryStatus({}), {
    required: false,
    blocked: false,
    requiresBareResume: false,
    code: null,
    reason: null,
  });
});

test("pending outbound, assistant handoff, and tool result require reconciliation", () => {
  for (const state of [
    { pendingOutbound: { outboundId: "out-1" } },
    { pendingAssistantTurn: { handoffId: "handoff-1" } },
    { pendingToolResult: { callId: "tool-1" } },
  ]) {
    const result = getSessionRecoveryStatus(state);
    assert.equal(result.required, true);
    assert.equal(result.blocked, false);
    assert.equal(result.requiresBareResume, true);
    assert.equal(result.code, "SESSION_RECOVERY_REQUIRED");
  }
});

test("pending auxiliary turn blocks automatic replay", () => {
  const result = getSessionRecoveryStatus({
    pendingAuxiliaryTurn: { outboundId: "media-1" },
  });
  assert.equal(result.required, true);
  assert.equal(result.blocked, true);
  assert.equal(result.requiresBareResume, false);
  assert.equal(result.code, "AUXILIARY_TURN_RECOVERY_REQUIRED");
  assert.match(result.reason, /will not replay it automatically/);
});


test("recovery-required sessions reject new instructions before accepting work", () => {
  for (const state of [
    { pendingOutbound: { outboundId: "out-1" } },
    { pendingAssistantTurn: { handoffId: "handoff-1" } },
    { pendingToolResult: { callId: "tool-1" } },
  ]) {
    assert.throws(
      () => assertSessionCanAcceptInstruction(state, "start a different task"),
      { code: "RECOVERY_REQUIRES_BARE_RESUME" },
    );
    assert.equal(assertSessionCanAcceptInstruction(state, "  ").requiresBareResume, true);
  }
});

test("blocked auxiliary turns reject all new instructions", () => {
  assert.throws(
    () => assertSessionCanAcceptInstruction({
      pendingAuxiliaryTurn: { outboundId: "media-1" },
    }, "start another task"),
    { code: "AUXILIARY_TURN_RECOVERY_REQUIRED" },
  );
});

test("sessions without pending recovery accept instructions", () => {
  assert.equal(assertSessionCanAcceptInstruction({}, "new task").required, false);
});
