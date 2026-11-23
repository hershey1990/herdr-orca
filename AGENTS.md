# AGENTS.md — herdr-orca (personal fork)

Read this before touching anything here. It is the accumulated knowledge of
five working sessions on this fork; every rule below was learned the hard way
(a broken window, a lost layout, a silent no-op).

## What this repo is

A **personal fork** of [VladTemp27/herdr-orca](https://github.com/VladTemp27/herdr-orca)
(Apache-2.0), vendoring all its mods plus [munza/herdr-mods](https://github.com/munza/herdr-mods)
`better-changes`, with local features added on top. `main` is the branch; the
upstream remote is kept as `upstream` for future merges.

**Live install ↔ repo mirror.** The running copy lives in
`~/.config/herdr-app/` (Herdr hot-reloads from there, edits apply in <1s);
this repo mirrors it. The direction of truth:

- Edit **in the install** first, verify live (`herdr-app check`, screenshots
  via `herdr-app shot`), then `cp` into the repo and commit. Never edit the
  repo and hope — verify before claiming done.
- `./sync.sh` syncs repo ← install (never the reverse). Upstream hardcoded
  `orca-2.json`; this fork reads `layouts/orca.json`.
- Excluded from sync and commits: `gpui-kit.d.ts`, `herdr.d.ts`,
  `jsconfig.json` (Herdr rewrites them per version) and
  `mods/better-changes/config.json` (holds `api_key`; gitignored).

## What the fork adds (do not regress these)

- **AI commit button** in `better-changes` (port of
  [herdr-git-changes-ai](https://github.com/hershey1990/herdr-git-changes-ai)):
  `mods/better-changes/ai.js`, the ✎ AI ✦ button in `views/sidebar.js`,
  config re-read from `config.json` on every click, key command
  `better-changes.ai` (`ctrl-shift-i` in `layout:orca`).
- **Commit checkboxes** (Zed-style: checked = staged; toggling stages or
  unstages that one file) and **Commit & Push / Push** options in the commit
  menu. A failed push keeps the commit and says so.
- **Branch switcher** (`mods/branch-picker/`): entry in my-menu's space
  section; without props it targets the active space. Sessions resolve
  through `zedCommand`-style probes; see `open-zed/zed.js` for the probe
  pattern.
- **Open in Zed** in the + menu (`mods/open-zed/`), row appears only when
  Zed is installed (probe cached 5 min, shared key `new-menu.zed.v2`).
- **New space from folder** (my-new-menu row + Spaces-header 📁 icon):
  spawn first, then `pickFolder`-style dialog, then `space.new {folder}` —
  see "runtime traps" below.
- **Files panel fixes** (`mods/files-open-with/panel.js`): one PowerShell
  process lists root + every expanded folder per refresh; the tree anchors
  on the space folder (a pane outside the project cannot re-root it).
- **Changes panel anchor** (`mods/better-changes/git/repository.js`): same
  anchor rules; a bare-home folder is not an anchor at all; the no-repo
  banner shows the folder it looked at.
- **Viewer edit mode** (`mods/files-open-with/viewer.js`): ✎ Edit rebuilds
  the EditorState writable, Save/ctrl+s writes atomically via
  `writeTextFile(path, text, expected)` — expected is the disk text, so a
  file changed on disk is refused, not clobbered. Remote files stay
  read-only.
- **Image preview** — clicking a PNG/JPEG/GIF/WebP/BMP in Files or in the
  Changes list renders it (natural size, scaled down to fit). Built on the
  SVG data-URI wrapper described in trap 15.
- **Hibernate resume for copilot/omp/pi/opencode** (`mods/hibernate/core.js`):
  `kind()` classifies them; sessions resolve per tool (copilot reads
  `~/.copilot/open-sessions-state.json`; omp/pi scan
  `~/.omp/agent/sessions/<cwd-slug>/*.jsonl` via `fs.readdir`; opencode runs
  `opencode session list --format json` **with the terminal's cwd** and
  matches `directory`). Lookups are cached by `pid+cwd+argv` — a process per
  30s pass was 3–11s of CPU; the cache makes it once per agent lifetime.
  `after_restart: "auto"` is set in `mods/hibernate/mod.json`.

## Runtime traps (each one cost a session)

1. **`cx.spawn` is the only async bridge.** A bare `await`ed promise in a mod
   never resumes — its `cx.notify()` never runs, the UI shows "loading…"
   forever. Always `cx.spawn(async (cx) => ...)`.
2. **Closing an overlay before spawning kills the click's cx** — the spawn
   never runs and the button looks dead. Order: spawn → work → close → run.
3. **`herdr exec` + PowerShell quoting**: single-quote *every* argument
   (`|`, `()`, `$` in bare words are PS syntax). `ps()` helpers exist in
   `open-zed/zed.js` and `better-sidebar/pick-folder.js`. Don't double-quote:
   `''path''` is an empty string to PowerShell.
4. **PS NUL is `$([char]0)`** inside `-Command` strings; the backtick `` `0 ``
   does not survive JS template literals, and `@(...)` concatenated inside a
   string is a parser trap. Statements joined into one `-Command` need
   `"; "` between them.
5. **CRLF between `Write-Output` records**: strip `\r\n` before splitting on
   NULs, or the parser only ever sees the first record.
6. **Mods cannot import across folders** (`../other-mod/x.js` is refused:
   "resolves outside the application directory"). Shared code is *copied*
   per mod and kept identical — `zed.js`, `pick-folder.js`, like upstream's
   `hooks.js`. Note it in a comment in each copy.
7. **A mod deleted while still referenced by a layout breaks the window**:
   Herdr falls back to the default layout and it looks like everything is
   gone. Before deleting a mod folder, remove every reference
   (`layouts/*.json`, `layouts/.state/*.json`). Recovery:
   `cp ~/Develop/herdr-orca/layouts/orca.json ~/.config/herdr-app/layouts/`.
8. **`pickFolder` (native) hangs forever on this machine** (Windows, ARM64,
   herdr.exe x64 under emulation). Use the child-process dialog in
   `better-sidebar/pick-folder.js` (PowerShell `FolderBrowserDialog`, `-STA`,
   TopMost owner, path on stdout, exit 1 on cancel) — it opens and resolves.
9. **`git status` cost scales with the repo**: `control/` (137MB
   node_modules) takes 11s. All status calls already use
   `--no-optional-locks -c core.fsmonitor=false`; keep it that way.
10. **`Scrollbar.vertical(id)` needs the scrollable area's `id`**, and
    `.bg(undefined)` breaks the render ("Encountered a string" →
    "view could not be re-rendered"). Use `.when(cond, el => el.bg(...))`.
11. **Backslashes**: JS string escapes eat them. In a file,
    `"\\\\"` is two chars; count them. After generating code with a script,
    read the line back and verify.
12. **Screenshot probes**: `herdr-app shot file.png` captures the window even
    when covered; but dialogs that auto-close need the shot taken quickly,
    and `mod.open` on an already-open dialog is a no-op (close it first).
    For data instead of pixels, have a probe mod `writeTextFile` a report to
    disk and read it here.
13. **Undefined identifiers in render paths are invisible to `check`.** A
    reference error (a `folder` variable out of scope, `v_flex` not
    imported) is a *runtime* failure: `node --check` and `herdr-app check`
    both pass, then the panel dies with "view could not be re-rendered" and
    the console line names file+line only in the toast. After touching a
    render path, grep every external identifier you used against the
    file's imports — twice now this cost a round trip (`my-menu`'s `folder`,
    `diff.js`'s `v_flex`).
14. **`readTextFile` throws on binary files** ("stream did not contain valid
    UTF-8") — it does not return null. Anything that reads an arbitrary
    file (diff views, viewers) must check the extension first or catch.
15. **Images: the display pipeline.** GPUI's `image()` takes app-relative
    paths only, and this runtime cannot move binary bytes between files:
    `fs.writeFile` with a Uint8Array/Buffer writes **0 bytes** (only strings
    go through), `readTextFile` throws on binary, `fs.copyFile` does not
    exist. The working pattern (Files viewer + Changes diff): node
    `fs.readFile` the bytes -> base64 with `btoa` over 32k chunks ->
    `<svg><image xlink:href="data:...;base64,..."/></svg>` written as a
    **text** file under `data/<mod>/` -> `image()` renders the SVG. Two
    traps inside the trap: an SVG without explicit width/height has a
    300x150 default viewport (parse the real size from the file header —
    PNG IHDR, GIF, BMP, JPEG SOF), and **the renderer caches decoded images
    per path** — regenerating the same filename keeps the stale size, so
    put the byte length in the filename (content-addressed) to bust it.

## Testing rules

- `herdr-app check <mod folder>` before anything; it catches syntax and
  init-time errors but **not** render-path or interaction bugs — always
  verify the real surface with a screenshot or a probe.
- Never claim a click flow works without clicking it (the user tests
  interactions; be explicit about what was and wasn't verified).
- For repos: `git -C <repo> status --porcelain` first; create scratch
  changes only with a restore plan, and restore them.

## House rules

- The user's language is Spanish; reply in Spanish, keep code/comments in
  English (matches upstream).
- Nothing here is deployed silently to others: it is a personal fork.
  Keep `LICENSE`, `NOTICE`, `THIRD_PARTY.md` intact (Apache-2.0 + MIT
  credits to munza and to the user's own changes-ai).
- The user's `herdr-git-changes-ai` repo is the standalone upstream of the
  AI button — cross-linked from both READMEs; keep both sides current when
  the button changes.
- Windows 11 ARM64, PowerShell 7, Git for Windows, Zed under
  `%LOCALAPPDATA%\Programs\Zed` (its `zed` on PATH is a bash shim — use
  `bin\Zed.exe`). Herdr 0.1.16; mods upstream targeted 0.1.13 and pass.
