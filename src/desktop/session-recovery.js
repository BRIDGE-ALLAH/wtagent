export function getSessionRecoveryStatus(state = {}) {
  if (state.pendingAuxiliaryTurn) {
    return {
      required: true,
      blocked: true,
      requiresBareResume: false,
      code: "AUXILIARY_TURN_RECOVERY_REQUIRED",
      reason: "An external media/provider submission was interrupted. WTAgent will not replay it automatically because that could create a duplicate remote artifact.",
    };
  }

  const required = Boolean(
    state.pendingOutbound
    || state.pendingAssistantTurn
    || state.pendingToolResult,
  );
  return {
    required,
    blocked: false,
    requiresBareResume: required,
    code: required ? "SESSION_RECOVERY_REQUIRED" : null,
    reason: required
      ? "A persisted browser handoff or tool result must be reconciled before new instructions are accepted."
      : null,
  };
}


export function assertSessionCanAcceptInstruction(state = {}, instruction = "") {
  const status = getSessionRecoveryStatus(state);
  if (status.blocked) {
    const error = new Error(status.reason);
    error.code = status.code;
    throw error;
  }
  if (status.requiresBareResume && String(instruction ?? "").trim()) {
    const error = new Error(
      "A pending provider handoff or tool result must be reconciled with a bare resume before accepting new instructions.",
    );
    error.code = "RECOVERY_REQUIRES_BARE_RESUME";
    throw error;
  }
  return status;
}
