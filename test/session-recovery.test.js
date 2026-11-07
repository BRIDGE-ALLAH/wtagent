import assert from "node:assert/strict";
import test from "node:test";
import { getSessionRecoveryStatus } from "../src/desktop/session-recovery.js";

test("no pending state does not require recovery", () => {
  assert.deepEqual(getSessionRecoveryStatus({}), {
    required: false,
    blocked: false,
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
    assert.equal(result.code, "SESSION_RECOVERY_REQUIRED");
  }
});

test("pending auxiliary turn blocks automatic replay", () => {
  const result = getSessionRecoveryStatus({
    pendingAuxiliaryTurn: { outboundId: "media-1" },
  });
  assert.equal(result.required, true);
  assert.equal(result.blocked, true);
  assert.equal(result.code, "AUXILIARY_TURN_RECOVERY_REQUIRED");
  assert.match(result.reason, /will not replay it automatically/);
});
