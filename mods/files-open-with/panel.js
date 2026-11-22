// Herdr's shipped Files panel (Herdr 0.1.11, Apache-2.0), plus a right-click menu
// that opens the clicked file or folder in your own apps. See menu.js and items.js.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, openOverlay } from "herdr";
import { openFile } from "./tabs.js";
import { syntaxColors, languageFor } from "./syntax.js";
import { available, menuHeight } from "./items.js";
import ICONS from "./icons.js";

const norm = p => `${p}`.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
const inside = (p, base) => { const a = norm(p), b = norm(base); return a === b || a.startsWith(`${b}/`); };

const PER_FOLDER = 500, TOTAL = 5000;

// Material icons: icons.js is a copy of file-icons' table; the SVGs stay in that mod.
const ICON_DIR = "mods/file-icons/icons";
const bare = name => name.replace(/^__(.+)__$/, "$1").replace(/^[._-]/, "");
const opened = id => id.endsWith("_light") ? `${id.slice(0, -6)}-open_light` : `${id}-open`;
function lookup(table, key, dark) { return (dark ? undefined : ICONS.light[table][key]) ?? ICONS[table][key]; }
function icon(path, dir, open, dark) {
  const parts = path.toLowerCase().split("/"), name = parts[parts.length - 1];
  const table = dir ? "folderNames" : "fileNames", find = key => lookup(table, key, dark) ?? (dir ? lookup(table, bare(key), dark) : undefined);
  let id;
  for (let i = 0; !id && i < parts.length - 1; i++) id = find(parts.slice(i).join("/"));
  if (dir) {
    id ??= find(name) ?? ICONS.folder;
    return `${ICON_DIR}/${open ? opened(id) : id}.svg`;
  }
  id ??= lookup(table, name, dark);
  for (let dot = name.indexOf("."); !id && dot !== -1; dot = name.indexOf(".", dot + 1)) id = lookup("fileExtensions", name.slice(dot + 1), dark);
  return `${ICON_DIR}/${id ?? ICONS.file}.svg`;
}

// One process lists the root and every expanded folder of a refresh. Spawning
// PowerShell per folder made the tree crawl: each call pays ~100ms of startup,
// and refresh() ran them one after another. Output is folder records separated
// by NULs: "F", the folder's path relative to the root ("" for the root), then
// a compressed JSON array of {name, dir, link}. A folder that cannot be read
// comes back as null and is skipped; the root failing fails the whole load.
// Statements join with "; " (a bare newline inside -Command collapses), the
// JSON is built into $json first (concatenating @(...) inside a string is a
// parser trap), and PowerShell's NUL is the $([char]0) subexpression.
const LIST_SCRIPT_WINDOWS = [
  '$root = \'__ROOT__\'',
  '$dirs = \'__DIRS__\' | ConvertFrom-Json',
  'foreach ($d in $dirs) {',
  '  $p = $root; if ($d) { $p = Join-Path $root $d }',
  '  $items = $null',
  '  try { $items = @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne \'.git\' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)); link=[bool]($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } }) } catch { $items = $null }',
  '  if ($null -eq $items) { Write-Output ("F$([char]0)$d$([char]0)null$([char]0)") } else { $json = ConvertTo-Json $items -Compress; Write-Output ("F$([char]0)$d$([char]0)$json$([char]0)") }',
  '}',
].join("; ");

const LIST_SCRIPT_SH = [
  'n=0',
  'for d in "$@"; do',
  '  p=${1%/}/$d; [ "$d" = "" ] && p=$1',
  '  printf "F\\0%s\\0" "$d"',
  '  ok=0',
  '  if [ -d "$p" ]; then for f in "$p"/* "$p"/.[!.]* "$p"/..?*; do',
  '    [ -e "$f" ] || [ -L "$f" ] || continue; name=${f##*/}; [ "$name" = .git ] && continue',
  '    if [ -L "$f" ]; then kind=l; elif [ -d "$f" ]; then kind=d; else kind=f; fi',
  '    printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); ok=1; [ "$n" -gt 500 ] && break',
  '  done; fi',
  '  [ "$ok" = 1 ] || printf "null\\0"',
  'done',
  'test -d "$1"',
].join("\n");

// Returns a Map of folder path (relative, "" for the root) to its entries, or
// throws when the root itself cannot be listed. One process for every folder.
async function listFolders(root, paths, on) {
  const folders = paths.map(p => `${p}`.replaceAll("\\", "/"));
  let stdout;
  if (!on && window()?.platform === "windows") {
    const script = LIST_SCRIPT_WINDOWS
      .replace("__ROOT__", root.replaceAll("'", "''"))
      .replace("__DIRS__", JSON.stringify(folders).replaceAll("'", "''"));
    const r = await exec("powershell", ["-NoProfile", "-Command", script], { timeout: 30000 });
    if (r.code !== 0 && !r.stdout.includes("F\0")) throw new Error(r.stderr || "Cannot list this folder");
    stdout = r.stdout;
  } else {
    const r = await exec("sh", ["-c", LIST_SCRIPT_SH, "files", root, ...folders], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    stdout = r.stdout;
  }
  const out = parseFolderRecords(stdout);
  // Every requested folder needs a record; only a requested-and-failed root
  // fails the call (loadFolder asks for one subfolder, refresh asks for the
  // root plus every expanded folder).
  for (const p of paths) if (!out.has(p)) throw new Error("Cannot list this folder");
  if (out.get("") === null) throw new Error("Cannot list this folder");
  return out;
}

function parseFolderRecords(stdout) {
  // PowerShell separates Write-Output calls with \r\n, which would prefix
  // every record after the first with a stray line break; raw CRLF cannot
  // occur inside a record (JSON escapes it), so strip it before splitting.
  const fields = stdout.replace(/\r\n/g, "").split("\0"), out = new Map();
  for (let i = 0; i + 2 < fields.length; i += 1) {
    if (fields[i] !== "F") continue;
    const folder = fields[i + 1];
    let entries = [];
    try {
      const parsed = JSON.parse(fields[i + 2] || "[]");
      if (parsed === null) { out.set(folder, null); continue; }
      entries = Array.isArray(parsed) ? parsed : [parsed];
    } catch { out.set(folder, null); continue; }
    out.set(folder, entries);
  }
  return out;
}

// A plain class: main.js (the View) owns it and forwards init and render.
export default class Panel {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.ignored = new Set();
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  // Where the tree is rooted, and what it follows. The space's folder anchors
  // the tree: a focused pane outside the project (an agent started in C:\, a
  // pane with no folder) must not drag the tree to the OS root. A pane inside
  // the project still leads, so cd-ing around follows as before. A space
  // without a folder keeps whatever root the panel already showed, and only a
  // pane inside that root may move it; the first load takes the focused
  // pane's folder when it is not obviously an OS root.
  location() {
    const space = spaces().find(s => s.active), f = focused();
    const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
    const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
    // A mod pane has no cwd of its own; focused() then reports the app's own
    // working folder (often the home), which is not a project root. Only a
    // terminal pane's folder may lead the tree.
    const paneCwd = pane ? (pane.terminal ? pane.cwd || f?.cwd || null : null) : f?.cwd || null;
    // The panel's own root outranks the space's folder within one space: a
    // space an agent created from the home reports folder = home, and the
    // tree must not jump there when a viewer pane takes the keyboard. On a
    // space switch the stale root is dropped (sameSpace fails) and the
    // space's folder anchors fresh.
    const sameSpace = space?.id === this.context?.space;
    const base = (sameSpace && this.root) || space?.folder || this.root || null;
    const cwd = base ? (paneCwd && inside(paneCwd, base) ? paneCwd : base) : paneCwd;
    return { cwd, on, space: space?.id };
  }

  key() {
    return JSON.stringify(this.location());
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && this.key() === context.key;
  }

  // Load one folder's entries into the panel state, pruning to the totals.
  store(folder, context, entries) {
    if (!this.current(context) || (folder && !this.folders.has(folder))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== folder).reduce((n, [, e]) => n + e.length, 0);
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
    this.entries.set(folder, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await listFolders(root, [path], on).then(m => m.get(path));
    this.store(path, context, entries ?? []);
  }

  refresh(cx) {
    const { cwd, on } = this.location(), next = this.key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      const space = spaces().find(s => s.active);
      this.context = { key: next, cwd, on, space: space?.id }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.ignored = new Set(); this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        const listing = await listFolders(cwd, ["", ...this.folders], on);
        if (!this.current(context)) return;
        this.limited = false;
        for (const [folder, entries] of listing) {
          if (folder !== "" && !this.folders.has(folder)) continue;
          this.store(folder, context, entries ?? []);
          if (entries === null && folder === "") throw new Error("Cannot list this folder");
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {}, ignored = new Set();
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal", "--ignored"], { cwd, on }).catch(() => null);
          let count = 0;
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean)) {
            const xy = entry.slice(0, 2), file = `${top.stdout.trim()}/${entry.slice(3)}`;
            // "!!": ignored; a wholly ignored folder comes as one "dir/" entry.
            if (xy === "!!") { ignored.add(file.replace(/\/$/, "")); continue; }
            if (count++ >= TOTAL) continue;
            marks[file] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.ignored = ignored; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const syntax = await syntaxColors();
        if (this.file !== path || !this.current(context)) return;
        this.code = EditorState.new({ language: languageFor(path), readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // A file opens in its own tab of this space (viewer.js), reused if already open.
  openTab(path, cx) {
    openFile({ file: `${this.root}/${path}`, on: this.on, space: this.location().space }, cx);
  }

  // Right-click: which items apply (installed apps only), then the popup at the pointer.
  menu(path, dir, cx) {
    if (window()?.platform !== "macos") return;
    const target = { path, dir, on: this.on };
    cx.spawn(async () => {
      const items = await available(target);
      if (!items.length) return;
      openOverlay({ mod: "files-open-with", kind: "popup", width: 240, height: menuHeight(items.length), props: { role: "menu", ...target, items } });
    });
  }

  // Ignored by git, itself or through a folder above it. Git reports the
  // toplevel with forward slashes while the space folder carries Windows
  // backslashes — normalize both sides or the Set never matches.
  isIgnored(path) {
    for (let p = path; p; p = p.slice(0, Math.max(0, p.lastIndexOf("/"))))
      if (this.ignored.has(`${this.root}/${p}`.replaceAll("\\", "/"))) return true;
    return false;
  }

  rows(prefix, depth, out, t, dark) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(this.isIgnored(path), el => el.opacity(0.5))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.openTab(path, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(`${this.root}/${path}`, entry.dir, cx); })
        .child(entry.dir ? svg(`mods/files-open-with/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(icon(path, entry.dir, open, dark)).size(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(entry.link), el => el.child(svg("mods/files-open-with/link.svg").size(12).flex_none().text_color(t.dim)))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t, dark);
    }
    return out;
  }

  render(cx) {
    if (this.key() !== this.context?.key) this.refresh(cx);
    const t = theme(), dark = Boolean(settings().dark);
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().id("files-current").flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim)
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (this.root) this.menu(this.file ? `${this.root}/${this.file}` : this.root, !this.file, cx); })
          .child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t, dark))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
