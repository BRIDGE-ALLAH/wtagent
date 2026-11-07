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

function denied(code, reason) {
  return {
    action: "deny",
    code,
    reasons: [reason],
    grants: { allowOutside: false },
  };
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
