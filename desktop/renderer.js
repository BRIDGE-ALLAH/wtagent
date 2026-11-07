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
  $("#agent-mode").disabled = agentBusy;
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

function showAutonomousPlan(payload) {
  const plan = String(payload.plan ?? "").trim();
  if (!plan) return;
  $(".autonomous-plan-card")?.remove();
  const card = document.createElement("section");
  card.className = "autonomous-plan-card";
  const heading = document.createElement("div");
  heading.className = "autonomous-plan-heading";
  heading.textContent = "Rencana autonomous siap ditinjau";
  const summary = document.createElement("p");
  summary.className = "autonomous-plan-summary";
  summary.textContent = "Fase perencanaan bersifat read-only. Perubahan kode belum dijalankan. Periksa lingkup dan langkah sebelum menyetujui implementasi.";
  const content = document.createElement("pre");
  content.className = "autonomous-plan-content";
  content.textContent = plan;
  const fingerprint = document.createElement("div");
  fingerprint.className = "autonomous-plan-fingerprint";
  fingerprint.textContent = payload.planSha256 ? "SHA-256: " + payload.planSha256 : "";
  const actions = document.createElement("div");
  actions.className = "autonomous-plan-actions";
  const approve = document.createElement("button");
  approve.className = "button primary";
  approve.type = "button";
  approve.textContent = "Setujui rencana & mulai implementasi";
  const reject = document.createElement("button");
  reject.className = "button secondary";
  reject.type = "button";
  reject.textContent = "Tolak rencana";
  approve.addEventListener("click", async () => {
    approve.disabled = true;
    reject.disabled = true;
    setAgentStatus("Implementasi berjalan…", "busy");
    appendActivity("Rencana disetujui", "Implementasi dimulai. Persetujuan per tool dan batasan keamanan tetap berlaku.");
    try {
      await api.approveAutonomousPlan();
    } catch (error) {
      appendMessage("system", "Implementasi tidak dapat dilanjutkan: " + error.message, "error");
      setAgentStatus("Implementasi terhenti", "error");
      approve.disabled = false;
      reject.disabled = false;
    }
  });
  reject.addEventListener("click", async () => {
    approve.disabled = true;
    reject.disabled = true;
    try {
      await api.rejectAutonomousPlan();
      card.remove();
      appendMessage("system", "Rencana ditolak. WTAgent tidak menjalankan implementasi dari rencana ini.", "notice");
      setAgentStatus("Rencana ditolak");
    } catch (error) {
      appendMessage("system", "Rencana belum dapat ditolak: " + error.message, "error");
      approve.disabled = false;
      reject.disabled = false;
    }
  });
  actions.append(approve, reject);
  card.append(heading, summary, content, fingerprint, actions);
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


function getProviderPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem("wtagent.provider-preferences") || "{}");
    return { defaultProvider: value.defaultProvider || "chatgpt", providers: value.providers || {} };
  } catch {
    return { defaultProvider: "chatgpt", providers: {} };
  }
}

function saveProviderPreferences(value) {
  localStorage.setItem("wtagent.provider-preferences", JSON.stringify(value));
}

async function openModelsManager() {
  $("#models-modal").classList.remove("hidden");
  const preferences = getProviderPreferences();
  const select = $("#models-default-provider");
  select.replaceChildren();
  for (const option of $("#provider-select").options) {
    select.add(new Option(option.textContent, option.value));
  }
  select.value = preferences.defaultProvider;
  try {
    const profiles = await api.providerProfiles();
    const host = $("#provider-profile-list");
    host.replaceChildren();
    for (const profile of profiles) {
      const card = document.createElement("div");
      card.className = "provider-profile-card";
      const top = document.createElement("div");
      top.className = "provider-profile-top";
      const name = document.createElement("span");
      name.className = "provider-profile-name";
      name.textContent = profile.label;
      const status = document.createElement("span");
      status.className = "provider-profile-state" + (profile.exists ? "" : " missing");
      status.textContent = profile.exists ? "Folder profil ada" : "Belum dibuat";
      top.append(name, status);
      const directory = document.createElement("div");
      directory.className = "provider-profile-path";
      directory.textContent = profile.directory;
      const controls = document.createElement("div");
      controls.className = "provider-profile-controls";
      const model = document.createElement("input");
      model.className = "provider-model-note";
      model.placeholder = "Catatan model favorit";
      model.value = preferences.providers[profile.id]?.modelName || "";
      model.dataset.provider = profile.id;
      model.addEventListener("change", () => {
        const current = getProviderPreferences();
        current.providers[profile.id] = { ...(current.providers[profile.id] || {}), modelName: model.value.trim() };
        saveProviderPreferences(current);
      });
      const open = document.createElement("button");
      open.textContent = "Buka folder";
      open.addEventListener("click", async () => {
        const error = await api.openProviderProfile(profile.id);
        if (error) alert(error);
      });
      controls.append(model, open);
      card.append(top, directory, controls);
      host.append(card);
    }
  } catch (error) {
    $("#provider-profile-list").textContent = "Gagal memuat profil: " + error.message;
  }
}

async function loadSessions() {
  const host = $("#session-list");
  host.replaceChildren();
  try {
    const sessions = await api.listSessions();
    if (!sessions.length) {
      const empty = document.createElement("div");
      empty.className = "empty-tree";
      empty.textContent = "Belum ada sesi WTAgent yang tersimpan.";
      host.append(empty);
      return;
    }
    for (const session of sessions) {
      const button = document.createElement("button");
      button.className = "session-entry";
      const main = document.createElement("div");
      main.className = "session-entry-main";
      const title = document.createElement("div");
      title.className = "session-entry-title";
      title.textContent = session.task || "Sesi tanpa judul";
      const meta = document.createElement("div");
      meta.className = "session-entry-meta";
      meta.textContent = [session.provider, session.phase, session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "", session.projectRoot].filter(Boolean).join(" · ");
      main.append(title, meta);
      const state = document.createElement("span");
      state.className = "session-entry-state";
      state.textContent = session.recoveryRequired ? "Recovery" : session.sessionId === currentSessionId ? "Aktif" : "Lanjutkan";
      button.append(main, state);
      button.addEventListener("click", () => resumeSession(session));
      host.append(button);
    }
  } catch (error) {
    const item = document.createElement("div");
    item.className = "empty-tree";
    item.textContent = "Gagal memuat sesi: " + error.message;
    host.append(item);
  }
}

async function resumeSession(session) {
  if (!session.projectRoot) return alert("Sesi ini tidak memiliki folder proyek.");
  try {
    $("#sessions-modal").classList.add("hidden");
    await setWorkspace(session.projectRoot);
    $("#provider-select").value = session.provider || "chatgpt";
    $("#generation-select").value = session.generationType || "agent";
    $("#generation-select").disabled = $("#provider-select").value !== "gemini";
    $("#agent-mode").value = session.workflowMode || "agent";
    restoreChat(session.sessionId, session.task);
    agentStarted = false;
    setAgentStatus(session.recoveryRequired ? "Memulihkan handoff…" : "Membuka sesi…", "busy");
    $("#provider-select").disabled = true;
    $("#generation-select").disabled = true;
    await api.resumeAgent({ sessionId: session.sessionId, workflowMode: session.workflowMode || "agent" });
    await refreshGitStatus();
  } catch (error) {
    setAgentStatus("Gagal membuka sesi", "error");
    appendMessage("system", error.message, "error");
  }
}

async function openSessionsManager() {
  $("#sessions-modal").classList.remove("hidden");
  await loadSessions();
}

async function startNewSession() {
  if (agentBusy) {
    alert("Tunggu atau batalkan proses agent sebelum memulai sesi baru.");
    return;
  }
  if (currentSessionId && !confirm("Simpan sesi saat ini dan mulai percakapan baru?")) return;
  try {
    await api.resetAgent();
    currentSessionId = "";
    chatHistory = [];
    agentStarted = false;
    $("#provider-select").disabled = false;
    $("#generation-select").disabled = $("#provider-select").value !== "gemini";
    $("#agent-mode").disabled = false;
    $("#chat-feed").replaceChildren();
    appendMessage("system", "Sesi baru siap. Riwayat sesi sebelumnya tetap tersimpan dan dapat dibuka dari tombol Sesi.");
    setAgentStatus(workspace ? "Workspace siap · pilih tugas" : "Ready · pilih workspace");
  } catch (error) {
    appendMessage("system", error.message, "error");
  }
}

async function refreshGitStatus() {
  const note = $("#git-status-note");
  if (!workspace) {
    note.textContent = "Buka folder proyek untuk melihat Git.";
    $("#git-changes").textContent = "Belum ada workspace.";
    return;
  }
  note.textContent = "Memeriksa Git…";
  try {
    gitState = await api.gitStatus(workspace);
    const select = $("#git-branch-select");
    const previous = select.value;
    select.replaceChildren();
    for (const branch of gitState.branches) select.add(new Option(branch, branch));
    if (gitState.branch && !gitState.branches.includes(gitState.branch)) select.add(new Option(gitState.branch, gitState.branch));
    select.value = gitState.branch || "";
    if (previous && gitState.branches.includes(previous) && previous === gitState.branch) select.value = previous;
    $("#status-branch").textContent = gitState.branch ? "⑂ " + gitState.branch : "⑂";
    $("#git-stage-all").disabled = !gitState.isRepo || !gitState.changes.length;
    $("#git-commit-message").disabled = !gitState.isRepo;
    $("#git-commit-form button").disabled = !gitState.isRepo;
    renderGitChanges();
    note.textContent = !gitState.isRepo ? gitState.error || "Folder ini bukan repository Git." : gitState.changes.length + " perubahan · " + gitState.branches.length + " branch";
  } catch (error) {
    note.textContent = error.message;
  }
}

function renderGitChanges() {
  const host = $("#git-changes");
  host.replaceChildren();
  if (!gitState.isRepo) {
    const empty = document.createElement("div");
    empty.className = "empty-tree";
    empty.textContent = gitState.error || "Bukan repository Git.";
    host.append(empty);
    return;
  }
  if (!gitState.changes.length) {
    const empty = document.createElement("div");
    empty.className = "empty-tree";
    empty.textContent = "Working tree bersih.";
    host.append(empty);
    return;
  }
  for (const change of gitState.changes) {
    const row = document.createElement("div");
    row.className = "git-change-row";
    const open = document.createElement("button");
    open.className = "git-change-open";
    open.title = "Lihat diff";
    const file = document.createElement("span");
    file.className = "git-change-path";
    file.textContent = change.path;
    const status = document.createElement("span");
    status.className = "git-change-status";
    status.textContent = change.status;
    open.append(file, status);
    open.addEventListener("click", () => showGitDiff(change.path));
    const stage = document.createElement("button");
    stage.className = "git-change-action";
    stage.title = change.staged ? "Unstage" : "Stage";
    stage.textContent = change.staged ? "−" : "+";
    stage.addEventListener("click", async () => {
      try {
        await api.gitStage(workspace, change.path, !change.staged);
        await refreshGitStatus();
      } catch (error) {
        alert(error.message);
      }
    });
    row.append(open, stage);
    host.append(row);
  }
}

async function showGitDiff(filePath) {
  try {
    const result = await api.gitDiff(workspace, filePath);
    $("#diff-title").textContent = result.path;
    $("#diff-content").textContent = result.diff;
    $("#diff-view").classList.remove("hidden");
    if (editor) $("#editor-host").style.display = "none";
  } catch (error) {
    alert("Gagal membuka diff: " + error.message);
  }
}

function showSidebarView(view) {
  const isGit = view === "git";
  $("#explorer-view").classList.toggle("hidden", isGit);
  $("#git-panel").classList.toggle("hidden", !isGit);
  $("#explorer-tab").classList.toggle("active", !isGit);
  $("#source-control-tab").classList.toggle("active", isGit);
  if (isGit) refreshGitStatus();
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
    await refreshGitStatus();
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
  if (workspace && workspace !== result.path && currentTerminalJob) {
    await api.stopTerminal(currentTerminalJob).catch(() => {});
    finishTerminal();
  }
  workspace = result.path;
  localStorage.setItem("wtagent.workspace", workspace);
  const title = name || result.name;
  $("#workspace-name").textContent = workspace;
  $("#project-label").textContent = title.toUpperCase();
  $("#status-project").textContent = title;
  await refreshFiles();
  await refreshGitStatus();
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

function buildWorkflowInstruction(promptText) {
  const mode = $("#agent-mode").value;
  if (mode === "plan") {
    return "WORKFLOW: PLAN ONLY\nInspect the project and relevant files, then produce a concise implementation plan with affected files, dependencies, risks, and verification steps. Do not edit, create, delete, or execute project files. Wait for the user's approval before implementation.\n\nUSER REQUEST:\n" + promptText;
  }
  if (mode === "autonomous") return promptText;
  if (mode === "verify") {
    return "WORKFLOW: PLAN, IMPLEMENT, AND VERIFY\nFirst inspect the relevant project structure and state a concise plan. Then implement the requested change across all necessary files. Run the most relevant tests, type checks, lint/build commands available in this project, inspect the final diff, and report exactly what passed or failed. Do not claim tests passed unless you ran them. Preserve existing user changes and ask for approval for sensitive tool actions.\n\nUSER REQUEST:\n" + promptText;
  }
  return promptText;
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
  const instruction = buildWorkflowInstruction(promptText);
  setAgentStatus("Memproses tugas…", "busy");
  $("#provider-select").disabled = true;
  $("#generation-select").disabled = true;
  try {
    if (!agentStarted) {
      await api.startAgent({
        projectRoot: workspace,
        model: $("#provider-select").value,
        generationType: $("#provider-select").value === "gemini" ? $("#generation-select").value : "agent",
        workflowMode: $("#agent-mode").value,
        instruction
      });
    } else {
      await api.sendAgent(instruction, $("#agent-mode").value);
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
  const text = String(command ?? "");
  if (!text.trim()) return;
  $("#terminal-panel").classList.remove("hidden");
  $("#terminal-command").value = "";
  terminalHistory.push(text);
  terminalHistoryIndex = terminalHistory.length;
  writeTerminal((currentTerminalJob ? "" : "[terminal baru] ") + text, "command-line");
  try {
    if (!currentTerminalJob) {
      $("#terminal-status").textContent = "Starting shell…";
      const shell = $("#terminal-shell").value;
      const result = await api.startTerminal(workspace, shell);
      currentTerminalJob = result.id;
    }
    await api.writeTerminal(currentTerminalJob, text + "\n");
    $("#terminal-status").textContent = "Shell aktif";
    $("#terminal-cancel").disabled = false;
  } catch (error) {
    writeTerminal(error.message, "error-line");
    finishTerminal();
  }
}

function finishTerminal() {
  currentTerminalJob = null;
  $("#terminal-cancel").disabled = true;
  $("#terminal-status").textContent = "Shell stopped";
  $("#terminal-command").focus();
}

api.onTerminalEvent((event) => {
  if (event.type === "started") {
    currentTerminalJob = event.id;
    $("#terminal-status").textContent = "Shell aktif";
    $("#terminal-cancel").disabled = false;
  }
  if (event.type === "data") writeTerminal(event.data, event.stream === "stderr" ? "error-line" : "");
  if (event.type === "error") writeTerminal(event.message, "error-line");
  if (event.type === "exit") {
    if (currentTerminalJob && event.id !== currentTerminalJob) return;
    writeTerminal("[shell stopped · code " + event.code + "]", "exit-line");
    finishTerminal();
    refreshFiles();
    refreshGitStatus();
  }
});

api.onAgentEvent((event) => {
  const payload = event.payload || {};
  switch (event.type) {
    case "desktop.session_started":
      if (payload.resumed && currentSessionId !== payload.sessionId) {
        restoreChat(payload.sessionId, payload.task || "");
      }
      currentSessionId = payload.sessionId || currentSessionId;
      agentStarted = true;
      $("#provider-select").disabled = true;
      $("#generation-select").disabled = true;
      if (payload.provider) $("#provider-select").value = payload.provider;
      if (payload.workflowMode) $("#agent-mode").value = payload.workflowMode;
      appendActivity(payload.resumed ? "Sesi dipulihkan" : "Session dimulai", payload.sessionId);
      if (payload.autonomousWorkflow?.phase === "awaiting_approval") showAutonomousPlan(payload.autonomousWorkflow);
      if (payload.autonomousWorkflow?.phase === "plan_failed") appendMessage("system", payload.autonomousWorkflow.lastError || "Rencana autonomous gagal dibuat. Kirim ulang tugas untuk mencoba lagi.", "error");
      if (payload.recoveryRequired) appendMessage("system", "Sesi memiliki operasi browser yang statusnya belum pasti. WTAgent akan melakukan bare recovery terlebih dahulu; jangan mengirim ulang instruksi yang sama sebelum proses ini selesai.", "notice");
      persistChat();
      break;
    case "desktop.plan_ready":
      showAutonomousPlan(payload);
      appendActivity("Rencana autonomous tersimpan", "Workspace belum diubah oleh fase perencanaan.");
      break;
    case "desktop.plan_failed":
      appendMessage("system", payload.message || "Rencana autonomous gagal dibuat.", "error");
      break;
    case "desktop.plan_approved":
      $(".autonomous-plan-card")?.remove();
      appendActivity("Persetujuan rencana dicatat", "Implementasi berjalan dengan persetujuan tool normal.");
      break;
    case "desktop.plan_rejected":
      $(".autonomous-plan-card")?.remove();
      appendActivity("Rencana ditolak", "Tidak ada implementasi dijalankan dari rencana ini.");
      break;
    case "desktop.autonomous_completed":
      appendActivity("Autonomous workflow selesai", "Agent menyelesaikan langkah implementasi dan mengirim ringkasan hasil.");
      break;
    case "desktop.turn_started":
      setAgentStatus("Memproses tugas…", "busy");
      appendActivity("Agent mulai bekerja", payload.instruction || "");
      break;
    case "desktop.turn_finished":
      setAgentStatus("Session siap");
      refreshFiles();
      refreshGitStatus();
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
      refreshGitStatus();
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
  const preferences = getProviderPreferences();
  preferences.defaultProvider = $("#provider-select").value;
  saveProviderPreferences(preferences);
});
$("#generation-select").addEventListener("change", () => {
  const preferences = getProviderPreferences();
  preferences.providers[$("#provider-select").value] = {
    ...(preferences.providers[$("#provider-select").value] || {}),
    generationType: $("#generation-select").value
  };
  saveProviderPreferences(preferences);
});
$("#agent-mode").addEventListener("change", () => {
  localStorage.setItem("wtagent.agent-mode", $("#agent-mode").value);
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
  chatHistory = [];
  persistChat();
  appendActivity("Tampilan chat dibersihkan", "Riwayat provider tetap tersimpan di sesi WTAgent.");
});
$("#terminal-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runTerminalCommand($("#terminal-command").value.trim());
});
$("#terminal-cancel").addEventListener("click", async () => {
  if (!currentTerminalJob) return;
  $("#terminal-cancel").disabled = true;
  await api.stopTerminal(currentTerminalJob);
});
$("#terminal-command").addEventListener("keydown", (event) => {
  if (event.key === "ArrowUp" && terminalHistory.length) {
    event.preventDefault();
    terminalHistoryIndex = Math.max(0, terminalHistoryIndex - 1);
    $("#terminal-command").value = terminalHistory[terminalHistoryIndex] || "";
  } else if (event.key === "ArrowDown" && terminalHistory.length) {
    event.preventDefault();
    terminalHistoryIndex = Math.min(terminalHistory.length, terminalHistoryIndex + 1);
    $("#terminal-command").value = terminalHistory[terminalHistoryIndex] || "";
  }
});
$("#clear-terminal").addEventListener("click", () => $("#terminal-output").replaceChildren());
$("#hide-terminal").addEventListener("click", () => $("#terminal-panel").classList.add("hidden"));
$("#explorer-tab").addEventListener("click", () => showSidebarView("explorer"));
$("#source-control-tab").addEventListener("click", () => showSidebarView("git"));
$("#git-refresh").addEventListener("click", refreshGitStatus);
$("#git-stage-all").addEventListener("click", async () => {
  try {
    await api.gitStageAll(workspace);
    await refreshGitStatus();
  } catch (error) {
    alert(error.message);
  }
});
$("#git-branch-select").addEventListener("change", async () => {
  const branch = $("#git-branch-select").value;
  if (!branch || branch === gitState.branch) return;
  try {
    await api.gitCheckout(workspace, branch, false);
    await refreshGitStatus();
  } catch (error) {
    alert("Tidak bisa berpindah branch: " + error.message);
    await refreshGitStatus();
  }
});
$("#git-new-branch").addEventListener("click", async () => {
  const branch = prompt("Nama branch baru:");
  if (!branch) return;
  try {
    await api.gitCheckout(workspace, branch, true);
    await refreshGitStatus();
  } catch (error) {
    alert("Tidak bisa membuat branch: " + error.message);
  }
});
$("#git-commit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#git-commit-message").value.trim();
  if (!message) return alert("Isi pesan commit.");
  try {
    await api.gitCommit(workspace, message);
    $("#git-commit-message").value = "";
    await refreshGitStatus();
    appendActivity("Git commit dibuat", message);
  } catch (error) {
    alert("Commit gagal: " + error.message);
  }
});
$("#diff-close").addEventListener("click", () => {
  $("#diff-view").classList.add("hidden");
  if (editor && activeFile) $("#editor-host").style.display = "block";
});
$("#sessions-open").addEventListener("click", openSessionsManager);
$("#sessions-close").addEventListener("click", () => $("#sessions-modal").classList.add("hidden"));
$("#sessions-modal").addEventListener("click", (event) => {
  if (event.target === $("#sessions-modal")) $("#sessions-modal").classList.add("hidden");
});
$("#models-open").addEventListener("click", openModelsManager);
$("#models-close").addEventListener("click", () => $("#models-modal").classList.add("hidden"));
$("#models-modal").addEventListener("click", (event) => {
  if (event.target === $("#models-modal")) $("#models-modal").classList.add("hidden");
});
$("#models-default-provider").addEventListener("change", () => {
  const preferences = getProviderPreferences();
  preferences.defaultProvider = $("#models-default-provider").value;
  saveProviderPreferences(preferences);
  $("#provider-select").value = preferences.defaultProvider;
  $("#provider-select").dispatchEvent(new Event("change"));
});
$("#new-session").addEventListener("click", startNewSession);
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
  if (event.key === "Escape") {
    $("#sessions-modal").classList.add("hidden");
    $("#models-modal").classList.add("hidden");
    $("#diff-view").classList.add("hidden");
  }
});

window.addEventListener("monaco-ready", () => {
  initEditor();
});

(async function boot() {
  const preferences = getProviderPreferences();
  if ([...$("#provider-select").options].some((option) => option.value === preferences.defaultProvider)) {
    $("#provider-select").value = preferences.defaultProvider;
  }
  $("#agent-mode").value = localStorage.getItem("wtagent.agent-mode") || "agent";
  $("#generation-select").disabled = $("#provider-select").value !== "gemini";
  if (workspace) {
    try {
      await setWorkspace(workspace);
    } catch {
      localStorage.removeItem("wtagent.workspace");
      workspace = "";
    }
  }
  await loadSessions();
})();
