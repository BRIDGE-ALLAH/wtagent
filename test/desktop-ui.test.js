import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFile(path.join(root, relative), "utf8");

test("desktop renderer DOM selectors exist in the HTML or are created dynamically", async () => {
  const [renderer, html] = await Promise.all([
    read("desktop/renderer.js"),
    read("desktop/index.html"),
  ]);
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const dynamicIds = new Set(["editor-host"]);
  const selectors = new Set([...renderer.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map((match) => match[1]));
  const missing = [...selectors].filter((id) => !htmlIds.has(id) && !dynamicIds.has(id));
  assert.deepEqual(missing, []);
});

test("renderer APIs are exposed by the isolated preload bridge", async () => {
  const [renderer, preload] = await Promise.all([
    read("desktop/renderer.js"),
    read("desktop/preload.cjs"),
  ]);
  const methods = new Set([...renderer.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]));
  const missing = [...methods].filter((method) => !new RegExp("\\b" + method + "\\s*:").test(preload));
  assert.deepEqual(missing, []);
});

test("every preload IPC invocation has a registered main-process handler", async () => {
  const [preload, main] = await Promise.all([
    read("desktop/preload.cjs"),
    read("desktop/main.cjs"),
  ]);
  const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((match) => match[1]));
  const handled = new Set([...main.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...invoked].filter((channel) => !handled.has(channel)), []);
});

test("desktop workflows include safe plan-only enforcement and real session recovery", async () => {
  const [service, renderer, html] = await Promise.all([
    read("src/desktop/agent-service.js"),
    read("desktop/renderer.js"),
    read("desktop/index.html"),
  ]);
  assert.match(service, /shouldEnforceReadOnlyPolicy/);
  assert.match(service, /definition\.risk !== "read"/);
  assert.match(service, /approveAutonomousPlan/);
  assert.match(service, /rejectAutonomousPlan/);
  assert.match(service, /action: "deny"/);
  assert.match(service, /AgentSession\.load/);
  assert.match(service, /async listSessions/);
  assert.match(service, /resume: true/);
  assert.match(renderer, /WORKFLOW: PLAN ONLY/);
  assert.match(renderer, /WORKFLOW: PLAN, IMPLEMENT, AND VERIFY/);
  assert.match(renderer, /showAutonomousPlan/);
  assert.match(renderer, /showWorkspaceRollback/);
  assert.match(service, /WorkspaceCheckpoint\.create/);
  assert.match(service, /WorkspaceCheckpoint\.finalize/);
  assert.match(service, /WorkspaceCheckpoint\.rollback/);
  assert.match(html, /value="autonomous"/);
});

test("Git, provider profiles, and persistent terminal are connected end to end", async () => {
  const [main, preload, renderer, html] = await Promise.all([
    read("desktop/main.cjs"),
    read("desktop/preload.cjs"),
    read("desktop/renderer.js"),
    read("desktop/index.html"),
  ]);
  for (const channel of [
    "terminal:start", "terminal:write", "terminal:stop",
    "git:status", "git:diff", "git:stage", "git:stage-all", "git:commit", "git:checkout",
    "provider:profiles", "provider:open-profile", "agent:rollback-workspace", "agent:accept-verification",
    "agent:sessions", "agent:resume", "agent:approve-plan", "agent:reject-plan",
  ]) {
    assert.match(main, new RegExp('ipcMain\\.handle\\("' + channel + '"'));
    assert.match(preload, new RegExp('ipcRenderer\\.invoke\\("' + channel + '"'));
  }
  assert.match(renderer, /api\.startTerminal/);
  assert.match(renderer, /api\.gitStatus/);
  assert.match(renderer, /api\.providerProfiles/);
  assert.match(html, /id="sessions-modal"/);
  assert.match(html, /id="models-modal"/);
  assert.match(html, /id="git-panel"/);
});


test("autonomous implementation cannot be reported complete without a verification gate", async () => {
  const [service, renderer, workflow] = await Promise.all([
    read("src/desktop/agent-service.js"),
    read("desktop/renderer.js"),
    read("src/desktop/autonomous-workflow.js"),
  ]);
  assert.match(service, /requireAutonomousVerification/);
  assert.match(service, /autonomous\.verification_required/);
  assert.doesNotMatch(service, /this\.autonomousWorkflow\s*=\s*\{[\s\S]{0,120}phase:\s*"completed"/);
  assert.match(service, /"verification_required"/);
  assert.match(renderer, /desktop\.autonomous_verification_required/);
  assert.match(renderer, /api\.acceptAutonomousVerification/);
  assert.match(service, /autonomous\.user_accepted/);
  assert.match(renderer, /belum dinyatakan selesai/);
  assert.match(workflow, /phase: "verification_required"/);
  assert.match(workflow, /completedAt: null/);
});

 
test("pending verification cannot be bypassed by sending a new autonomous task", async () => {
  const service = await read("src/desktop/agent-service.js");
  assert.match(service, /autonomousWorkflow\?\.phase === "verification_required" && text/);
  assert.match(service, /Periksa dan terima hasil autonomous yang tertunda/);
});
