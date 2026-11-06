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
  sendAgent: (instruction) => ipcRenderer.invoke("agent:send", instruction),
  respondApproval: (requestId, choice) => ipcRenderer.invoke("agent:approval", { requestId, choice }),
  continueProviderSelection: () => ipcRenderer.invoke("agent:continue-provider"),
  cancelAgent: () => ipcRenderer.invoke("agent:cancel"),
  runCommand: (workspace, command) => ipcRenderer.invoke("terminal:run", { workspace, command }),
  cancelCommand: (id) => ipcRenderer.invoke("terminal:cancel", id),
  onAgentEvent: (callback) => subscribe("agent:event", callback),
  onTerminalEvent: (callback) => subscribe("terminal:event", callback),
});
