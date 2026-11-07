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
  approveAutonomousWorkflow,
  buildApprovedImplementationInstruction,
  buildAutonomousPlanningInstruction,
  createAutonomousWorkflow,
  normalizeWorkflowMode,
  rejectAutonomousWorkflow,
  shouldEnforceReadOnlyPolicy,
  storeAutonomousPlan,
} from "./autonomous-workflow.js";
import { WorkspaceCheckpoint } from "./workspace-checkpoint.js";

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
    this.autonomousDecisionInProgress = false;
    this.workspaceCheckpoint = null;
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
          this.autonomousWorkflow = storeAutonomousPlan(this.autonomousWorkflow, payload.message);
          await this.session.update({ autonomousWorkflow: this.autonomousWorkflow });
          await this.session.appendEvent("autonomous.plan_ready", {
            planSha256: this.autonomousWorkflow.planSha256,
            plannedAt: this.autonomousWorkflow.plannedAt,
          });
          this.#emit("desktop.plan_ready", {
            plan: this.autonomousWorkflow.plan,
            planSha256: this.autonomousWorkflow.planSha256,
            plannedAt: this.autonomousWorkflow.plannedAt,
            task: this.autonomousWorkflow.task,
          });
        } catch (error) {
          this.autonomousWorkflow = { ...this.autonomousWorkflow, phase: "plan_failed", lastError: error.message };
          await this.session.update({ autonomousWorkflow: this.autonomousWorkflow });
          await this.session.appendEvent("autonomous.plan_failed", { message: this.autonomousWorkflow.lastError });
          this.#emit("desktop.plan_failed", { message: error.message || "Agent belum menghasilkan rencana yang dapat ditinjau." });
        }
      } else if (this.autonomousWorkflow?.phase === "implementing") {
        this.autonomousWorkflow = {
          ...this.autonomousWorkflow,
          phase: "completed",
          completedAt: new Date().toISOString(),
          lastError: null,
        };
        await this.session.update({ autonomousWorkflow: this.autonomousWorkflow });
        await this.session.appendEvent("autonomous.completed", {
          completedAt: this.autonomousWorkflow.completedAt,
          planSha256: this.autonomousWorkflow.planSha256,
        });
        this.#emit("desktop.autonomous_completed", {
          completedAt: this.autonomousWorkflow.completedAt,
          planSha256: this.autonomousWorkflow.planSha256,
        });
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
      recoveryRequired: Boolean(state.pendingOutbound || state.pendingAssistantTurn),
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
    const projectRoot = path.resolve(String(session.state.projectRoot ?? ""));
    const projectStat = await fs.stat(projectRoot);
    if (!projectStat.isDirectory()) throw new Error("Folder proyek sesi ini tidak lagi tersedia.");
    const provider = resolveProvider(session.state.provider);
    const generationType = validateGenerationType(session.state.generationType || "agent", provider.id);
    this.provider = provider;
    this.session = session;
    this.workflowMode = normalizeWorkflowMode(workflowMode ?? session.state.desktopWorkflowMode);
    this.autonomousWorkflow = session.state.autonomousWorkflow ?? null;
    const text = String(instruction ?? "").trim();
    const pendingRecovery = Boolean(session.state.pendingOutbound || session.state.pendingAssistantTurn);
    if (this.autonomousWorkflow?.phase === "awaiting_approval" && text) {
      throw new Error("Tinjau, setujui, atau tolak rencana autonomous sebelum mengirim instruksi baru.");
    }
    if (this.workflowMode === "autonomous" && text) {
      if (generationType !== "agent") throw new Error("Autonomous coding workflow hanya tersedia untuk tugas agent.");
      this.autonomousWorkflow = createAutonomousWorkflow(text);
    }
    await session.update({
      desktopWorkflowMode: this.workflowMode,
      autonomousWorkflow: this.autonomousWorkflow,
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
    if (["rejected", "completed", "plan_failed"].includes(this.autonomousWorkflow?.phase) && !text && !pendingRecovery) {
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
        if (shouldEnforceReadOnlyPolicy({
          workflowMode: this.workflowMode,
          autonomousWorkflow: this.autonomousWorkflow,
        })) {
          const definition = registry.list().find((tool) => tool.name === toolCall.name);
          if (definition && definition.risk !== "read") {
            return {
              action: "deny",
              reasons: [this.workflowMode === "autonomous"
                ? "Autonomous planning phase: tool " + toolCall.name + " is blocked until the user approves the plan."
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
      const result = await runtime.run({
        resume,
        instruction,
        files,
        inPlaceRecovery: false,
        mode: null,
      });
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
      const appDataDir = path.resolve(getAppDataDir());
      const checkpoint = await WorkspaceCheckpoint.create({ workspace: this.session.state.projectRoot, directory: path.join(appDataDir, "autonomous-checkpoints"), sessionId: this.session.sessionId });
      this.workspaceCheckpoint = checkpoint;
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
