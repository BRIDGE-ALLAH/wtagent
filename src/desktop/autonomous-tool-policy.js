import fs from "node:fs/promises";
import path from "node:path";
import { resolveToolPath } from "../policy/path-guard.js";

const READ_ONLY_TOOLS = new Set([
  "fs.list",
  "fs.read",
  "fs.search",
  "process.read",
  "process.list",
]);
const WORKSPACE_WRITE_TOOLS = new Set(["fs.write", "fs.edit"]);
const FILE_PATH_TOOLS = new Set(["fs.list", "fs.read", "fs.search", "fs.write", "fs.edit"]);
const PROTECTED_ROOT_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);
const PROTECTED_DIRECTORIES = new Set([".git", "node_modules"]);

function denied(code, reason) {
  return {
    action: "deny",
    code,
    reasons: [`${code}: ${reason}`],
    grants: { allowOutside: false },
  };
}

async function validateWorkspaceWrite(name, workspaceRoot, resolvedPath) {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(resolvedPath));
  const segments = relative.split(path.sep).filter(Boolean);
  const normalized = segments.map((segment) => segment.toLowerCase());
  if (normalized.some((segment) => PROTECTED_DIRECTORIES.has(segment))) {
    return denied("AUTONOMOUS_PROTECTED_PATH", "Writes to .git and node_modules are not permitted in unattended mode.");
  }
  if (segments.length === 1 && PROTECTED_ROOT_FILES.has(segments[0].toLowerCase())) {
    return denied("AUTONOMOUS_PROTECTED_PATH", "Package manifests and lockfiles are frozen for trusted verification.");
  }
  if (normalized[0] === "test") {
    if (name === "fs.edit" || segments.length === 1) {
      return denied("AUTONOMOUS_BASELINE_TEST_PROTECTED", "Existing baseline tests cannot be edited during unattended implementation; add a new test file instead.");
    }
    try {
      await fs.lstat(resolvedPath);
      return denied("AUTONOMOUS_BASELINE_TEST_PROTECTED", "Existing baseline test files cannot be overwritten during unattended implementation.");
    } catch (error) {
      if (error.code !== "ENOENT") {
        return denied("AUTONOMOUS_PATH_STATE_UNKNOWN", "The target test path could not be safely inspected.");
      }
    }
  }
  if (
    normalized.length === 2
    && normalized[0] === "scripts"
    && ["run-tests.js", "check-syntax.js"].includes(normalized[1])
  ) {
    return denied("AUTONOMOUS_VERIFIER_PROTECTED", "The verification runner scripts are immutable during unattended implementation.");
  }
  return null;
}

export async function evaluateAutonomousToolPolicy({
  toolCall,
  definition,
  projectRoot,
  resolvePath = resolveToolPath,
}) {
  const name = String(toolCall?.name ?? "");
  if (!definition || definition.name !== name) {
    return denied("AUTONOMOUS_UNKNOWN_TOOL", `Unknown tool is denied in unattended mode: ${name || "(empty)"}.`);
  }

  if (READ_ONLY_TOOLS.has(name)) {
    if (definition.risk !== "read") {
      return denied("AUTONOMOUS_TOOL_RISK_MISMATCH", `Tool ${name} is not registered as read-only.`);
    }
  } else if (WORKSPACE_WRITE_TOOLS.has(name)) {
    if (definition.risk !== "write") {
      return denied("AUTONOMOUS_TOOL_RISK_MISMATCH", `Tool ${name} is not registered as a workspace write.`);
    }
  } else {
    return denied("AUTONOMOUS_TOOL_NOT_ALLOWED", `Tool ${name} is not in the unattended capability set.`);
  }

  if (FILE_PATH_TOOLS.has(name)) {
    if (!projectRoot) {
      return denied("AUTONOMOUS_WORKSPACE_MISSING", "The selected workspace is unavailable.");
    }
    const rawPath = String(toolCall.args?.path ?? ".");
    try {
      const resolved = await resolvePath(projectRoot, rawPath);
      if (!resolved.inside) {
        return denied("AUTONOMOUS_PATH_OUTSIDE_WORKSPACE", `Path is outside the selected workspace: ${resolved.path}`);
      }
      if (WORKSPACE_WRITE_TOOLS.has(name)) {
        const protectedPath = await validateWorkspaceWrite(name, projectRoot, resolved.path);
        if (protectedPath) return protectedPath;
      }
    } catch (error) {
      return denied("AUTONOMOUS_PATH_INVALID", `Workspace path validation failed: ${error.message}`);
    }
  }

  return {
    action: "allow",
    code: "AUTONOMOUS_SAFE_TOOL",
    reasons: [],
    grants: { allowOutside: false },
  };
}
