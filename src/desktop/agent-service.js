import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { AgentSession } from "../session/agent-session.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { ApprovalStore } from "../policy/approval-store.js";
import { createDefaultToolRegistry } from "../tools/default-tools.js";
import { ProcessManager } from "../tools/process-manager.js";
import { NativeImageReceiver } from "../image/native-image-receiver.js";
import { NativeMusicReceiver, validateGenerationType } from "../audio/native-music-receiver.js";
import {
  createWebAdapter,
  resolveProvider,
  getProviderProfileDir,
} from "../browser/provider-registry.js";
import {
  getAppDataDir,
  getSessionsDir,
  ensureDirectory,
} from "../platform/paths.js";
import { resolveLimits } from "../shared/limits.js";
import { extractAtMentions } from "../cli/at-files.js";
import { assertNativeRuntimeSupported } from "../platform/windows-diagnostics.js";
import {
  acceptAutonomousVerification,
  approveAutonomousWorkflow,
  beginAutonomousImplementation,
  buildAutonomousImplementationInstruction,
  buildApprovedImplementationInstruction,
  buildAutonomousPlanningInstruction,
  createAutonomousWorkflow,
  normalizeWorkflowMode,
  rejectAutonomousWorkflow,
  requireAutonomousVerification,
  shouldEnforceReadOnlyPolicy,
  storeAutonomousPlan,
} from "./autonomous-workflow.js";
import { WorkspaceCheckpoint } from "./workspace-checkpoint.js";
import { evaluateAutonomousToolPolicy } from "./autonomous-tool-policy.js";
import { resolveAutonomousChecks, runAutonomousVerification, recordAutonomousMachineVerification } from "./autonomous-verifier.js";
import { getSessionRecoveryStatus } from "./session-recovery.js";

function emitSafely(callback, event) {
  try {
    callback?.(event);
  } catch {
    // A closed renderer must not interrupt an agent turn or its checkpoint.
  }
}

export class DesktopAgentService {
  constructor({ onEvent = null } = {}) {
    this.onEvent = onEvent;
    this.session = null;
    this.provider = null;
    this.adapter = null;
    this.processManager = null;
    this.approvalStore = null;
    this.nativeImageReceiver = null;
    this.nativeMusicReceiver = null;
    this.limits = resolveLimits();
    this.pendingApprovals = new Map();
    this.providerSelectionResolver = null;
    this.providerSelectionDone = false;
    this.workflowMode = "agent";
    this.autonomousWorkflow = null;
    this.autonomousVerificationPlan = null;
    this.autonomousDecisionInProgress = false;
    this.workspaceCheckpoint = null;
    this.pendingAutonomousImplementation = null;
    this.running = false;
    this.closed = false;
  }

  #emit(type, payload = {}) {
    emitSafely(this.onEvent, {
      type,
      sessionId: this.session?.sessionId ?? null,
      timestamp: new Date().toISOString(),
      payload,
    });
  }

  async #forwardRuntimeEvent(event) {
    if (!event || typeof event.type !== "string" || event.type === "model.streaming") return;
    const payload = { ...(event.payload ?? {}) };
    delete payload.raw;
    if (typeof payload.output === "string") payload.output = payload.output.slice(0, 12_000);
    if (typeof payload.stdout === "string") payload.stdout = payload.stdout.slice(-8_000);
    if (typeof payload.stderr === "string") payload.stderr = payload.stderr.slice(-8_000);

    if (event.type === "run.completed" && this.workflowMode === "autonomous") {
      if (this.autonomousWorkflow?.phase === "planning") {
        try {
          const planned = storeAutonomousPlan(this.autonomousWorkflow, payload.message);
          const verificationPlan = await resolveAutonomousChecks({
            workspace: this.session.state.projectRoot,
          });
          const appDataDir = path.resolve(getAppDataDir());
          const checkpoint = await WorkspaceCheckpoint.create({
            workspace: this.session.state.projectRoot,
            directory: path.join(appDataDir, "autonomous-checkpoints"),
            sessionId: this.session.sessionId,
          });
          const implementing = beginAutonomousImplementation(planned);
          const instruction = buildAutonomousImplementationInstruction(planned);
          await this.session.appendInstruction(instruction, {
            statePatch: {
              desktopWorkflowMode: "autonomous",
              autonomousWorkflow: implementing,
              autonomousVerificationPlan: verificationPlan,
              workspaceCheckpoint: {
                id: checkpoint.id,
                directory: checkpoint.directory,
                status: "captured",
                createdAt: checkpoint.metadata.createdAt,
              },
            },
          });
          this.workspaceCheckpoint = checkpoint;
          this.autonomousWorkflow = implementing;
          this.autonomousVerificationPlan = verificationPlan;
          this.pendingAutonomousImplementation = { instruction, planSha256: implementing.planSha256 };
          await this.session.appendEvent("autonomous.implementation_started", {
            implementationStartedAt: implementing.implementationStartedAt,
            planSha256: implementing.planSha256,
            checkpointId: checkpoint.id,
          });
          this.#emit("desktop.autonomous_implementation_started", {
            planSha256: implementing.planSha256,
            checkpointId: checkpoint.id,
            message: "Rencana tervalidasi dan checkpoint tersimpan. Implementasi berjalan otomatis.",
          });
        } catch (error) {
          this.pendingAutonomousImplementation = null;
          this.workspaceCheckpoint = null;
          this.autonomousVerificationPlan = null;
          this.autonomousWorkflow = { ...this.autonomousWorkflow, phase: "plan_failed", lastError: error.message };
          await this.session.update({ autonomousWorkflow: this.autonomousWorkflow, autonomousVerificationPlan: null });
          await this.session.appendEvent("autonomous.plan_failed", { message: this.autonomousWorkflow.lastError });
          this.#emit("desktop.plan_failed", { message: error.message || "Agent belum menghasilkan rencana yang dapat ditinjau." });
        }
      } else if (this.autonomousWorkflow?.phase === "implementing") {
        let verification;
        try {
          verification = await runAutonomousVerification({
            workspace: this.session.state.projectRoot,
            verificationPlan: this.autonomousVerificationPlan ?? this.session.state.autonomousVerificationPlan ?? null,
            requireTrustedPlan: true,
          });
        } catch (error) {
          verification = {
            status: "unavailable",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            checks: [],
            unsupported: [],
            reason: error.message || "Machine verification could not start.",
          };
        }
        this.autonomousWorkflow = recordAutonomousMachineVerification(this.autonomousWorkflow, verification);
        await this.session.update({ autonomousWorkflow: this.autonomousWorkflow });
        await this.session.appendEvent(
          this.autonomousWorkflow.phase === "completed"
            ? "autonomous.machine_verified"
            : "autonomous.verification_required",
          {
            planSha256: this.autonomousWorkflow.planSha256,
            verificationStatus: this.autonomousWorkflow.verificationStatus,
            machineVerification: this.autonomousWorkflow.machineVerification,
            completedAt: this.autonomousWorkflow.completedAt,
          },
        );
        if (this.autonomousWorkflow.phase === "completed") {
          this.#emit("desktop.autonomous_completed", {
            planSha256: this.autonomousWorkflow.planSha256,
            verificationStatus: "machine_verified",
            checks: this.autonomousWorkflow.machineVerification.checks,
            message: "Implementasi dan seluruh pemeriksaan otomatis yang didukung berhasil.",
          });
        } else if (this.autonomousWorkflow.phase === "verification_required") {
          this.#emit("desktop.autonomous_verification_required", {
            verificationRequiredAt: this.autonomousWorkflow.verificationRequiredAt,
            planSha256: this.autonomousWorkflow.planSha256,
            verificationStatus: this.autonomousWorkflow.verificationStatus,
            checks: this.autonomousWorkflow.machineVerification.checks,
            message: "Implementasi selesai, tetapi verifikasi mesin belum lulus. Task tetap belum selesai.",
          });
        }
      }
    }

    emitSafely(this.onEvent, {
      type: event.type,
      sessionId: event.sessionId ?? this.session?.sessionId ?? null,
      timestamp: event.timestamp ?? new Date().toISOString(),
      payload,
    });
  }

  async start({ projectRoot, model = "chatgpt", instruction, generationType = "agent", workflowMode = "agent" }) {
    if (this.session) throw new Error("An agent session is already active.");
    assertNativeRuntimeSupported();

    const root = path.resolve(String(projectRoot ?? ""));
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error("Pilih folder proyek yang valid.");
    const provider = resolveProvider(model);
    const resolvedType = validateGenerationType(generationType, provider.id);
    const userInstruction = String(instruction ?? "").trim();
    this.workflowMode = normalizeWorkflowMode(workflowMode);
    if (this.workflowMode === "autonomous" && resolvedType !== "agent") {
      throw new Error("Autonomous coding workflow hanya tersedia untuk tugas agent, bukan generasi media.");
    }
    this.autonomousWorkflow = this.workflowMode === "autonomous"
      ? createAutonomousWorkflow(userInstruction)
      : null;
    this.autonomousVerificationPlan = null;
    const appDataDir = path.resolve(getAppDataDir());
    const sessionsDir = getSessionsDir(appDataDir);
    await ensureDirectory(sessionsDir);

    this.provider = provider;
    this.session = await AgentSession.create({
      sessionsDir,
      task: userInstruction,
      projectRoot: root,
      provider: provider.id,
      mode: null,
      generationType: resolvedType,
    });
    await this.session.update({
      desktopWorkflowMode: this.workflowMode,
      autonomousWorkflow: this.autonomousWorkflow,
      autonomousVerificationPlan: null,
    });
    this.#initializeRuntimeParts(appDataDir, resolvedType);
    this.#emit("desktop.session_started", {
      sessionId: this.session.sessionId,
      projectRoot: root,
      provider: provider.id,
      workflowMode: this.workflowMode,
      autonomousWorkflow: this.autonomousWorkflow,
    });

    const attachmentResult = await extractAtMentions(userInstruction, root);
    if (attachmentResult.missing.length) {
      this.#emit("desktop.notice", {
        message: "Beberapa lampiran @path tidak ditemukan.",
        details: attachmentResult.missing,
      });
    }
    return await this.#runTurn({
      resume: false,
      instruction: this.workflowMode === "autonomous"
        ? buildAutonomousPlanningInstruction(userInstruction)
        : userInstruction,
      displayInstruction: userInstruction,
      files: attachmentResult.files,
    });
  }

  async listSessions(limit = 40) {
    const appDataDir = path.resolve(getAppDataDir());
    const sessionsDir = getSessionsDir(appDataDir);
    await ensureDirectory(sessionsDir);
    const states = await AgentSession.list({ sessionsDir, limit });
    return states.map((state) => ({
      sessionId: state.sessionId,
      task: state.task || "Sesi tanpa judul",
      projectRoot: state.projectRoot,
      provider: state.provider || "chatgpt",
      generationType: state.generationType || "agent",
      phase: state.phase || "idle",
      createdAt: state.createdAt || null,
      updatedAt: state.updatedAt || state.createdAt || null,
      lastError: state.lastError || null,
      recoveryRequired: getSessionRecoveryStatus(state).required,
      recoveryBlocked: getSessionRecoveryStatus(state).blocked,
      workflowMode: state.desktopWorkflowMode || "agent",
      autonomousPhase: state.autonomousWorkflow?.phase ?? null,
    }));
  }

  async resume({ sessionId, instruction = "", workflowMode = null }) {
    if (this.session) throw new Error("Tutup sesi aktif sebelum membuka sesi lain.");
    assertNativeRuntimeSupported();
    const appDataDir = path.resolve(getAppDataDir());
    const sessionsDir = getSessionsDir(appDataDir);
    await ensureDirectory(sessionsDir);
    const session = await AgentSession.load({ sessionsDir, sessionId: String(sessionId ?? "") });
    const recoveryStatus = getSessionRecoveryStatus(session.state);
    if (recoveryStatus.blocked) {
      this.#emit("desktop.recovery_blocked", {
        sessionId: session.sessionId,
        code: recoveryStatus.code,
        message: recoveryStatus.reason,
      });
      return {
        sessionId: session.sessionId,
        recoveryRequired: true,
        recoveryBlocked: true,
        recoveryCode: recoveryStatus.code,
        reason: recoveryStatus.reason,
      };
    }
    const projectRoot = path.resolve(String(session.state.projectRoot ?? ""));
    const projectStat = await fs.stat(projectRoot);
    if (!projectStat.isDirectory()) throw new Error("Folder proyek sesi ini tidak lagi tersedia.");
    const provider = resolveProvider(session.state.provider);
    const generationType = validateGenerationType(session.state.generationType || "agent", provider.id);
    this.provider = provider;
    this.session = session;
    this.workflowMode = normalizeWorkflowMode(workflowMode ?? session.state.desktopWorkflowMode);
    this.autonomousWorkflow = session.state.autonomousWorkflow ?? null;
    this.autonomousVerificationPlan = session.state.autonomousVerificationPlan ?? null;
    const text = String(instruction ?? "").trim();
    const pendingRecovery = recoveryStatus.required;
    if (this.autonomousWorkflow?.phase === "awaiting_approval" && text) {
      throw new Error("Tinjau, setujui, atau tolak rencana autonomous sebelum mengirim instruksi baru.");
    }
    if (this.autonomousWorkflow?.phase === "verification_required" && text) {
      throw new Error("Periksa dan terima hasil autonomous yang tertunda sebelum memulai instruksi baru.");
    }
    if (this.workflowMode === "autonomous" && text) {
      if (generationType !== "agent") throw new Error("Autonomous coding workflow hanya tersedia untuk tugas agent.");
      this.autonomousWorkflow = createAutonomousWorkflow(text);
      this.autonomousVerificationPlan = null;
    }
    await session.update({
      desktopWorkflowMode: this.workflowMode,
      autonomousWorkflow: this.autonomousWorkflow,
      autonomousVerificationPlan: this.autonomousVerificationPlan,
    });
    if (["initializing", "running", "waiting_model", "auth_required"].includes(session.state.phase)) {
      await session.update({ phase: "interrupted" });
    }
    this.#initializeRuntimeParts(appDataDir, generationType);
    this.#emit("desktop.session_started", {
      sessionId: session.sessionId,
      projectRoot,
      provider: provider.id,
      resumed: true,
      workflowMode: this.workflowMode,
      autonomousWorkflow: this.autonomousWorkflow,
      recoveryRequired: pendingRecovery,
    });
    if (session.state.workspaceCheckpoint?.status === "completed") {
      this.#emit("desktop.workspace_checkpointed", {
        checkpointId: session.state.workspaceCheckpoint.id,
        changedFiles: session.state.workspaceCheckpoint.changedFiles ?? 0,
      });
    }

    if (this.autonomousWorkflow?.phase === "awaiting_approval" && !text) {
      return { sessionId: session.sessionId, awaitingApproval: true, autonomousWorkflow: this.autonomousWorkflow };
    }
    if (["rejected", "completed", "accepted", "verification_required", "plan_failed"].includes(this.autonomousWorkflow?.phase) && !text && !pendingRecovery) {
      return { sessionId: session.sessionId, autonomousWorkflow: this.autonomousWorkflow };
    }

    const attachmentResult = text
      ? await extractAtMentions(text, projectRoot)
      : { files: [], missing: [] };
    if (attachmentResult.missing.length) {
      this.#emit("desktop.notice", {
        message: "Beberapa lampiran @path tidak ditemukan.",
        details: attachmentResult.missing,
      });
    }
    if (text) await session.appendInstruction(text, { files: attachmentResult.files });
    return await this.#runTurn({
      resume: true,
      instruction: this.workflowMode === "autonomous" && text
        ? buildAutonomousPlanningInstruction(text)
        : text,
      displayInstruction: text,
      files: attachmentResult.files,
    });
  }

  #initializeRuntimeParts(appDataDir, generationType) {
    this.processManager = new ProcessManager();
    this.approvalStore = new ApprovalStore({
      filePath: path.join(this.session.directory, "approvals.json"),
    });
    this.adapter = createWebAdapter({
      provider: this.provider,
      profileDir: path.resolve(getProviderProfileDir(appDataDir, this.provider.id)),
      minimized: false,
      cancelOnEsc: false,
    });
    this.nativeMusicReceiver = generationType === "music"
      ? new NativeMusicReceiver({ adapter: this.adapter })
      : null;
    this.nativeImageReceiver = this.nativeMusicReceiver
      ? null
      : NativeImageReceiver.forAdapter(this.provider.id, this.adapter);
  }

  #waitForProviderSelection() {
    return new Promise((resolve) => {
      this.providerSelectionResolver = resolve;
      this.#emit("desktop.provider_selection_required", {
        provider: this.provider.label,
        message: "Pilih model di jendela browser, lalu tekan Lanjutkan di sini.",
      });
    });
  }

  continueProviderSelection() {
    const resolve = this.providerSelectionResolver;
    this.providerSelectionResolver = null;
    resolve?.();
  }

  async #requestApproval({ toolCall, reasons }) {
    const requestId = randomUUID();
    return await new Promise((resolve) => {
      this.pendingApprovals.set(requestId, { resolve, toolName: toolCall.name });
      this.#emit("desktop.approval_required", {
        requestId,
        toolCall,
        reasons,
      });
    });
  }

  async respondApproval(requestId, choice) {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    this.pendingApprovals.delete(requestId);
    await this.approvalStore.ensureLoaded();
    if (choice === "always-tool") {
      this.approvalStore.setAlwaysAllowedTool(pending.toolName);
      await this.approvalStore.save();
      pending.resolve(true);
    } else if (choice === "always-all") {
      this.approvalStore.setAlwaysAllowAll();
      await this.approvalStore.save();
      pending.resolve(true);
    } else if (choice === "deny") {
      pending.resolve(false);
    } else {
      pending.resolve(true);
    }
    return true;
  }

  async #buildRuntime() {
    await this.approvalStore.ensureLoaded();
    const registry = createDefaultToolRegistry({
      processManager: this.processManager,
      limits: this.limits,
    });
    const basePolicy = new PolicyEngine({ store: this.approvalStore });
    const policy = {
      evaluate: async (toolCall, context) => {
        const definition = registry.list().find((tool) => tool.name === toolCall.name);
        if (this.workflowMode === "autonomous" && this.autonomousWorkflow?.phase === "implementing") {
          return await evaluateAutonomousToolPolicy({
            toolCall,
            definition,
            projectRoot: this.session.state.projectRoot,
          });
        }
        if (shouldEnforceReadOnlyPolicy({
          workflowMode: this.workflowMode,
          autonomousWorkflow: this.autonomousWorkflow,
        })) {
          if (!definition || definition.risk !== "read") {
            return {
              action: "deny",
              code: "PLAN_MODE_READ_ONLY",
              reasons: [this.workflowMode === "autonomous"
                ? "Autonomous planning phase: non-read-only tool " + toolCall.name + " is denied."
                : "Plan-only mode: tool " + toolCall.name + " is disabled because it may change files or execute commands."],
              grants: { allowOutside: false },
            };
          }
        }
        return await basePolicy.evaluate(toolCall, context);
      },
    };
    return new AgentRuntime({
      adapter: this.adapter,
      nativeImageReceiver: this.nativeImageReceiver,
      nativeMusicReceiver: this.nativeMusicReceiver,
      registry,
      policy,
      session: this.session,
      limits: this.limits,
      postAuthSetup: async ({ adapter }) => {
        if (this.providerSelectionDone) return;
        await adapter.restoreWindow?.();
        await this.#waitForProviderSelection();
        this.providerSelectionDone = true;
      },
      approval: (request) => this.#requestApproval(request),
      onEvent: (event) => this.#forwardRuntimeEvent(event),
    });
  }

  async #runTurn({ resume, instruction, files = [], displayInstruction = instruction }) {
    if (this.running) throw new Error("Agent sedang memproses tugas sebelumnya.");
    this.running = true;
    this.#emit("desktop.turn_started", { instruction: displayInstruction, workflowMode: this.workflowMode });
    try {
      const runtime = await this.#buildRuntime();
      let result = await runtime.run({
        resume,
        instruction,
        files,
        inPlaceRecovery: false,
        mode: null,
      });
      while (this.pendingAutonomousImplementation) {
        const pending = this.pendingAutonomousImplementation;
        this.pendingAutonomousImplementation = null;
        const implementationRuntime = await this.#buildRuntime();
        result = await implementationRuntime.run({
          resume: true,
          instruction: pending.instruction,
          files: [],
          inPlaceRecovery: false,
          mode: null,
        });
      }
      if (this.workflowMode === "autonomous" && this.workspaceCheckpoint) {
        const checkpoint = this.workspaceCheckpoint;
        try {
          const finalized = await WorkspaceCheckpoint.finalize({ directory: checkpoint.directory });
          await this.session.update({ workspaceCheckpoint: { id: finalized.id, directory: checkpoint.directory, status: "completed", createdAt: finalized.createdAt, completedAt: finalized.completedAt, changedFiles: finalized.changed.length } });
          await this.session.appendEvent("autonomous.workspace_checkpointed", { checkpointId: finalized.id, changedFiles: finalized.changed.length });
          this.#emit("desktop.workspace_checkpointed", { checkpointId: finalized.id, changedFiles: finalized.changed.length });
        } catch (error) {
          await this.session.update({ workspaceCheckpoint: { id: checkpoint.id, directory: checkpoint.directory, status: "unavailable", error: error.message } });
          await this.session.appendEvent("autonomous.workspace_checkpoint_failed", { checkpointId: checkpoint.id, message: error.message });
          this.#emit("desktop.workspace_checkpoint_failed", { message: error.message });
        } finally {
          this.workspaceCheckpoint = null;
        }
      }
      this.#emit("desktop.turn_finished", {
        sessionId: this.session.sessionId,
        phase: this.session.state.phase,
      });
      return result;
    } catch (error) {
      if (this.session?.state?.phase !== "idle") {
        await this.session.update({ phase: "interrupted", lastError: error.message }).catch(() => {});
      }
      this.#emit("desktop.agent_error", { message: error.message, code: error.code ?? null });
      throw error;
    } finally {
      this.running = false;
    }
  }

  async send(instruction, workflowMode = "agent") {
    if (!this.session) throw new Error("Mulai agent terlebih dahulu.");
    if (this.running || this.autonomousDecisionInProgress) throw new Error("Agent sedang memproses tugas sebelumnya.");
    const text = String(instruction ?? "").trim();
    if (!text) throw new Error("Instruksi tidak boleh kosong.");
    if (this.session.state.autonomousWorkflow?.phase === "awaiting_approval") {
      throw new Error("Tinjau, setujui, atau tolak rencana autonomous sebelum mengirim instruksi baru.");
    }
    if (this.session.state.autonomousWorkflow?.phase === "verification_required") {
      throw new Error("Periksa dan terima hasil autonomous yang tertunda sebelum memulai instruksi baru.");
    }
    this.workflowMode = normalizeWorkflowMode(workflowMode);
    if (this.workflowMode === "autonomous" && this.session.state.generationType !== "agent") {
      throw new Error("Autonomous coding workflow hanya tersedia untuk tugas agent.");
    }
    this.autonomousWorkflow = this.workflowMode === "autonomous" ? createAutonomousWorkflow(text) : null;
    await this.session.update({
      desktopWorkflowMode: this.workflowMode,
      autonomousWorkflow: this.autonomousWorkflow,
    });
    const { files, missing } = await extractAtMentions(text, this.session.state.projectRoot);
    if (missing.length) {
      this.#emit("desktop.notice", { message: "Beberapa lampiran @path tidak ditemukan.", details: missing });
    }
    await this.session.appendInstruction(text, { files });
    return await this.#runTurn({
      resume: true,
      instruction: this.workflowMode === "autonomous" ? buildAutonomousPlanningInstruction(text) : text,
      displayInstruction: text,
      files,
    });
  }

  async approveAutonomousPlan() {
    if (!this.session) throw new Error("Tidak ada sesi agent aktif.");
    if (this.running || this.autonomousDecisionInProgress) throw new Error("Agent sedang memproses tugas.");
    this.autonomousDecisionInProgress = true;
    try {
      const approved = approveAutonomousWorkflow(this.session.state.autonomousWorkflow ?? this.autonomousWorkflow);
      const verificationPlan = await resolveAutonomousChecks({
        workspace: this.session.state.projectRoot,
      });
      const appDataDir = path.resolve(getAppDataDir());
      const checkpoint = await WorkspaceCheckpoint.create({ workspace: this.session.state.projectRoot, directory: path.join(appDataDir, "autonomous-checkpoints"), sessionId: this.session.sessionId });
      this.workspaceCheckpoint = checkpoint;
      this.autonomousVerificationPlan = verificationPlan;
      const instruction = buildApprovedImplementationInstruction(approved);
      this.workflowMode = "autonomous";
      this.autonomousWorkflow = approved;
      // Persist the implementation instruction and approval phase in the same
      // state snapshot. A crash cannot leave an approved phase without its
      // corresponding resumable instruction (or a queued instruction while
      // still appearing unapproved).
      await this.session.appendInstruction(instruction, {
        statePatch: {
          desktopWorkflowMode: "autonomous",
          autonomousWorkflow: approved,
          autonomousVerificationPlan: verificationPlan,
          workspaceCheckpoint: { id: checkpoint.id, directory: checkpoint.directory, status: "captured", createdAt: checkpoint.metadata.createdAt },
        },
      });
      await this.session.appendEvent("autonomous.plan_approved", {
        approvedAt: approved.approvedAt,
        planSha256: approved.planSha256,
      });
      this.#emit("desktop.plan_approved", {
        approvedAt: approved.approvedAt,
        planSha256: approved.planSha256,
      });
      return await this.#runTurn({
        resume: true,
        instruction,
        displayInstruction: "Implementasi dimulai untuk rencana yang telah disetujui: " + approved.task,
        files: [],
      });
    } finally {
      this.autonomousDecisionInProgress = false;
    }
  }

  async acceptAutonomousVerification(summary) {
    if (!this.session) throw new Error("Tidak ada sesi agent aktif.");
    if (this.running || this.autonomousDecisionInProgress) {
      throw new Error("Tunggu agent berhenti sebelum menerima hasil verifikasi.");
    }
    const accepted = acceptAutonomousVerification(
      this.session.state.autonomousWorkflow ?? this.autonomousWorkflow,
      summary,
    );
    this.autonomousWorkflow = accepted;
    await this.session.update({ autonomousWorkflow: accepted });
    await this.session.appendEvent("autonomous.user_accepted", {
      acceptedAt: accepted.verificationAcceptedAt,
      planSha256: accepted.planSha256,
      verificationSummary: accepted.verificationSummary,
    });
    this.#emit("desktop.autonomous_accepted", {
      acceptedAt: accepted.verificationAcceptedAt,
      planSha256: accepted.planSha256,
      verificationSummary: accepted.verificationSummary,
      verificationStatus: accepted.verificationStatus,
    });
    return accepted;
  }

  async rollbackWorkspaceCheckpoint() {
    if(!this.session)throw Error("Tidak ada sesi agent aktif.");
    if(this.running||this.autonomousDecisionInProgress)throw Error("Tunggu agent selesai sebelum rollback.");
    const cp=this.session.state.workspaceCheckpoint;
    if(!cp?.directory||cp.status!=="completed")throw Error("Tidak ada checkpoint workspace yang siap di-rollback.");
    const result=await WorkspaceCheckpoint.rollback({directory:cp.directory});
    await this.session.update({workspaceCheckpoint:{...cp,status:"rolled_back",rolledBackAt:new Date().toISOString()}});
    await this.session.appendEvent("autonomous.workspace_rolled_back",result);
    this.#emit("desktop.workspace_rolled_back",result);return result;
  }

  async rejectAutonomousPlan() {
    if (!this.session) throw new Error("Tidak ada sesi agent aktif.");
    if (this.running || this.autonomousDecisionInProgress) throw new Error("Agent sedang memproses tugas.");
    this.autonomousDecisionInProgress = true;
    try {
      const rejected = rejectAutonomousWorkflow(this.session.state.autonomousWorkflow ?? this.autonomousWorkflow);
      this.workflowMode = "autonomous";
      this.autonomousWorkflow = rejected;
      await this.session.update({ desktopWorkflowMode: "autonomous", autonomousWorkflow: rejected });
      await this.session.appendEvent("autonomous.plan_rejected", {
        rejectedAt: rejected.rejectedAt,
        planSha256: rejected.planSha256,
      });
      this.#emit("desktop.plan_rejected", { rejectedAt: rejected.rejectedAt, planSha256: rejected.planSha256 });
      return true;
    } finally {
      this.autonomousDecisionInProgress = false;
    }
  }


  cancel() {
    if (!this.adapter || !this.running) return false;
    this.adapter.escCancelRequested = true;
    this.#emit("desktop.cancel_requested");
    return true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.continueProviderSelection();
    if (this.session && ["initializing", "running", "waiting_model", "auth_required"].includes(this.session.state.phase)) {
      await this.session.update({ phase: "interrupted", lastError: this.session.state.lastError || "Desktop app closed." }).catch(() => {});
    }
    for (const [requestId, pending] of this.pendingApprovals) {
      pending.resolve(false);
      this.pendingApprovals.delete(requestId);
    }
    await this.processManager?.stopAll().catch(() => {});
    await this.adapter?.close().catch(() => {});
  }
}
