# WTAgent Studio

Desktop IDE for [WTAgent](https://github.com/BRIDGE-ALLAH/wtagent). It wraps the existing WTAgent browser-backed agent in an Electron workspace with a Monaco editor, file explorer, AI chat, approval prompts, and a project command runner.

## Requirements

- Node.js 20.17+ (or a supported Node 22/23+ release)
- Chrome or Chromium
- A signed-in account for the provider you plan to use (ChatGPT, Claude, DeepSeek, Gemini, Grok, Kimi, or GLM)
- The repository's root dependencies installed before launching or packaging the desktop app

WTAgent uses your provider's logged-in web account and its available quota. The desktop UI does not add a separate API-key integration.

## Run from source

From the repository root:

```bash
npm ci
cd desktop
npm install
npm start
```

On first use, choose a project folder, select a provider, and start the agent. The provider's browser profile is managed separately from your everyday browser profile. Sign in when asked, select the model on the provider website, then press **Lanjutkan** in the desktop chat.

## Build installers

Run these commands from `desktop/` after installing the root and desktop dependencies:

```bash
npm run dist:win
npm run dist:mac
npm run dist:linux
```

Build output is written to `desktop/dist/`. macOS distribution signing/notarization is not configured in this starter setup.

## Current desktop features

- Workspace folder picker, explorer, Monaco editor, file save, and nested file creation (`Ctrl/Cmd+S`)
- Persistent shell process for sequential commands (`Ctrl/Cmd+J` toggles the panel); background servers can be launched with the host shell’s background command
- AI chat wired to WTAgent's existing `AgentRuntime`, with per-action approval controls
- Workflow modes: **Agent**, **Plan only**, **Build & verify**, and **Autonomous**. Autonomous inspects the workspace under a hard read-only runtime policy, stores a bounded plan with a SHA-256 integrity hash, and pauses for an explicit **Approve plan** or **Reject plan** decision. Approval starts implementation in a second model turn; normal per-tool approvals remain active. Plan and decision state are persisted in the WTAgent session and restored after restart.
- Autonomous implementation asks the agent to re-check workspace/Git state, preserve unrelated user changes, run relevant verification, inspect the final diff, and report only checks actually run. It does not push, publish, release, deploy, or bypass normal tool approvals.
- Git source control: current branch, changed-file list, staged/unstaged diff, stage/unstage, create/switch branch, and local commit
- Saved WTAgent session list, session resume/recovery, and locally persisted chat activity display
- Provider manager for all supported web providers, profile-folder status/open, default provider, and a local note for a preferred model

### Autonomous workspace checkpoint and rollback

After explicit plan approval, WTAgent snapshots the workspace before implementation (maximum 8,000 regular files / 128 MiB; dependency and generated folders are excluded). After a successful run, a changed-file manifest is finalized and a rollback action appears in chat. Rollback verifies every affected file against the agent output before restoring anything; if any affected file has changed since completion, the entire rollback is refused. New files are removed and modified/deleted files are restored. Users should not edit the workspace while the agent is running: concurrent edits made during the run cannot be distinguished reliably from agent edits. Interrupted runs do not expose automatic rollback because partial agent writes cannot safely be distinguished from concurrent user edits.

## Notes and current limitations

- The shell process is persistent across sequential commands, but it is not backed by a native PTY. A foreground command occupies the shell until it exits; for a background dev server, use `start /B ...` in CMD, `Start-Process ...` in PowerShell, or `... &` in Bash. Full-screen terminal programs, raw keyboard modes, and rich terminal emulation (for example `vim` or `top`) are not supported reliably. Stop ends the shell process.
- The Git panel performs local operations only. It does not push, fetch, or publish to a remote.
- Provider profile status means that a local profile folder exists; it does not prove that the provider is signed in. WTAgent still asks you to complete login in its browser when required.
- The preferred-model field is a note for your own reference. WTAgent does not automatically select model names on provider websites; choose the actual model in the provider browser.
- Plan only restricts WTAgent tools whose declared risk is not read-only. It cannot prevent a user from changing files manually in the editor or terminal outside the agent.
- The editor currently opens text files up to 2 MB.
- WTAgent session state, provider browser profiles, and desktop UI preferences are stored locally under Electron's user-data directory. A resumed session may need the provider browser to reconnect or authenticate.
- Plan approval is a scope checkpoint, not a guarantee that a proposed change is correct. Review the plan, monitor per-tool approvals, and inspect the final Git diff before accepting the result.
- Exercise the app with a disposable project before relying on it for important work. Review approval prompts before allowing agent file or process operations.
