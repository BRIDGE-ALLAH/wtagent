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

- Workspace folder picker and a project file explorer
- Monaco editor for opening, editing, and saving text files (`Ctrl/Cmd+S`)
- AI chat wired to WTAgent's existing `AgentRuntime`
- Provider browser handoff and login flow
- Per-action approval controls: allow once, always allow a tool, allow all tools, or deny
- Workspace-scoped file access from the editor
- Project command runner at the bottom (`Ctrl/Cmd+J` toggles the panel)

## Notes

- Terminal commands are started as one-shot shell processes; a persistent interactive PTY is not part of this first version.
- The editor currently opens text files up to 2 MB.
- The app saves WTAgent session state and provider browser profiles under Electron's user-data directory.
- This desktop integration is an initial implementation. Exercise it with a disposable project before relying on it for important work, and review agent approval prompts before allowing file or command operations.
