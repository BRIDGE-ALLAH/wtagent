const { spawn } = require("node:child_process");

function waitForClose(terminal, timeoutMs) {
  if (terminal.closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    terminal.closePromise.then(() => finish(true));
  });
}

async function killProcessTree(pid, signal, {
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  if (!pid) return;
  if (platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawnImpl("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("close", resolve);
      killer.once("error", resolve);
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may already have exited.
    }
  }
}

function terminalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function stopTerminalProcess(terminal, {
  platform = process.platform,
  killProcessTreeImpl = killProcessTree,
  stopGraceMs = 1_000,
  forceGraceMs = 1_000,
} = {}) {
  if (terminal.closed) return { status: "exited" };
  if (terminal.stopPromise) return await terminal.stopPromise;

  terminal.stopPromise = (async () => {
    if (!terminal.child?.pid) {
      return { status: "completion_unknown" };
    }
    await Promise.resolve(killProcessTreeImpl(terminal.child.pid, "SIGTERM", { platform }))
      .catch(() => undefined);
    if (await waitForClose(terminal, stopGraceMs)) return { status: "exited" };
    if (terminal.closed) return { status: "exited" };

    await Promise.resolve(killProcessTreeImpl(terminal.child.pid, "SIGKILL", { platform }))
      .catch(() => undefined);
    if (await waitForClose(terminal, forceGraceMs)) return { status: "exited" };
    return { status: "completion_unknown" };
  })();
  return await terminal.stopPromise;
}

async function writeTerminalInput(terminal, input) {
  if (terminal.closed || !terminal.child?.stdin?.writable) {
    throw terminalError("TERMINAL_CLOSED", "Terminal input is unavailable because the process has exited.");
  }

  let accepted;
  try {
    accepted = terminal.child.stdin.write(String(input ?? ""));
  } catch (error) {
    throw terminalError("TERMINAL_WRITE_FAILED", error.message);
  }
  if (accepted) return true;

  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      terminal.child.stdin.removeListener("drain", onDrain);
      terminal.child.stdin.removeListener("error", onError);
      terminal.child.stdin.removeListener("close", onClose);
      terminal.child.removeListener("close", onClose);
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onError = (error) => finish(terminalError("TERMINAL_WRITE_FAILED", error.message));
    const onClose = () => finish(terminalError("TERMINAL_CLOSED", "Terminal exited while input was backpressured."));
    terminal.child.stdin.once("drain", onDrain);
    terminal.child.stdin.once("error", onError);
    terminal.child.stdin.once("close", onClose);
    terminal.child.once("close", onClose);
    if (terminal.closed || terminal.child.stdin.destroyed) onClose();
  });
  return true;
}

module.exports = { stopTerminalProcess, writeTerminalInput };
