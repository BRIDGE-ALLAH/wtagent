const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { createReadStream } = require("node:fs");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

let mainWindow = null;
let staticServer = null;
let agentService = null;
let activeWorkspace = null;
const terminalJobs = new Map();

const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".wtagent"]);
const MAX_EDITOR_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TERMINAL_OUTPUT = 800_000;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveWorkspaceFile(workspace, relativePath, allowMissing = false) {
  const root = await fs.realpath(workspace);
  const candidate = path.resolve(root, String(relativePath ?? ""));
  if (!isInside(root, candidate) || candidate === root) throw new Error("Path file harus berada di dalam workspace.");
  try {
    const realCandidate = await fs.realpath(candidate);
    if (!isInside(root, realCandidate)) throw new Error("Symlink di luar workspace tidak diizinkan.");
    return realCandidate;
  } catch (error) {
    if (!allowMissing || error.code !== "ENOENT") throw error;
    // Resolve the nearest existing ancestor so nested new-file paths work,
    // while still rejecting a symlinked ancestor that escapes the workspace.
    let ancestor = path.dirname(candidate);
    for (;;) {
      try {
        const realAncestor = await fs.realpath(ancestor);
        if (!isInside(root, realAncestor)) {
          throw new Error("Folder tujuan berada di luar workspace.");
        }
        const relativeTail = path.relative(ancestor, path.dirname(candidate));
        return path.join(realAncestor, relativeTail, path.basename(candidate));
      } catch (ancestorError) {
        if (ancestorError.code !== "ENOENT") throw ancestorError;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw ancestorError;
        ancestor = parent;
      }
    }
  }
}

async function buildFileList(workspace) {
  const root = await fs.realpath(workspace);
  const entries = [];
  const maxEntries = 5000;
  async function walk(directory, depth) {
    if (entries.length >= maxEntries || depth > 10) return;
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of children) {
      if (entries.length >= maxEntries) break;
      if (IGNORED_DIRS.has(child.name) || child.isSymbolicLink()) continue;
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const isDirectory = child.isDirectory();
      entries.push({ path: relative, type: isDirectory ? "directory" : "file" });
      if (isDirectory) await walk(absolute, depth + 1);
    }
  }
  await walk(root, 0);
  return entries;
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".woff": "font/woff", ".woff2": "font/woff2",
    ".ttf": "font/ttf", ".eot": "application/vnd.ms-fontobject",
  })[ext] ?? "application/octet-stream";
}

function safeStaticPath(base, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const target = path.resolve(base, "." + (decoded.startsWith("/") ? decoded : "/" + decoded));
  return isInside(path.resolve(base), target) ? target : null;
}

async function startStaticServer() {
  if (staticServer?.listening) return staticServer.address().port;
  const desktopRoot = __dirname;
  const monacoRoot = path.join(desktopRoot, "node_modules", "monaco-editor", "min");
  staticServer = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
      let target = null;
      if (pathname.startsWith("/monaco/")) {
        target = safeStaticPath(monacoRoot, pathname.slice("/monaco".length));
      } else if (["/index.html", "/renderer.js", "/styles.css"].includes(pathname)) {
        target = safeStaticPath(desktopRoot, pathname);
      }
      if (!target) {
        res.writeHead(404); res.end("Not found"); return;
      }
      const stat = await fs.stat(target);
      if (!stat.isFile()) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, {
        "Content-Type": mimeType(target), "Content-Length": stat.size,
        "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache",
      });
      createReadStream(target).pipe(res);
    } catch {
      res.writeHead(400); res.end("Bad request");
    }
  });
  await new Promise((resolve, reject) => {
    staticServer.once("error", reject);
    staticServer.listen(0, "127.0.0.1", resolve);
  });
  return staticServer.address().port;
}

async function loadAgentService({ replaceExisting = false } = {}) {
  if (agentService && !replaceExisting) return agentService;
  if (agentService) await agentService.close().catch(() => {});
  const sourceRoot = app.isPackaged ? path.join(process.resourcesPath, "wtagent") : path.resolve(__dirname, "..");
  process.env.WTAGENT_HOME = process.env.WTAGENT_HOME || path.join(app.getPath("userData"), "wtagent");
  const moduleUrl = pathToFileURL(path.join(sourceRoot, "src", "desktop", "agent-service.js")).href;
  const imported = await import(moduleUrl);
  agentService = new imported.DesktopAgentService({ onEvent: (event) => send("agent:event", event) });
  return agentService;
}

async function workspaceRoot(workspace) {
  const root = await fs.realpath(String(workspace ?? activeWorkspace ?? ""));
  if (!(await fs.stat(root)).isDirectory()) throw new Error("Workspace tidak valid.");
  return root;
}

function runGit(cwd, args, { allowExitCodes = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", WTAGENT_HOME: process.env.WTAGENT_HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { if (stdout.length < 1_500_000) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 300_000) stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 || allowExitCodes.includes(code)) resolve({ stdout, stderr, code });
      else reject(new Error((stderr || stdout || "Perintah Git gagal.").trim()));
    });
  });
}

function validateGitPath(filePath) {
  const value = String(filePath ?? "").replaceAll("\\", "/");
  if (!value || value.startsWith("/") || /^[a-zA-Z]:/.test(value)
      || value.split("/").some((part) => part === "..") || value.includes("\0")) {
    throw new Error("Path Git harus relatif dan berada di dalam workspace.");
  }
  return value;
}

function safeBranchName(value) {
  const name = String(value ?? "").trim();
  if (!name || name.length > 120 || name.startsWith("-") || !/^[a-zA-Z0-9._/-]+$/.test(name)
      || name.includes("..") || name.endsWith("/") || name.endsWith(".lock")) {
    throw new Error("Nama branch tidak valid.");
  }
  return name;
}

function registerIpc() {
  ipcMain.handle("workspace:pick", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Pilih folder proyek", properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    activeWorkspace = await fs.realpath(result.filePaths[0]);
    return { path: activeWorkspace, name: path.basename(activeWorkspace) };
  });

  ipcMain.handle("workspace:validate", async (_event, workspace) => {
    const real = await fs.realpath(String(workspace ?? ""));
    if (!(await fs.stat(real)).isDirectory()) throw new Error("Workspace bukan sebuah folder.");
    activeWorkspace = real;
    return { path: real, name: path.basename(real) };
  });

  ipcMain.handle("workspace:list", async (_event, workspace) => {
    const root = await fs.realpath(String(workspace ?? activeWorkspace ?? ""));
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Workspace tidak valid.");
    return await buildFileList(root);
  });

  ipcMain.handle("workspace:read", async (_event, { workspace, filePath }) => {
    const target = await resolveWorkspaceFile(workspace ?? activeWorkspace, filePath);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("Path bukan file.");
    if (stat.size > MAX_EDITOR_FILE_BYTES) throw new Error("File terlalu besar untuk dibuka (maksimal 2 MB).");
    const content = await fs.readFile(target, "utf8");
    if (content.includes("\u0000")) throw new Error("File biner tidak dapat dibuka sebagai teks.");
    return { path: filePath, content };
  });

  ipcMain.handle("workspace:write", async (_event, { workspace, filePath, content }) => {
    const target = await resolveWorkspaceFile(workspace ?? activeWorkspace, filePath);
    const data = String(content ?? "");
    if (Buffer.byteLength(data, "utf8") > MAX_EDITOR_FILE_BYTES) throw new Error("File terlalu besar untuk disimpan (maksimal 2 MB).");
    await fs.writeFile(target, data, "utf8");
    return { saved: true, path: filePath };
  });

  ipcMain.handle("workspace:create", async (_event, { workspace, filePath }) => {
    const target = await resolveWorkspaceFile(workspace ?? activeWorkspace, filePath, true);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "", { flag: "wx" });
    return { created: true, path: filePath };
  });

  ipcMain.handle("workspace:reveal", async (_event, { workspace, filePath }) => {
    const target = await resolveWorkspaceFile(workspace ?? activeWorkspace, filePath);
    shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle("agent:start", async (_event, args) => {
    if (agentService?.running) throw new Error("Agent masih memproses tugas. Batalkan atau tunggu sampai selesai.");
    await loadAgentService({ replaceExisting: Boolean(agentService?.session) });
    return { ok: true, result: await agentService.start(args) };
  });
  ipcMain.handle("agent:resume", async (_event, args) => {
    if (agentService?.running) throw new Error("Agent masih memproses tugas.");
    await loadAgentService({ replaceExisting: Boolean(agentService) });
    return { ok: true, result: await agentService.resume(args) };
  });
  ipcMain.handle("agent:sessions", async () => {
    await loadAgentService();
    return await agentService.listSessions(40);
  });
  ipcMain.handle("agent:reset", async () => {
    await agentService?.close().catch(() => {});
    agentService = null;
    return true;
  });
  ipcMain.handle("agent:send", async (_event, { instruction, workflowMode = "agent" }) => {
    if (!agentService) throw new Error("Agent belum dimulai.");
    return { ok: true, result: await agentService.send(instruction, workflowMode) };
  });
  ipcMain.handle("agent:approval", async (_event, args) => agentService?.respondApproval(args.requestId, args.choice) ?? false);
  ipcMain.handle("agent:approve-plan", async () => {
    if (!agentService) throw new Error("Agent belum dimulai.");
    return { ok: true, result: await agentService.approveAutonomousPlan() };
  });
  ipcMain.handle("agent:reject-plan", async () => agentService?.rejectAutonomousPlan() ?? false);
  ipcMain.handle("agent:accept-verification", async (_event, summary) => {
    if (!agentService) throw new Error("Agent belum dimulai.");
    return await agentService.acceptAutonomousVerification(summary);
  });
  ipcMain.handle("agent:rollback-workspace", async () => { if(!agentService)throw Error("Agent belum dimulai."); return await agentService.rollbackWorkspaceCheckpoint(); });
  ipcMain.handle("agent:continue-provider", async () => {
    agentService?.continueProviderSelection();
    return true;
  });
  ipcMain.handle("agent:cancel", async () => agentService?.cancel() ?? false);

  ipcMain.handle("terminal:start", async (_event, { workspace, shell: shellChoice = "default" }) => {
    if (process.platform !== "win32" && ["cmd", "powershell"].includes(shellChoice)) {
      throw new Error("CMD dan PowerShell hanya tersedia pada Windows. Pilih Default shell atau Bash.");
    }
    const cwd = await workspaceRoot(workspace);
    const id = String(Date.now()) + "-" + Math.random().toString(16).slice(2, 8);
    let command;
    let args;
    if (process.platform === "win32") {
      if (shellChoice === "powershell") { command = "powershell.exe"; args = ["-NoLogo", "-NoProfile", "-NoExit"]; }
      else if (shellChoice === "bash") { command = "bash"; args = ["--noprofile", "--norc", "-i"]; }
      else { command = process.env.COMSPEC || "cmd.exe"; args = ["/Q"]; }
    } else if (shellChoice === "bash" || shellChoice === "default") {
      command = process.env.SHELL || "bash";
      args = ["--noprofile", "--norc", "-i"];
    } else {
      command = "bash";
      args = ["--noprofile", "--norc", "-i"];
    }
    const child = spawn(command, args, {
      cwd, windowsHide: true,
      env: { ...process.env, WTAGENT_HOME: process.env.WTAGENT_HOME, TERM: "xterm-256color" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const terminal = { child, cwd, outputBytes: 0, truncated: false };
    terminalJobs.set(id, terminal);
    send("terminal:event", { id, type: "started", shell: shellChoice, cwd });
    const writeOutput = (stream, chunk) => {
      if (!terminalJobs.has(id)) return;
      const value = String(chunk ?? "");
      terminal.outputBytes += Buffer.byteLength(value, "utf8");
      if (terminal.outputBytes > MAX_TERMINAL_OUTPUT) {
        if (!terminal.truncated) send("terminal:event", { id, type: "data", stream: "stderr", data: "\n[output truncated; terminal tetap berjalan]\n" });
        terminal.truncated = true;
        return;
      }
      send("terminal:event", { id, type: "data", stream, data: value });
    };
    child.stdout.on("data", (chunk) => writeOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => writeOutput("stderr", chunk));
    child.once("error", (error) => send("terminal:event", { id, type: "error", message: error.message }));
    child.once("close", (code, signal) => {
      terminalJobs.delete(id);
      send("terminal:event", { id, type: "exit", code, signal });
    });
    return { id, pid: child.pid };
  });
  ipcMain.handle("terminal:write", async (_event, { id, input }) => {
    const terminal = terminalJobs.get(String(id));
    if (!terminal || terminal.child.killed || !terminal.child.stdin.writable) throw new Error("Sesi terminal tidak aktif.");
    terminal.child.stdin.write(String(input ?? ""));
    return true;
  });
  ipcMain.handle("terminal:stop", async (_event, id) => {
    const terminal = terminalJobs.get(String(id));
    if (!terminal) return false;
    terminal.child.kill();
    return true;
  });

  ipcMain.handle("git:status", async (_event, workspace) => {
    const cwd = await workspaceRoot(workspace);
    try {
      const [statusResult, branchResult, branchesResult] = await Promise.all([
        runGit(cwd, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"]),
        runGit(cwd, ["branch", "--show-current"]),
        runGit(cwd, ["branch", "--format=%(refname:short)"]),
      ]);
      const lines = statusResult.stdout.split(/\r?\n/).filter(Boolean);
      const changes = lines.filter((line) => !line.startsWith("##")).map((line) => ({
        status: line.slice(0, 2),
        path: line.slice(3),
        staged: line[0] !== " " && line[0] !== "?",
        untracked: line.startsWith("??"),
      }));
      return { isRepo: true, branch: branchResult.stdout.trim() || "(detached HEAD)", branches: branchesResult.stdout.split(/\r?\n/).filter(Boolean), changes };
    } catch (error) {
      return { isRepo: false, branch: "", branches: [], changes: [], error: error.message };
    }
  });
  ipcMain.handle("git:diff", async (_event, { workspace, filePath }) => {
    const cwd = await workspaceRoot(workspace);
    const relative = validateGitPath(filePath);
    const [working, staged] = await Promise.all([
      runGit(cwd, ["diff", "--no-ext-diff", "--", relative]),
      runGit(cwd, ["diff", "--cached", "--no-ext-diff", "--", relative]),
    ]);
    let diff = [staged.stdout.trim(), working.stdout.trim()].filter(Boolean).join("\n\n");
    if (!diff) {
      const untracked = await runGit(cwd, ["diff", "--no-index", "--no-ext-diff", "--", process.platform === "win32" ? "NUL" : "/dev/null", relative], { allowExitCodes: [1] });
      diff = untracked.stdout;
    }
    return { path: relative, diff: diff || "Tidak ada diff untuk file ini." };
  });
  ipcMain.handle("git:stage", async (_event, { workspace, filePath, staged = true }) => {
    const cwd = await workspaceRoot(workspace);
    const relative = validateGitPath(filePath);
    if (staged) await runGit(cwd, ["add", "--", relative]);
    else await runGit(cwd, ["restore", "--staged", "--", relative]);
    return true;
  });
  ipcMain.handle("git:stage-all", async (_event, workspace) => {
    const cwd = await workspaceRoot(workspace);
    await runGit(cwd, ["add", "-A"]);
    return true;
  });
  ipcMain.handle("git:commit", async (_event, { workspace, message }) => {
    const cwd = await workspaceRoot(workspace);
    const text = String(message ?? "").trim();
    if (!text) throw new Error("Pesan commit tidak boleh kosong.");
    if (text.length > 500) throw new Error("Pesan commit terlalu panjang.");
    return await runGit(cwd, ["commit", "-m", text]);
  });
  ipcMain.handle("git:checkout", async (_event, { workspace, branch, create = false }) => {
    const cwd = await workspaceRoot(workspace);
    const name = safeBranchName(branch);
    await runGit(cwd, create ? ["switch", "-c", name] : ["switch", name]);
    return true;
  });

  ipcMain.handle("provider:profiles", async () => {
    const sourceRoot = app.isPackaged ? path.join(process.resourcesPath, "wtagent") : path.resolve(__dirname, "..");
    const moduleUrl = pathToFileURL(path.join(sourceRoot, "src", "browser", "provider-registry.js")).href;
    const { PROVIDERS, getProviderProfileDir } = await import(moduleUrl);
    const appDataDir = path.resolve(process.env.WTAGENT_HOME || path.join(app.getPath("userData"), "wtagent"));
    const profiles = await Promise.all(Object.values(PROVIDERS).map(async (provider) => {
      const directory = getProviderProfileDir(appDataDir, provider.id);
      const exists = await fs.stat(directory).then((stat) => stat.isDirectory()).catch(() => false);
      return { id: provider.id, label: provider.label, url: provider.baseUrl, directory, exists };
    }));
    return profiles;
  });
  ipcMain.handle("provider:open-profile", async (_event, providerId) => {
    const sourceRoot = app.isPackaged ? path.join(process.resourcesPath, "wtagent") : path.resolve(__dirname, "..");
    const moduleUrl = pathToFileURL(path.join(sourceRoot, "src", "browser", "provider-registry.js")).href;
    const { getProviderProfileDir } = await import(moduleUrl);
    const directory = getProviderProfileDir(path.resolve(process.env.WTAGENT_HOME || path.join(app.getPath("userData"), "wtagent")), providerId);
    await fs.mkdir(directory, { recursive: true });
    return await shell.openPath(directory);
  });
}

async function createWindow() {
  const port = await startStaticServer();
  mainWindow = new BrowserWindow({
    width: 1600, height: 980, minWidth: 1120, minHeight: 700,
    backgroundColor: "#111318", title: "WTAgent Studio", autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  await mainWindow.loadURL("http://127.0.0.1:" + port + "/index.html");
  if (process.env.WTAGENT_DESKTOP_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
}).catch((error) => {
  dialog.showErrorBox("WTAgent Studio gagal dibuka", error.stack || error.message);
  app.quit();
});

app.on("before-quit", () => {
  agentService?.close().catch(() => {});
  for (const job of terminalJobs.values()) job.child.kill();
  staticServer?.close();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
