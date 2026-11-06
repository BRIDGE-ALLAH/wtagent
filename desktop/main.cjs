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
    const parent = await fs.realpath(path.dirname(candidate));
    if (!isInside(root, parent)) throw new Error("Folder tujuan berada di luar workspace.");
    return path.join(parent, path.basename(candidate));
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

async function loadAgentService() {
  const sourceRoot = app.isPackaged ? path.join(process.resourcesPath, "wtagent") : path.resolve(__dirname, "..");
  process.env.WTAGENT_HOME = process.env.WTAGENT_HOME || path.join(app.getPath("userData"), "wtagent");
  const moduleUrl = pathToFileURL(path.join(sourceRoot, "src", "desktop", "agent-service.js")).href;
  const imported = await import(moduleUrl);
  agentService = new imported.DesktopAgentService({ onEvent: (event) => send("agent:event", event) });
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
    if (!agentService) await loadAgentService();
    return { ok: true, result: await agentService.start(args) };
  });
  ipcMain.handle("agent:send", async (_event, instruction) => {
    if (!agentService) throw new Error("Agent belum dimulai.");
    return { ok: true, result: await agentService.send(instruction) };
  });
  ipcMain.handle("agent:approval", async (_event, args) => agentService?.respondApproval(args.requestId, args.choice) ?? false);
  ipcMain.handle("agent:continue-provider", async () => {
    agentService?.continueProviderSelection();
    return true;
  });
  ipcMain.handle("agent:cancel", async () => agentService?.cancel() ?? false);

  ipcMain.handle("terminal:run", async (_event, { workspace, command }) => {
    const cwd = await fs.realpath(String(workspace ?? activeWorkspace ?? ""));
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error("Workspace terminal tidak valid.");
    const text = String(command ?? "").trim();
    if (!text) throw new Error("Perintah terminal kosong.");
    const id = String(Date.now()) + "-" + Math.random().toString(16).slice(2, 8);
    const child = spawn(text, {
      cwd, shell: true, windowsHide: true,
      env: { ...process.env, WTAGENT_HOME: process.env.WTAGENT_HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const job = { child, outputBytes: 0 };
    terminalJobs.set(id, job);
    send("terminal:event", { id, type: "started", command: text, cwd });
    const writeOutput = (stream, chunk) => {
      if (!terminalJobs.has(id)) return;
      const value = String(chunk ?? "");
      job.outputBytes += Buffer.byteLength(value, "utf8");
      if (job.outputBytes > MAX_TERMINAL_OUTPUT) {
        send("terminal:event", { id, type: "data", stream, data: "\n[output truncated]\n" });
        child.kill();
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
    return { id };
  });
  ipcMain.handle("terminal:cancel", async (_event, id) => {
    const job = terminalJobs.get(id);
    if (!job) return false;
    job.child.kill();
    return true;
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
