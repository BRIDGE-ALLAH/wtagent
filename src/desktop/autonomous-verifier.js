import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildToolEnvironment } from "../tools/safe-env.js";
import { killProcessTree } from "../tools/process-utils.js";
import { isPathInside } from "../policy/path-guard.js";
import { utf8ByteLength, utf8Suffix } from "../shared/text-budget.js";

const MAX_STREAM_BYTES = 32 * 1024;
const DEFAULT_TIMEOUTS = Object.freeze({ test: 120_000, check: 45_000 });
const DEFAULT_TOTAL_BUDGET_MS = 180_000;
const DEFAULT_STOP_GRACE_MS = 1_000;
const DEFAULT_FORCE_GRACE_MS = 1_000;

function unsupported(id, reason) {
  return {
    id,
    status: "unsupported",
    reason,
    completionKnown: true,
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    outputTruncated: false,
  };
}

async function resolveNodeScript(root, id, script, timeoutMs) {
  if (typeof script !== "string" || !script.trim()) {
    return { error: unsupported(`package:${id}`, "The package script is empty or not a string.") };
  }

  const parts = script.trim().split(/\s+/);
  if (parts.length !== 2 || !/^node(?:\.exe)?$/i.test(parts[0])) {
    return { error: unsupported(`package:${id}`, "Only a direct 'node <workspace-relative-script>' command is supported; shell syntax and command chains are rejected.") };
  }

  const relativeScript = parts[1];
  if (
    !relativeScript
    || relativeScript.startsWith("-")
    || path.isAbsolute(relativeScript)
    || relativeScript.includes("*")
    || relativeScript.includes("?")
    || relativeScript.split(/[\\/]/).some((part) => part === "..")
  ) {
    return { error: unsupported(`package:${id}`, "The script path must be a literal relative path inside the workspace.") };
  }

  const candidate = path.resolve(root, relativeScript);
  if (!isPathInside(root, candidate)) {
    return { error: unsupported(`package:${id}`, "The script path escapes the workspace.") };
  }

  try {
    const realScript = await fs.realpath(candidate);
    if (!isPathInside(root, realScript)) {
      return { error: unsupported(`package:${id}`, "The script resolves outside the workspace.") };
    }
    const stat = await fs.stat(realScript);
    if (!stat.isFile()) {
      return { error: unsupported(`package:${id}`, "The script path is not a regular file.") };
    }
    const scriptBytes = await fs.readFile(realScript);
    return {
      check: {
        id: `package:${id}`,
        manifestPath: "package.json",
        script: relativeScript,
        scriptSha256: createHash("sha256").update(scriptBytes).digest("hex"),
        executable: process.execPath,
        args: [realScript],
        cwd: root,
        timeoutMs,
      },
    };
  } catch (error) {
    return { error: unsupported(`package:${id}`, `The script file is unavailable: ${error.message}`) };
  }
}

async function snapshotBaselineTestFiles(root) {
  const testRoot = path.join(root, "test");
  const files = [];
  let totalBytes = 0;
  const maxFiles = 2_000;
  const maxFileBytes = 5 * 1024 * 1024;
  const maxTotalBytes = 64 * 1024 * 1024;

  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" && directory === testRoot) return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Baseline test tree contains a symbolic link: ${path.relative(root, fullPath)}`);
      }
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(fullPath);
      if (stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes || files.length >= maxFiles) {
        throw new Error("Baseline test tree exceeds the verification integrity snapshot budget.");
      }
      const bytes = await fs.readFile(fullPath);
      totalBytes += bytes.length;
      files.push({
        path: path.relative(root, fullPath),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }

  await visit(testRoot);
  return files;
}

export async function resolveAutonomousChecks({ workspace }) {
  let root;
  try {
    root = await fs.realpath(path.resolve(String(workspace ?? "")));
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error("Workspace is not a directory.");
  } catch (error) {
    return {
      status: "unavailable", workspaceRoot: null, manifestSha256: null,
      checks: [], unsupported: [], integrityFiles: [], reason: error.message,
    };
  }

  let manifestText;
  let manifest;
  try {
    manifestText = await fs.readFile(path.join(root, "package.json"), "utf8");
    manifest = JSON.parse(manifestText);
  } catch (error) {
    return {
      status: "unavailable",
      workspaceRoot: root,
      manifestSha256: null,
      checks: [],
      unsupported: [],
      integrityFiles: [],
      reason: error.code === "ENOENT" ? "No root package.json manifest was found." : `package.json could not be parsed: ${error.message}`,
    };
  }

  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  const scripts = manifest?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return {
      status: "unavailable", workspaceRoot: root, manifestSha256,
      checks: [], unsupported: [], integrityFiles: [],
      reason: "The root package.json has no scripts object.",
    };
  }

  const checks = [];
  const rejected = [];
  let discovered = 0;
  for (const id of ["test", "check"]) {
    if (!Object.prototype.hasOwnProperty.call(scripts, id)) continue;
    discovered += 1;
    const result = await resolveNodeScript(root, id, scripts[id], DEFAULT_TIMEOUTS[id]);
    if (result.check) checks.push(result.check);
    else rejected.push(result.error);
  }

  let integrityFiles = [];
  try {
    integrityFiles = await snapshotBaselineTestFiles(root);
    for (const check of checks) {
      integrityFiles.push({
        path: path.relative(root, check.args[0]),
        sha256: check.scriptSha256,
      });
    }
    integrityFiles = [...new Map(integrityFiles.map((item) => [item.path, item])).values()];
  } catch (error) {
    rejected.push(unsupported("verification:baseline-integrity", error.message));
  }

  if (discovered === 0) {
    return {
      status: rejected.length ? "unsupported" : "unavailable",
      workspaceRoot: root,
      manifestSha256,
      checks: [],
      unsupported: rejected,
      integrityFiles,
      reason: rejected.length ? "The baseline verification files could not be trusted." : "No supported verification scripts (test/check) were declared in package.json.",
    };
  }
  return {
    status: rejected.length ? "unsupported" : "ready",
    workspaceRoot: root,
    manifestSha256,
    checks,
    unsupported: rejected,
    integrityFiles,
    reason: rejected.length ? "One or more required package scripts or baseline test files are unsupported or untrusted." : null,
  };
}

async function verifyAutonomousVerificationPlan(workspaceRoot, plan) {
  if (!plan || plan.workspaceRoot !== workspaceRoot || !Array.isArray(plan.checks) || !Array.isArray(plan.integrityFiles)) {
    return "A trusted verification plan captured before implementation is missing or invalid.";
  }
  for (const item of plan.integrityFiles) {
    if (!item || typeof item.path !== "string" || typeof item.sha256 !== "string") {
      return "The persisted verification integrity manifest is malformed.";
    }
    const candidate = path.resolve(workspaceRoot, item.path);
    if (!isPathInside(workspaceRoot, candidate)) {
      return `A baseline verification file escapes the workspace: ${item.path}`;
    }
    try {
      const realPath = await fs.realpath(candidate);
      if (!isPathInside(workspaceRoot, realPath)) {
        return `A baseline verification file resolves outside the workspace: ${item.path}`;
      }
      const bytes = await fs.readFile(realPath);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== item.sha256) {
        return `A baseline verification file changed after planning: ${item.path}`;
      }
    } catch (error) {
      return `A baseline verification file is unavailable: ${item.path} (${error.message})`;
    }
  }
  for (const check of plan.checks) {
    if (
      !check
      || !["package:test", "package:check"].includes(check.id)
      || check.executable !== process.execPath
      || check.cwd !== workspaceRoot
      || !Array.isArray(check.args)
      || check.args.length !== 1
      || typeof check.scriptSha256 !== "string"
      || !Number.isInteger(check.timeoutMs)
      || check.timeoutMs < 1
      || check.timeoutMs > DEFAULT_TOTAL_BUDGET_MS
    ) {
      return "A persisted verification command descriptor is invalid.";
    }
    const scriptPath = path.resolve(check.args[0]);
    if (!isPathInside(workspaceRoot, scriptPath)) {
      return `A verification script escapes the workspace: ${check.id}`;
    }
    try {
      const realPath = await fs.realpath(scriptPath);
      if (!isPathInside(workspaceRoot, realPath) || realPath !== scriptPath) {
        return `A verification script path changed or escaped the workspace: ${check.id}`;
      }
      const bytes = await fs.readFile(realPath);
      if (createHash("sha256").update(bytes).digest("hex") !== check.scriptSha256) {
        return `A verification script changed after planning: ${check.id}`;
      }
    } catch (error) {
      return `A verification script is unavailable: ${check.id} (${error.message})`;
    }
  }
  return null;
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

function safeVerificationEnvironment(home) {
  const env = buildToolEnvironment({ inheritSensitive: false });
  for (const name of Object.keys(env)) {
    if (/^(?:npm_|NPM_)/.test(name)) delete env[name];
  }
  env.CI = "1";
  env.NODE_ENV = "test";
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = home;
  env.LOCALAPPDATA = home;
  env.TMP = home;
  env.TEMP = home;
  env.TMPDIR = home;
  return env;
}

async function boundedKill(killProcessTreeImpl, pid, signal) {
  if (!pid) return;
  let timer;
  await Promise.race([
    Promise.resolve().then(() => killProcessTreeImpl(pid, signal)).catch(() => undefined),
    new Promise((resolve) => { timer = setTimeout(resolve, 300); }),
  ]);
  clearTimeout(timer);
}

async function runCheck(check, {
  spawnImpl,
  killProcessTreeImpl,
  platform,
  stopGraceMs,
  forceGraceMs,
  outputLimitBytes,
  home,
}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputTruncated = false;
  let closed = false;
  let closeInfo = null;
  let processError = null;
  let timedOut = false;
  let settled = false;
  let resolveClose;
  const closePromise = new Promise((resolve) => { resolveClose = resolve; });
  let child;

  const capture = (stream, text) => {
    if (!text) return;
    if (stream === "stdout") {
      stdoutBytes += utf8ByteLength(text);
      stdout = utf8Suffix(stdout + text, outputLimitBytes);
      if (stdoutBytes > outputLimitBytes) outputTruncated = true;
    } else {
      stderrBytes += utf8ByteLength(text);
      stderr = utf8Suffix(stderr + text, outputLimitBytes);
      if (stderrBytes > outputLimitBytes) outputTruncated = true;
    }
  };

  const result = await new Promise((resolve) => {
    let timer;
    const finish = (status, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      capture("stdout", stdoutDecoder.end());
      capture("stderr", stderrDecoder.end());
      resolve({
        ...check,
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        exitCode: closeInfo?.code ?? null,
        signal: closeInfo?.signal ?? null,
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        outputTruncated,
        completionKnown: closed || status === "spawn_error",
        ...(processError ? { error: processError.message } : {}),
        ...extra,
      });
    };

    const terminate = async () => {
      if (closed) return;
      if (!child?.pid) {
        finish("timed_out", { completionKnown: false, error: "The timed-out process has no observable PID." });
        return;
      }
      await boundedKill(killProcessTreeImpl, child.pid, "SIGTERM");
      if (await waitForClose({ closed, closePromise }, stopGraceMs)) return;
      if (closed) return;
      await boundedKill(killProcessTreeImpl, child.pid, "SIGKILL");
      if (await waitForClose({ closed, closePromise }, forceGraceMs)) return;
      finish("timed_out", { completionKnown: false, error: "Process exit could not be confirmed after termination escalation." });
    };

    timer = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, check.timeoutMs);

    try {
      child = spawnImpl(check.executable, check.args, {
        cwd: check.cwd,
        env: safeVerificationEnvironment(home),
        shell: false,
        detached: platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      processError = error;
      finish("spawn_error");
      return;
    }

    child.stdout?.on("data", (chunk) => capture("stdout", stdoutDecoder.write(chunk)));
    child.stderr?.on("data", (chunk) => capture("stderr", stderrDecoder.write(chunk)));
    child.once("error", (error) => {
      processError = error;
      if (!child.pid) finish("spawn_error");
    });
    child.once("close", (code, signal) => {
      if (closed) return;
      closed = true;
      closeInfo = { code, signal };
      resolveClose();
      finish(timedOut ? "timed_out" : processError ? "spawn_error" : code === 0 ? "passed" : "failed");
    });
  });

  return result;
}

export async function runAutonomousVerification({
  workspace,
  spawnImpl = spawn,
  killProcessTreeImpl = killProcessTree,
  platform = process.platform,
  stopGraceMs = DEFAULT_STOP_GRACE_MS,
  forceGraceMs = DEFAULT_FORCE_GRACE_MS,
  outputLimitBytes = MAX_STREAM_BYTES,
  totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
  timeoutOverrides = {},
} = {}) {
  const resolved = await resolveAutonomousChecks({ workspace });
  if (!selectedChecks.length) {
    return {
      status: resolved.status === "unsupported" ? "unsupported" : "unavailable",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      checks: [],
      unsupported: resolved.unsupported,
      manifestSha256: resolved.manifestSha256 ?? null,
      reason: resolved.reason,
    };
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const results = [];
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-verification-home-"));
  try {
    for (const check of resolved.checks) {
      const remaining = totalBudgetMs - (Date.now() - started);
      if (remaining <= 0) {
        results.push({
          ...check,
          status: "timed_out",
          completionKnown: false,
          error: "Total verification time budget exhausted before this check started.",
          startedAt: null,
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          outputTruncated: false,
        });
        break;
      }
      const requestedTimeout = timeoutOverrides[check.id] ?? check.timeoutMs;
      const boundedCheck = { ...check, timeoutMs: Math.min(requestedTimeout, remaining) };
      const result = await runCheck(boundedCheck, {
        spawnImpl,
        killProcessTreeImpl,
        platform,
        stopGraceMs,
        forceGraceMs,
        outputLimitBytes,
        home,
      });
      results.push(result);
      if (result.status === "timed_out" && !result.completionKnown) break;
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  const skipped = selectedChecks.slice(results.length).map((check) => ({
    ...check,
    status: "skipped",
    completionKnown: false,
    reason: "A previous verification process did not terminate with confirmed completion.",
  }));
  const allChecks = [...results, ...skipped, ...resolved.unsupported];
  const passed = resolved.unsupported.length === 0
    && results.length === selectedChecks.length
    && results.every((item) => item.status === "passed" && item.exitCode === 0 && item.completionKnown);
  let status = passed
    ? "passed"
    : allChecks.some((item) => item.status === "timed_out") ? "timed_out"
      : resolved.unsupported.length ? "unsupported" : "failed";
  let reason = passed ? null : resolved.reason ?? "One or more required checks did not produce confirmed successful exit evidence.";
  const postRunIntegrityError = await verifyAutonomousVerificationPlan(workspaceRoot, resolved);
  if (postRunIntegrityError) {
    status = "integrity_failed";
    reason = postRunIntegrityError;
    allChecks.push(unsupported("verification:integrity", postRunIntegrityError));
  }

  return {
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    checks: allChecks,
    unsupported: resolved.unsupported,
    manifestSha256: resolved.manifestSha256 ?? null,
    baselineIntegrityFileCount: resolved.integrityFiles?.length ?? 0,
    reason,
  };
}

export function recordAutonomousMachineVerification(workflow, result, now = new Date().toISOString()) {
  if (!workflow || workflow.version !== 1 || workflow.phase !== "implementing") {
    throw new Error("Autonomous workflow is not in the implementation phase.");
  }
  const checks = [
    ...(Array.isArray(result?.checks) ? result.checks : []),
    ...(Array.isArray(result?.unsupported) ? result.unsupported : []),
  ];
  const machineVerified = result?.status === "passed"
    && checks.length > 0
    && checks.every((check) => check.status === "passed" && check.exitCode === 0 && check.completionKnown === true);
  return {
    ...workflow,
    phase: machineVerified ? "completed" : "verification_required",
    verificationStatus: machineVerified ? "machine_verified" : String(result?.status ?? "unavailable"),
    verificationStartedAt: result?.startedAt ?? now,
    verificationCompletedAt: result?.finishedAt ?? now,
    machineVerification: {
      status: String(result?.status ?? "unavailable"),
      durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : null,
      reason: result?.reason ?? null,
      checks,
    },
    verificationRequiredAt: machineVerified ? null : now,
    completedAt: machineVerified ? now : null,
    lastError: machineVerified ? null : result?.reason ?? "Machine verification did not pass.",
  };
}
