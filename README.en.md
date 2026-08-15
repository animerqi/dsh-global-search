# dsh-global-search 🧭

> A global conversation-content search plugin for DeepSeek Harness: **full-text search across all workspaces and sessions**, message-level hits, keyword highlighting, and **one-click jump to the exact message**.

[中文 README](./README.md) | [GitHub Repository](https://github.com/animerqi/dsh-global-search)

## ✨ Features

- 🔍 **Global full-text search**: search user messages and assistant replies across every workspace and every historical session (no longer limited to conversation titles)
- 📍 **Message-level hits**: results pinpoint the exact message in a session, showing role (Q/A), timestamp, and context snippet
- ✨ **Keyword highlighting**: matched keywords are highlighted in the snippet for instant scanning
- 🎯 **Precise jump**: clicking a result opens the session and **auto-scrolls to that message** with a flash highlight
- ⌨️ **Ctrl+F shortcut**: summon the search panel anytime (Cmd+F on Mac); pressing again while open refocuses the input
- 📶 **Indexing progress**: automatically scans all sessions on first use, with live progress in the UI
- 🔄 **Live incremental updates**: new messages are appended to the index via event listeners — no manual rebuild
- 🎨 **Non-intrusive UI**: transparent overlay keeps the background untouched; only the search panel appears; click outside or press Esc to close

## 📥 Installation

### Prerequisites

- **DeepSeek Harness** installed (desktop app DeepWharf or CLI)
- The plugin relies on the **Web UI** (`profiles/web`), so use it through the Web interface

### Step 0: Locate DSH_HOME

The plugin installs under the DSH data directory. Find yours first:

| Scenario | DSH_HOME |
|---|---|
| Desktop DeepWharf (Windows) | `%APPDATA%\DeepWharf\harness` |
| Standard install (default) | `~/.dsh` |
| Custom (with `$DSH_HOME` env var set) | `$DSH_HOME` |

The steps below use `%APPDATA%\DeepWharf\harness` as an example — replace it with your actual path.

### Method 1: Manual install (universal, recommended)

**1. Get the plugin source**

```bash
git clone https://github.com/animerqi/dsh-global-search.git
# or download the ZIP: https://github.com/animerqi/dsh-global-search/archive/refs/heads/main.zip
```

**2. Copy into the DSH plugins directory**

```bash
# Windows (PowerShell)
Copy-Item -Recurse dsh-global-search "%APPDATA%\DeepWharf\harness\plugins\dsh-global-search"

# Other systems
cp -r dsh-global-search ~/.dsh/plugins/dsh-global-search
```

**3. Create a Junction / symlink (so the package resolver can find the plugin)**

```bash
# Windows (mklink may require admin or Developer Mode)
mklink /J "%APPDATA%\DeepWharf\harness\profiles\node_modules\dsh-global-search" "%APPDATA%\DeepWharf\harness\plugins\dsh-global-search"

# Other systems
ln -s ~/.dsh/plugins/dsh-global-search ~/.dsh/profiles/node_modules/dsh-global-search
```

**4. Register the plugin (edit `profiles/web/cordis.patch.yml`)**

Append at the end of the file:

```yaml
- insert:
    - id: global-search
      name: dsh-global-search
```

**5. Restart DeepSeek Harness**

After restart, a **「全局搜索 / Global Search」** button appears at the bottom of the sidebar — installation succeeded.

### Method 2: `dsh plugin` command (if available in your environment)

```bash
dsh plugin --profile web add link:..\..\plugins\dsh-global-search
```

> This command essentially forwards to pnpm to install the dependency; check `dsh plugin --help` on your machine for exact usage. Method 1 is the most universal and reliable.

### Verify the installation

- ✅ A **「全局搜索 / Global Search」** button appears at the bottom of the sidebar (or press **Ctrl+F**)
- ✅ Typing a keyword finds content from historical sessions
- ✅ `http://127.0.0.1:<port>/api/global-search/status` returns index status (`phase: ready`)

### Upgrading

```bash
# Pull the latest code, then overwrite lib/ and package.json in the plugins directory
Copy-Item -Recurse -Force dsh-global-search\* "%APPDATA%\DeepWharf\harness\plugins\dsh-global-search\"
# Restart the app
```

## 🚀 Usage

1. Click the **「全局搜索 / Global Search」** button at the bottom of the sidebar, or press **Ctrl+F** (Cmd+F on Mac)
2. Type a keyword (Chinese, English, code fragments — any substring works), results appear in a moment
3. Click any **hit snippet** → the session opens and auto-scrolls to that message (flash highlight)
4. Click the session title area → opens the session (positioned at the first hit)
5. Click outside the panel or press **Esc** to close

## 🏗️ Architecture

```
lib/index.js    Host half: scans session logs (multi-frame zstd + JSONL events) → in-memory index → HTTP search API
lib/client.js   Client half: sidebar button + search panel + hotkey + DOM-based jump positioning (React)
```

- Session log location: `<DSH_HOME>/sessions/<workspace>/<session-id>/session.jsonl.zstd`
  (auto-detects `$DSH_HOME`, `~/.dsh`, `%APPDATA%\DeepWharf\harness`)
- Search API:
  - `GET /api/global-search?q=<keyword>&limit=<count>` → results (with snippet highlight offsets and DOM-location fingerprints)
  - `GET /api/global-search/status` → index status
  - `POST /api/global-search/rescan` → force a full index rebuild
- Jump positioning: the Host returns a `fingerprint` per hit (text with markdown symbols and whitespace stripped); the Client matches `[data-chat-anchor-key]` message blocks in the session DOM and scrolls to highlight, with multi-candidate fallbacks (keyword / raw prefix)

## ⚙️ Development Notes (pitfalls we hit)

- **Cordis `inject` must declare service dependencies**: with `inject: []`, `apply` runs immediately and `ctx.get('webServer')` returns `undefined`, silently skipping route registration; declaring `inject: ['webServer']` makes Cordis wait for the service before calling `apply`. Same for the client half (`exports.inject = ['timer']`).
- **Session logs are multi-frame zstd containers**: `session.jsonl.zstd` is a concatenation of independent zstd frames (append-written); it cannot be decompressed as a whole — parse frame boundaries first, then decompress frame by frame.
- **Client-half service access**: `ctx.get(name)` needs no declaration; `ctx.name` property access must be declared in `inject` (dynamic-package whitelist).
- Test: `node test-host.mjs` (standalone mock ctx verifying scan and search logic).

## 📝 Limitations

- The index lives in memory and is rebuilt automatically after an app restart (usually within seconds, with progress shown in the UI)
- Session logs larger than 64MB are skipped (to bound memory usage)
- Up to the first 20000 characters of each message are indexed
- Jump positioning depends on message blocks being rendered; if very early history isn't loaded, the session still opens

## 📄 License

[MIT](./LICENSE) © 2026 animerqi
