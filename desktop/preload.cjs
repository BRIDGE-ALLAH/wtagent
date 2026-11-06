const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("wtagent", {
  pickWorkspace: () => ipcRenderer.invoke("workspace:pick"),
  validateWorkspace: (workspace) => ipcRenderer.invoke("workspace:validate", workspace),
  listFiles: (workspace) => ipcRenderer.invoke("workspace:list", workspace),
  readFile: (workspace, filePath) => ipcRenderer.invoke("workspace:read", { workspace, filePath }),
  writeFile: (workspace, filePath, content) => ipcRenderer.invoke("workspace:write", { workspace, filePath, content }),
  createFile: (workspace, filePath) => ipcRenderer.invoke("workspace:create", { workspace, filePath }),
  revealFile: (workspace, filePath) => ipcRenderer.invoke("workspace:reveal", { workspace, filePath }),
  startAgent: (options) => ipcRenderer.invoke("agent:start", options),
  resumeAgent: (options) => ipcRenderer.invoke("agent:resume", options),
  listSessions: () => ipcRenderer.invoke("agent:sessions"),
  resetAgent: () => ipcRenderer.invoke("agent:reset"),
  sendAgent: (instruction, workflowMode) => ipcRenderer.invoke("agent:send", { instruction, workflowMode }),
  respondApproval: (requestId, choice) => ipcRenderer.invoke("agent:approval", { requestId, choice }),
  continueProviderSelection: () => ipcRenderer.invoke("agent:continue-provider"),
  cancelAgent: () => ipcRenderer.invoke("agent:cancel"),
  startTerminal: (workspace, shell) => ipcRenderer.invoke("terminal:start", { workspace, shell }),
  writeTerminal: (id, input) => ipcRenderer.invoke("terminal:write", { id, input }),
  stopTerminal: (id) => ipcRenderer.invoke("terminal:stop", id),
  gitStatus: (workspace) => ipcRenderer.invoke("git:status", workspace),
  gitDiff: (workspace, filePath) => ipcRenderer.invoke("git:diff", { workspace, filePath }),
  gitStage: (workspace, filePath, staged = true) => ipcRenderer.invoke("git:stage", { workspace, filePath, staged }),
  gitStageAll: (workspace) => ipcRenderer.invoke("git:stage-all", workspace),
  gitCommit: (workspace, message) => ipcRenderer.invoke("git:commit", { workspace, message }),
  gitCheckout: (workspace, branch, create = false) => ipcRenderer.invoke("git:checkout", { workspace, branch, create }),
  providerProfiles: () => ipcRenderer.invoke("provider:profiles"),
  openProviderProfile: (providerId) => ipcRenderer.invoke("provider:open-profile", providerId),
  onAgentEvent: (callback) => subscribe("agent:event", callback),
  onTerminalEvent: (callback) => subscribe("terminal:event", callback),
});
