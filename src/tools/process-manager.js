import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildToolEnvironment } from "./safe-env.js";
import { killProcessTree } from "./process-utils.js";
import { resolveLaunchPlan } from "../platform/command-launcher.js";
import {
  truncateUtf8HeadTail,
  utf8ByteLength,
  utf8Suffix,
} from "../shared/text-budget.js";

const MAX_PROCESS_LOG_BYTES = 1024 * 1024;
const DEFAULT_MAX_PROCESSES = 128;
const DEFAULT_MAX_DETECTED_URLS = 64;
const DEFAULT_STOP_GRACE_MS = 1_500;
const DEFAULT_FORCE_STOP_GRACE_MS = 750;
const URL_PATTERN = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/[^\s]*)?/gi;

function appendBounded(record, stream, chunk) {
  const text = String(chunk ?? "");
  if (!text) return;
  record[`${stream}Bytes`] += utf8ByteLength(text);
  record[stream] += text;
  if (utf8ByteLength(record[stream]) > MAX_PROCESS_LOG_BYTES) {
    record[stream] = utf8Suffix(record[stream], MAX_PROCESS_LOG_BYTES);
    record.truncated = true;
  }

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0];
    if (record.urls.has(url)) continue;
    if (record.urls.size >= record.maxDetectedUrls) {
      record.detectedUrlsTruncated = true;
      continue;
    }
    record.urls.add(url);
  }
}

function waitForClose(record, timeoutMs) {
  if (record.closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    record.closePromise.then(() => finish(true));
  });
}

function capacityError(maxProcesses) {
  const error = new Error(`Process capacity reached (${maxProcesses}); stop an active process before starting another.`);
  error.code = "PROCESS_CAPACITY_REACHED";
  return error;
}

export class ProcessManager {
  #processes = new Map();

  constructor({
    spawnImpl = spawn,
    platform = process.platform,
    resolveLaunchPlanImpl = resolveLaunchPlan,
    killProcessTreeImpl = killProcessTree,
    maxProcesses = DEFAULT_MAX_PROCESSES,
    maxDetectedUrls = DEFAULT_MAX_DETECTED_URLS,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    forceStopGraceMs = DEFAULT_FORCE_STOP_GRACE_MS,
  } = {}) {
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.resolveLaunchPlanImpl = resolveLaunchPlanImpl;
    this.killProcessTreeImpl = killProcessTreeImpl;
    this.maxProcesses = maxProcesses;
    this.maxDetectedUrls = maxDetectedUrls;
    this.stopGraceMs = stopGraceMs;
    this.forceStopGraceMs = forceStopGraceMs;
  }

  #pruneClosedRecords() {
    if (this.#processes.size < this.maxProcesses) return;
    const closed = [...this.#processes.values()]
      .filter((record) => record.closed)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    while (this.#processes.size >= this.maxProcesses && closed.length) {
      this.#processes.delete(closed.shift().id);
    }
  }

  start({ program, argv, cwd, inheritSensitiveEnv }) {
    this.#pruneClosedRecords();
    if (this.#processes.size >= this.maxProcesses) {
      throw capacityError(this.maxProcesses);
    }

    const id = `proc_${randomUUID().slice(0, 8)}`;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const environment = buildToolEnvironment({ inheritSensitive: inheritSensitiveEnv });
    const launchPlan = this.resolveLaunchPlanImpl({
      program,
      argv,
      cwd,
      env: environment,
      platform: this.platform,
    });
    const child = this.spawnImpl(launchPlan.command, launchPlan.args, {
      cwd,
      env: environment,
      shell: launchPlan.shell,
      detached: this.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: launchPlan.windowsVerbatimArguments === true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolveClose;
    const closePromise = new Promise((resolve) => { resolveClose = resolve; });
    const record = {
      id,
      child,
      program,
      argv,
      cwd,
      startedAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      urls: new Set(),
      maxDetectedUrls: this.maxDetectedUrls,
      detectedUrlsTruncated: false,
      closed: false,
      closePromise,
      resolveClose,
      stopPromise: null,
      processError: null,
      stopError: null,
    };
    this.#processes.set(id, record);

    child.stdout?.on("data", (chunk) => (
      appendBounded(record, "stdout", stdoutDecoder.write(chunk))
    ));
    child.stderr?.on("data", (chunk) => (
      appendBounded(record, "stderr", stderrDecoder.write(chunk))
    ));
    child.stdout?.on("end", () => (
      appendBounded(record, "stdout", stdoutDecoder.end())
    ));
    child.stderr?.on("end", () => (
      appendBounded(record, "stderr", stderrDecoder.end())
    ));
    child.once("error", (error) => {
      record.processError = error;
      if (!record.closed) record.status = "error";
      appendBounded(record, "stderr", `\n${error.message}`);
    });
    child.once("close", (code, signal) => {
      if (record.closed) return;
      record.closed = true;
      record.status = record.processError ? "error" : "exited";
      record.exitCode = code;
      record.signal = signal;
      record.resolveClose();
    });

    return this.snapshot(record);
  }

  read(id, options = {}) {
    const record = this.#processes.get(id);
    if (!record) {
      throw new Error(`Unknown process: ${id}`);
    }
    return this.snapshot(record, options);
  }

  list(options = {}) {
    return [...this.#processes.values()].map((record) => (
      this.snapshot(record, options)
    ));
  }

  async #terminate(record) {
    if (record.closed) return;
    try {
      await this.killProcessTreeImpl(record.child.pid, "SIGTERM");
    } catch (error) {
      record.stopError = error;
    }
    if (await waitForClose(record, this.stopGraceMs)) return;

    try {
      await this.killProcessTreeImpl(record.child.pid, "SIGKILL");
    } catch (error) {
      record.stopError = error;
    }
    if (await waitForClose(record, this.forceStopGraceMs)) return;

    record.status = "completion_unknown";
    if (record.stopError) {
      appendBounded(record, "stderr", `\nProcess stop error: ${record.stopError.message}`);
    }
  }

  async stop(id, options = {}) {
    const record = this.#processes.get(id);
    if (!record) {
      throw new Error(`Unknown process: ${id}`);
    }
    if (!record.closed && !record.stopPromise) {
      record.status = "stopping";
      record.stopPromise = this.#terminate(record);
    }
    if (record.stopPromise) await record.stopPromise;
    return this.snapshot(record, options);
  }

  async stopAll() {
    await Promise.all(
      [...this.#processes.keys()].map((id) => this.stop(id).catch(() => null)),
    );
  }

  snapshot(record, { includeOutput = true, maxOutputBytes = Infinity } = {}) {
    const snapshot = {
      processId: record.id,
      pid: record.child.pid,
      program: record.program,
      argv: record.argv,
      cwd: record.cwd,
      startedAt: record.startedAt,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      truncated: record.truncated,
      detectedUrls: [...record.urls],
      detectedUrlsTruncated: record.detectedUrlsTruncated,
    };

    if (!includeOutput) {
      return snapshot;
    }

    let stdoutBudget = record.stdoutBytes;
    let stderrBudget = record.stderrBytes;
    if (Number.isFinite(maxOutputBytes)) {
      stderrBudget = Math.min(stderrBudget, Math.floor(maxOutputBytes * 0.75));
      stdoutBudget = Math.min(stdoutBudget, maxOutputBytes - stderrBudget);
      stderrBudget += Math.min(
        record.stderrBytes - stderrBudget,
        maxOutputBytes - stdoutBudget - stderrBudget,
      );
      stdoutBudget += Math.min(
        record.stdoutBytes - stdoutBudget,
        maxOutputBytes - stdoutBudget - stderrBudget,
      );
    }

    const stdout = truncateUtf8HeadTail(record.stdout, stdoutBudget);
    const stderr = truncateUtf8HeadTail(record.stderr, stderrBudget);
    return {
      ...snapshot,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: record.stdoutBytes,
      stderrBytes: record.stderrBytes,
      includedOutputBytes: stdout.includedBytes + stderr.includedBytes,
      truncated: snapshot.truncated || stdout.truncated || stderr.truncated,
    };
  }
}
