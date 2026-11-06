const api = window.wtagent;
const $ = (selector) => document.querySelector(selector);

let workspace = localStorage.getItem("wtagent.workspace") || "";
let files = [];
let collapsed = new Set();
let editor = null;
let activeFile = "";
let savedContent = "";
let agentStarted = false;
let agentBusy = false;
let currentTerminalJob = null;
let currentSessionId = "";
let chatHistory = [];
let restoringChat = false;
let terminalHistory = [];
let terminalHistoryIndex = -1;
let gitState = { isRepo: false, branch: "", branches: [], changes: [] };
const monacoReadyPromise = window.monaco
  ? Promise.resolve()
  : new Promise((resolve) => window.addEventListener("monaco-ready", resolve, { once: true }));

function setSaveStatus(text) {
  $("#save-indicator").textContent = text;
}

function setAgentStatus(text, mode = "ready") {
  const node = $("#agent-status");
  node.className = "agent-status" + (mode === "busy" ? " busy" : mode === "error" ? " error" : "");
  node.innerHTML = '<span class="status-dot"></span>';
  node.append(document.createTextNode(" " + text));
  agentBusy = mode === "busy";
  $("#cancel-agent").disabled = !agentBusy;
  $("#send-agent").disabled = agentBusy;
}

function persistChat() {
  if (!currentSessionId || restoringChat) return;
  try {
    localStorage.setItem("wtagent.chat." + currentSessionId, JSON.stringify(chatHistory.slice(-160)));
  } catch {}
}

function recordChat(item) {
  if (restoringChat) return;
  chatHistory.push(item);
  if (chatHistory.length > 160) chatHistory = chatHistory.slice(-160);
  persistChat();
}

function restoreChat(sessionId, fallbackTask = "") {
  restoringChat = true;
  currentSessionId = sessionId;
  chatHistory = [];
  $("#chat-feed").replaceChildren();
  try {
    const stored = JSON.parse(localStorage.getItem("wtagent.chat." + sessionId) || "[]");
    if (Array.isArray(stored)) {
      chatHistory = stored.slice(-160);
      for (const item of chatHistory) {
        if (item.type === "message") renderStoredMessage(item);
        else if (item.type === "activity") renderStoredActivity(item);
      }
    }
  } catch {
    chatHistory = [];
  }
  restoringChat = false;
  if (!chatHistory.length) {
    appendMessage("system", fallbackTask ? "Melanjutkan: " + fallbackTask : "Sesi dipulihkan. Riwayat tampilan lokal sebelumnya tidak tersedia, tetapi konteks percakapan tetap berada di akun provider.");
  }
}

function renderStoredMessage(item) {
  const intro = $(".agent-intro");
  if (intro) intro.remove();
  const node = document.createElement("div");
  node.className = "message " + item.role + (item.kind ? " " + item.kind : "");
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = item.role === "user" ? "You" : item.role === "assistant" ? "WTAgent" : "System";
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = String(item.text ?? "");
  node.append(label, body);
  $("#chat-feed").append(node);
}

function renderStoredActivity(item) {
  const card = document.createElement("div");
  card.className = "activity-card";
  const heading = document.createElement("div");
  heading.className = "activity-title";
  heading.textContent = "◈ " + item.title;
  card.append(heading);
  if (item.detail) {
    const content = document.createElement("div");
    content.className = "activity-detail";
    content.textContent = item.detail;
    card.append(content);
  }
  $("#chat-feed").append(card);
}

function appendMessage(role, text, kind = "") {
  const intro = $(".agent-intro");
  if (intro) intro.remove();
  const item = document.createElement("div");
  item.className = "message " + role + (kind ? " " + kind : "");
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? "You" : role === "assistant" ? "WTAgent" : "System";
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = String(text ?? "");
  item.append(label, body);
  $("#chat-feed").append(item);
  $("#chat-feed").scrollTop = $("#chat-feed").scrollHeight;
  recordChat({ type: "message", role, text: String(text ?? ""), kind });
  return item;
}

function appendActivity(title, detail = "") {
  const card = document.createElement("div");
  card.className = "activity-card";
  const heading = document.createElement("div");
  heading.className = "activity-title";
  heading.textContent = "◈ " + title;
  card.append(heading);
  if (detail) {
    const content = document.createElement("div");
    content.className = "activity-detail";
    content.textContent = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
    card.append(content);
  }
  $("#chat-feed").append(card);
  while ($("#chat-feed").children.length > 80) $("#chat-feed").firstElementChild.remove();
  $("#chat-feed").scrollTop = $("#chat-feed").scrollHeight;
  recordChat({ type: "activity", title, detail: typeof detail === "string" ? detail : JSON.stringify(detail, null, 2) });
  return card;
}

function showProviderSelection(payload) {
  const card = document.createElement("div");
  card.className = "provider-card";
  const title = document.createElement("strong");
  title.textContent = "Pilih model di " + (payload.provider || "browser");
  const desc = document.createElement("p");
  desc.textContent = payload.message || "Pilih model AI pada jendela browser, lalu lanjutkan.";
  const button = document.createElement("button");
  button.className = "button primary";
  button.textContent = "Lanjutkan";
  button.addEventListener("click", async () => {
    button.disabled = true;
    await api.continueProviderSelection();
    card.remove();
    appendActivity("Model dipilih", "WTAgent melanjutkan tugas.");
  });
  card.append(title, desc, button);
  $("#chat-feed").append(card);
  $("#chat-feed").scrollTop = $("#chat-feed").scrollHeight;
}

function showApproval(payload) {
  const card = document.createElement("div");
  card.className = "approval-card";
  const title = document.createElement("div");
  title.className = "approval-title";
  title.textContent = "Persetujuan diperlukan · " + (payload.toolCall?.name || "tool");
  const reason = document.createElement("div");
  reason.className = "approval-reason";
  reason.textContent = (payload.reasons || []).join(" · ") || "Agent meminta izin untuk melanjutkan.";
  const detail = document.createElement("pre");
  detail.className = "approval-code";
  detail.textContent = JSON.stringify(payload.toolCall?.args || {}, null, 2);
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const choices = [
    ["allow", "Izinkan sekali", "once"],
    ["", "Selalu izinkan tool ini", "always-tool"],
    ["", "Izinkan semua tool", "always-all"],
    ["", "Tolak", "deny"]
  ];
  for (const [className, label, value] of choices) {
    const button = document.createElement("button");
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", async () => {
      for (const item of actions.querySelectorAll("button")) item.disabled = true;
      await api.respondApproval(payload.requestId, value);
      card.remove();
      appendActivity("Persetujuan diberikan", value === "deny" ? "Aksi ditolak." : "Pilihan: " + label);
    });
    actions.append(button);
  }
  card.append(title, reason, detail, actions);
  $("#chat-feed").append(card);
  $("#chat-feed").scrollTop = $("#chat-feed").scrollHeight;
}

function getLanguage(filePath) {
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  const names = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", json: "json", html: "html", htm: "html",
    css: "css", scss: "scss", less: "less", md: "markdown", py: "python",
    sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml", xml: "xml",
    sql: "sql", java: "java", c: "c", h: "c", cpp: "cpp", cs: "csharp",
    go: "go", rs: "rust", php: "php", rb: "ruby", toml: "ini",
    ini: "ini", txt: "plaintext", env: "ini"
  };
  return names[ext] || "plaintext";
}

function initEditor() {
  if (editor || !window.monaco) return;
  const host = document.createElement("div");
  host.id = "editor-host";
  host.style.display = "none";
  $("#editor").append(host);
  editor = monaco.editor.create(host, {
    value: "",
    language: "plaintext",
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 13,
    lineHeight: 21,
    fontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace",
    minimap: { enabled: true, scale: 0.8 },
    scrollBeyondLastLine: false,
    roundedSelection: false,
    renderLineHighlight: "all",
    padding: { top: 12, bottom: 12 },
    bracketPairColorization: { enabled: true },
    guides: { indentation: true }
  });
  editor.onDidChangeModelContent(() => {
    const dirty = editor.getValue() !== savedContent;
    setSaveStatus(dirty ? "● Unsaved" : "Saved");
    $("#active-tab").textContent = (dirty ? "● " : "") + activeFile.split("/").pop();
  });
}

function renderFiles() {
  const tree = $("#file-tree");
  tree.replaceChildren();
  if (!workspace) {
    const empty = document.createElement("div");
    empty.className = "empty-tree";
    empty.textContent = "Buka folder untuk mulai bekerja.";
    tree.append(empty);
    return;
  }
  const visible = files.filter((entry) => {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (collapsed.has(parts.slice(0, i).join("/"))) return false;
    }
    return true;
  });
  for (const entry of visible) {
    const depth = entry.path.split("/").length - 1;
    const name = entry.path.split("/").pop();
    const row = document.createElement("button");
    row.className = "file-row " + (entry.type === "directory" ? "dir" : "file") + (entry.path === activeFile ? " active" : "");
    row.style.paddingLeft = (6 + depth * 13) + "px";
    row.title = entry.path;
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = entry.type === "directory" ? (collapsed.has(entry.path) ? "›" : "⌄") : fileIcon(name);
    const label = document.createElement("span");
    label.className = "file-label";
    label.textContent = name;
    row.append(icon, label);
    row.addEventListener("click", () => {
      if (entry.type === "directory") {
        if (collapsed.has(entry.path)) collapsed.delete(entry.path);
        else collapsed.add(entry.path);
        renderFiles();
      } else {
        openFile(entry.path);
      }
    });
    tree.append(row);
  }
}

function fileIcon(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["js","mjs","cjs","ts","tsx","jsx"].includes(ext)) return "◆";
  if (["json"].includes(ext)) return "{}";
  if (["md","txt"].includes(ext)) return "≡";
  if (["html","htm","xml"].includes(ext)) return "⌘";
  if (["css","scss"].includes(ext)) return "#";
  return "·";
}

async function refreshFiles() {
  if (!workspace) return;
  try {
    files = await api.listFiles(workspace);
    renderFiles();
  } catch (error) {
    appendMessage("system", error.message, "error");
  }
}

async function openFile(filePath) {
  if (!workspace) return;
  await monacoReadyPromise;
  if (editor && activeFile && editor.getValue() !== savedContent) {
    const shouldSave = confirm("Ada perubahan yang belum disimpan. Simpan sekarang?");
    if (shouldSave) {
      await saveFile();
      if (editor.getValue() !== savedContent) return;
    } else if (!confirm("Buang perubahan yang belum disimpan?")) {
      return;
    }
  }
  try {
    const result = await api.readFile(workspace, filePath);
    initEditor();
    $(".welcome")?.remove();
    $("#editor-host").style.display = "block";
    activeFile = filePath;
    savedContent = result.content;
    editor.setValue(result.content);
    monaco.editor.setModelLanguage(editor.getModel(), getLanguage(filePath));
    $("#active-tab").textContent = filePath.split("/").pop();
    $("#active-tab").classList.remove("empty-tab");
    $("#status-editor").textContent = filePath;
    setSaveStatus("Saved");
    renderFiles();
    editor.focus();
  } catch (error) {
    appendMessage("system", error.message, "error");
  }
}

async function reloadActiveFileIfClean() {
  if (!editor || !activeFile || !workspace || editor.getValue() !== savedContent) return;
  try {
    const result = await api.readFile(workspace, activeFile);
    if (result.content !== savedContent) {
      savedContent = result.content;
      editor.setValue(result.content);
      setSaveStatus("Updated from workspace");
    }
  } catch {
    // The agent may have removed or renamed the open file; leave the editor
    // content intact so the user can copy it elsewhere if needed.
  }
}

async function saveFile() {
  if (!editor || !activeFile || !workspace) return;
  try {
    await api.writeFile(workspace, activeFile, editor.getValue());
    savedContent = editor.getValue();
    $("#active-tab").textContent = activeFile.split("/").pop();
    setSaveStatus("Saved");
    await refreshFiles();
  } catch (error) {
    appendMessage("system", "Gagal menyimpan: " + error.message, "error");
    setSaveStatus("Save failed");
  }
}

async function chooseWorkspace() {
  try {
    const result = await api.pickWorkspace();
    if (!result) return;
    if (agentStarted && result.path !== workspace) {
      alert("Sesi agent yang sedang berjalan terikat pada workspace saat ini. Tutup dan buka kembali WTAgent Studio untuk memulai sesi pada folder lain.");
      return;
    }
    await setWorkspace(result.path, result.name);
  } catch (error) {
    appendMessage("system", error.message, "error");
  }
}

async function setWorkspace(workspacePath, name = "") {
  const result = await api.validateWorkspace(workspacePath);
  workspace = result.path;
  localStorage.setItem("wtagent.workspace", workspace);
  const title = name || result.name;
  $("#workspace-name").textContent = workspace;
  $("#project-label").textContent = title.toUpperCase();
  $("#status-project").textContent = title;
  await refreshFiles();
  setAgentStatus(agentStarted ? "Session aktif · " + $("#provider-select").value : "Workspace siap · pilih tugas");
}

async function createFile() {
  if (!workspace) return alert("Buka folder proyek terlebih dahulu.");
  const filePath = prompt("Nama file baru (relatif dari folder proyek):", "src/new-file.js");
  if (!filePath) return;
  try {
    await api.createFile(workspace, filePath);
    await refreshFiles();
    await openFile(filePath);
  } catch (error) {
    alert("Tidak bisa membuat file: " + error.message);
  }
}

async function sendAgent() {
  const promptText = $("#agent-prompt").value.trim();
  if (!promptText || agentBusy) return;
  if (!workspace) {
    alert("Buka folder proyek terlebih dahulu.");
    return;
  }
  $("#agent-prompt").value = "";
  appendMessage("user", promptText);
  setAgentStatus("Memproses tugas…", "busy");
  $("#provider-select").disabled = true;
  $("#generation-select").disabled = true;
  try {
    if (!agentStarted) {
      await api.startAgent({
        projectRoot: workspace,
        model: $("#provider-select").value,
        generationType: $("#provider-select").value === "gemini" ? $("#generation-select").value : "agent",
        instruction: promptText
      });
    } else {
      await api.sendAgent(promptText);
    }
    if (!agentBusy) setAgentStatus("Session siap");
  } catch (error) {
    // The service emits desktop.agent_error with the provider/runtime detail.
    // Avoid showing the same exception twice when the IPC call also rejects.
    if (!agentStarted) setAgentStatus("Gagal memulai agent", "error");
  } finally {
    $("#provider-select").disabled = agentStarted;
    $("#generation-select").disabled = agentStarted;
  }
}

function writeTerminal(text, className = "") {
  const output = $("#terminal-output");
  const line = document.createElement("div");
  if (className) line.className = className;
  line.textContent = String(text ?? "");
  output.append(line);
  output.scrollTop = output.scrollHeight;
  while (output.children.length > 500) output.firstElementChild.remove();
}

async function runTerminalCommand(command) {
  if (!workspace) return alert("Buka folder proyek terlebih dahulu.");
  if (currentTerminalJob) return;
  $("#terminal-panel").classList.remove("hidden");
  $("#terminal-command").value = "";
  $("#terminal-command").disabled = true;
  $("#terminal-run").disabled = true;
  $("#terminal-cancel").disabled = false;
  $("#terminal-status").textContent = "Running…";
  writeTerminal("$ " + command, "command-line");
  try {
    const job = await api.runCommand(workspace, command);
    currentTerminalJob = job.id;
  } catch (error) {
    writeTerminal(error.message, "error-line");
    finishTerminal();
  }
}

function finishTerminal() {
  currentTerminalJob = null;
  $("#terminal-command").disabled = false;
  $("#terminal-run").disabled = false;
  $("#terminal-cancel").disabled = true;
  $("#terminal-status").textContent = "Command runner";
  $("#terminal-command").focus();
}

api.onTerminalEvent((event) => {
  if (event.type === "data") writeTerminal(event.data, event.stream === "stderr" ? "error-line" : "");
  if (event.type === "started") currentTerminalJob = event.id;
  if (event.type === "error") writeTerminal(event.message, "error-line");
  if (event.type === "exit") {
    writeTerminal("[process exited · code " + event.code + "]", "exit-line");
    finishTerminal();
    refreshFiles();
  }
});

api.onAgentEvent((event) => {
  const payload = event.payload || {};
  switch (event.type) {
    case "desktop.session_started":
      agentStarted = true;
      $("#provider-select").disabled = true;
      $("#generation-select").disabled = true;
      appendActivity("Session dimulai", payload.sessionId);
      break;
    case "desktop.turn_started":
      setAgentStatus("Memproses tugas…", "busy");
      appendActivity("Agent mulai bekerja", payload.instruction || "");
      break;
    case "desktop.turn_finished":
      setAgentStatus("Session siap");
      refreshFiles();
      reloadActiveFileIfClean();
      break;
    case "browser.started":
      setAgentStatus("Menghubungkan browser…", "busy");
      appendActivity("Membuka browser", payload.profileDir || "");
      break;
    case "browser.auth_required":
      setAgentStatus("Menunggu login " + ($("#provider-select").value), "busy");
      appendActivity("Login diperlukan", "Selesaikan login pada jendela browser yang terbuka.");
      break;
    case "browser.authenticated":
      appendActivity("Akun terhubung", "Login provider berhasil diverifikasi.");
      break;
    case "desktop.provider_selection_required":
      showProviderSelection(payload);
      break;
    case "conversation.started":
      setAgentStatus("AI terhubung", "busy");
      break;
    case "model.message_sent":
      appendActivity("Instruksi dikirim ke " + $("#provider-select").value);
      break;
    case "model.progress":
      if (payload.message) appendMessage("assistant", payload.message);
      break;
    case "tool.proposed":
      appendActivity("Agent merencanakan " + payload.name, payload.args || {});
      break;
    case "desktop.approval_required":
      showApproval(payload);
      break;
    case "tool.started":
      appendActivity("Menjalankan " + payload.name, "Tool sedang bekerja di workspace.");
      break;
    case "tool.output":
      appendActivity("Output " + payload.name, payload.output || payload.stdout || payload.stderr || payload);
      break;
    case "tool.result_sent":
      appendActivity("Hasil tool dikembalikan ke AI", payload.name || "");
      refreshFiles();
      reloadActiveFileIfClean();
      break;
    case "tool.invalid":
    case "tool.conflict":
      appendActivity("Tool tidak dijalankan", payload.message || payload.name);
      break;
    case "run.completed":
      if (payload.message) appendMessage("assistant", payload.message);
      break;
    case "desktop.notice":
      appendMessage("system", payload.message + (payload.details ? "\n" + JSON.stringify(payload.details) : ""), "notice");
      break;
    case "desktop.cancel_requested":
      appendActivity("Pembatalan diminta", "Agent sedang menghentikan langkah aktif.");
      break;
    case "desktop.agent_error":
      appendMessage("assistant", payload.message || "Agent gagal.", "error");
      setAgentStatus("Terjadi kesalahan", "error");
      break;
  }
});

$("#open-folder").addEventListener("click", chooseWorkspace);
$("#welcome-open").addEventListener("click", chooseWorkspace);
$("#provider-select").addEventListener("change", () => {
  const isGemini = $("#provider-select").value === "gemini";
  $("#generation-select").disabled = agentStarted || !isGemini;
  if (!isGemini) $("#generation-select").value = "agent";
});
$("#generation-select").disabled = $("#provider-select").value !== "gemini";
$("#refresh-files").addEventListener("click", refreshFiles);
$("#new-file").addEventListener("click", createFile);
$("#start-agent").addEventListener("click", () => $("#agent-prompt").focus());
$("#agent-form").addEventListener("submit", (event) => {
  event.preventDefault();
  sendAgent();
});
$("#agent-prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendAgent();
  }
});
$("#cancel-agent").addEventListener("click", async () => {
  await api.cancelAgent();
});
$("#clear-chat").addEventListener("click", () => {
  $("#chat-feed").replaceChildren();
  appendActivity("Tampilan chat dibersihkan", "Riwayat agent tetap tersimpan di sesi WTAgent.");
});
$("#terminal-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runTerminalCommand($("#terminal-command").value.trim());
});
$("#terminal-cancel").addEventListener("click", async () => {
  if (currentTerminalJob) await api.cancelCommand(currentTerminalJob);
});
$("#clear-terminal").addEventListener("click", () => $("#terminal-output").replaceChildren());
$("#hide-terminal").addEventListener("click", () => $("#terminal-panel").classList.add("hidden"));
document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => {
    $("#agent-prompt").value = button.dataset.prompt || "";
    $("#agent-prompt").focus();
  });
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveFile();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "j") {
    event.preventDefault();
    $("#terminal-panel").classList.toggle("hidden");
  }
});

window.addEventListener("monaco-ready", () => {
  initEditor();
});

(async function boot() {
  if (workspace) {
    try {
      await setWorkspace(workspace);
    } catch {
      localStorage.removeItem("wtagent.workspace");
      workspace = "";
    }
  }
})();
