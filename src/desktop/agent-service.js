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

  #forwardRuntimeEvent(event) {
    if (!event || typeof event.type !== "string") return;
    // Raw protocol responses can contain large payloads. The desktop UI uses
    // parsed progress and final messages instead of rendering protocol XML.
    if (event.type === "model.streaming") return;
    const payload = { ...(event.payload ?? {}) };
    delete payload.raw;
    if (typeof payload.output === "string") payload.output = payload.output.slice(0, 12_000);
    if (typeof payload.stdout === "string") payload.stdout = payload.stdout.slice(-8_000);
    if (typeof payload.stderr === "string") payload.stderr = payload.stderr.slice(-8_000);
    emitSafely(this.onEvent, {
      type: event.type,
      sessionId: event.sessionId ?? this.session?.sessionId ?? null,
      timestamp: event.timestamp ?? new Date().toISOString(),
      payload,
    });
  }

  async start({ projectRoot, model = "chatgpt", instruction, generationType = "agent" }) {
    if (this.session) throw new Error("An agent session is already active.");
    assertNativeRuntimeSupported();

    const root = path.resolve(String(projectRoot ?? ""));
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error("Pilih folder proyek yang valid.");
    const provider = resolveProvider(model);
    const resolvedType = validateGenerationType(generationType, provider.id);
    const appDataDir = path.resolve(getAppDataDir());
    const sessionsDir = getSessionsDir(appDataDir);
    await ensureDirectory(sessionsDir);

    this.provider = provider;
    this.session = await AgentSession.create({
      sessionsDir,
      task: String(instruction ?? "").trim(),
      projectRoot: root,
      provider: provider.id,
      mode: null,
      generationType: resolvedType,
    });
    this.#initializeRuntimeParts(appDataDir, resolvedType);
    this.#emit("desktop.session_started", {
      sessionId: this.session.sessionId,
      projectRoot: root,
      provider: provider.id,
    });

    const attachmentResult = await extractAtMentions(instruction, root);
    if (attachmentResult.missing.length) {
      this.#emit("desktop.notice", {
        message: "Beberapa lampiran @path tidak ditemukan.",
        details: attachmentResult.missing,
      });
    }
    return await this.#runTurn({
      resume: false,
      instruction: String(instruction ?? "").trim(),
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
    }));
  }

  async resume({ sessionId, instruction = "" }) {
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
    if (["initializing", "running", "waiting_model", "auth_required"].includes(session.state.phase)) {
      await session.update({ phase: "interrupted" });
    }
    this.#initializeRuntimeParts(appDataDir, generationType);
    this.#emit("desktop.session_started", {
      sessionId: session.sessionId,
      projectRoot,
      provider: provider.id,
      resumed: true,
      recoveryRequired: Boolean(session.state.pendingOutbound || session.state.pendingAssistantTurn),
    });

    const text = String(instruction ?? "").trim();
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
      instruction: text,
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
    return new AgentRuntime({
      adapter: this.adapter,
      nativeImageReceiver: this.nativeImageReceiver,
      nativeMusicReceiver: this.nativeMusicReceiver,
      registry: createDefaultToolRegistry({
        processManager: this.processManager,
        limits: this.limits,
      }),
      policy: new PolicyEngine({ store: this.approvalStore }),
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

  async #runTurn({ resume, instruction, files = [] }) {
    if (this.running) throw new Error("Agent sedang memproses tugas sebelumnya.");
    this.running = true;
    this.#emit("desktop.turn_started", { instruction });
    try {
      const runtime = await this.#buildRuntime();
      const result = await runtime.run({
        resume,
        instruction,
        files,
        inPlaceRecovery: false,
        mode: null,
      });
      this.#emit("desktop.turn_finished", {
        sessionId: this.session.sessionId,
        phase: this.session.state.phase,
      });
      return result;
    } catch (error) {
      if (this.session?.state?.phase !== "idle") {
        await this.session.update({
          phase: "interrupted",
          lastError: error.message,
        }).catch(() => {});
      }
      this.#emit("desktop.agent_error", {
        message: error.message,
        code: error.code ?? null,
      });
      throw error;
    } finally {
      this.running = false;
    }
  }

  async send(instruction) {
    if (!this.session) throw new Error("Mulai agent terlebih dahulu.");
    if (this.running) throw new Error("Agent masih memproses tugas sebelumnya.");
    const text = String(instruction ?? "").trim();
    if (!text) throw new Error("Instruksi tidak boleh kosong.");
    const { files, missing } = await extractAtMentions(text, this.session.state.projectRoot);
    if (missing.length) {
      this.#emit("desktop.notice", {
        message: "Beberapa lampiran @path tidak ditemukan.",
        details: missing,
      });
    }
    await this.session.appendInstruction(text, { files });
    return await this.#runTurn({ resume: true, instruction: text, files });
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
