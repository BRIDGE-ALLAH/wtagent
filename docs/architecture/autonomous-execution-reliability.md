# Autonomous execution reliability

## Scope

WTAgent's autonomous workflow is a staged engineering process, not a model-response status indicator. This document records the current reliability contract and the next implementation boundaries.

## Current state contract

`planning -> awaiting_approval -> implementing -> verification_required`

- `planning`: read-only tools only.
- `awaiting_approval`: a bounded plan is persisted with a SHA-256 checksum.
- `implementing`: explicit approval and a pre-implementation workspace checkpoint are persisted before the implementation turn.
- `verification_required`: the implementation model turn ended. This is **not** a success state and does not imply that acceptance criteria, tests, builds, or regression checks passed.
- `accepted`: the user explicitly recorded a verification/review note. This is a human attestation, not an automated pass verdict.
- `completed`: reserved for a future machine-verified state; the current desktop autonomous path must not set it merely because the provider emitted `run.completed`.

## Persistence and recovery

Session state is persisted through `AgentSession`, which already provides atomic snapshots, a monotonically increasing state revision, a per-session persistence queue, and an inter-process lock. Do not introduce a second state store for workflow phase. Workflow transitions are also written to the append-only session event log.

A bare resume of `verification_required` returns the persisted state instead of sending another provider message. This avoids treating an already-ended implementation turn as an unfinished task and avoids accidental duplicate execution.

## Completion integrity

The runtime's `run.completed` event means the model turn ended. It does not mean the task passed its acceptance criteria. WTAgent therefore records `autonomous.verification_required` and emits `desktop.autonomous_verification_required`. The renderer tells the user to inspect the diff and run relevant checks.

The current gate is deliberately conservative and human-visible. After checking the diff and running relevant checks, the user can record a bounded verification note to accept the result. This changes the phase to `accepted` with `verificationStatus: user_attested`; it does not claim that WTAgent independently verified the note. The UI and event log preserve that distinction. The next verification-engine milestone should:

1. Persist explicit acceptance criteria in a structured form.
2. Observe tool execution results from the runtime, not model prose.
3. Bind verification evidence to the task, command identity, workspace revision, exit code, timeout state, and timestamp.
4. Reject missing, failed, timed-out, or unknown results.
5. Re-run checks when the workspace changes after evidence collection.
6. Permit `completed` only when all required criteria have acceptable evidence and final diff review is recorded.

## Invariants

- A provider/model turn ending cannot promote a task to `completed`.
- An interrupted implementation remains recoverable and is not reported as successful.
- Verification-required sessions remain visible after restart.
- Workspace checkpoint finalization and rollback availability are separate from task correctness.
- A checkpoint being available is not proof that the implementation is correct.
- The model's natural-language claim that tests passed is not machine-observed evidence.

## Non-goals of this slice

This change does not add automatic test command discovery, sandbox isolation, multi-agent execution, or an automated pass/fail verdict. Those require separate design and security review. It establishes the completion-integrity boundary first.
