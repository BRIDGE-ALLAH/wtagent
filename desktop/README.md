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
- Persistent shell process for consecutive commands and long-running development servers (`Ctrl/Cmd+J` toggles the panel)
- AI chat wired to WTAgent's existing `AgentRuntime`, with per-action approval controls
- Workflow modes: **Agent**, **Plan only**, and **Build & verify**. Plan only denies non-read-only tools in the runtime policy; Build & verify asks the model to inspect, plan, implement, run relevant checks, and review the diff.
- Git source control: current branch, changed-file list, staged/unstaged diff, stage/unstage, create/switch branch, and local commit
- Saved WTAgent session list, session resume/recovery, and locally persisted chat activity display
- Provider manager for all supported web providers, profile-folder status/open, default provider, and a local note for a preferred model

## Notes and current limitations

- The shell process is persistent and accepts additional commands while another process runs, but it is not backed by a native PTY. Full-screen terminal programs, raw keyboard modes, and rich terminal emulation (for example `vim` or `top`) are not supported reliably. Stop ends the shell process.
- The Git panel performs local operations only. It does not push, fetch, or publish to a remote.
- Provider profile status means that a local profile folder exists; it does not prove that the provider is signed in. WTAgent still asks you to complete login in its browser when required.
- The preferred-model field is a note for your own reference. WTAgent does not automatically select model names on provider websites; choose the actual model in the provider browser.
- Plan only restricts WTAgent tools whose declared risk is not read-only. It cannot prevent a user from changing files manually in the editor or terminal outside the agent.
- The editor currently opens text files up to 2 MB.
- WTAgent session state, provider browser profiles, and desktop UI preferences are stored locally under Electron's user-data directory. A resumed session may need the provider browser to reconnect or authenticate.
- Exercise the app with a disposable project before relying on it for important work. Review approval prompts before allowing agent file or process operations.
