// A file in its own tab, opened by panel.js with props { role: "viewer", file (absolute), on }.
// Markdown renders formatted (Source toggles to text). ✎ Edit turns the code
// view into a basic editor: save with the button or ctrl+s, ● modified when
// the buffer differs from the file. Open-in-editor stays one click away for
// real editing.
import { div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, readTextFile, writeTextFile, watchFolder, theme, settings, focused, spaces, openOverlay } from "herdr";
import { openFile } from "./tabs.js";
import { available } from "./items.js";
import { syntaxColors, languageFor } from "./syntax.js";

const LIMIT = 400000;
const isMarkdown = path => /\.(md|markdown|mdx)$/i.test(path ?? "");
const dirname = path => path.slice(0, path.lastIndexOf("/")) || "/";

// A relative or absolute link, resolved against the current file's folder.
function resolve(file, href) {
  let p;
  try { p = decodeURIComponent(href.split("#")[0]); } catch { return null; }
  if (!p) return null;
  const parts = [];
  for (const s of (p.startsWith("/") ? p : `${dirname(file)}/${p}`).split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") parts.pop(); else parts.push(s);
  }
  return "/" + parts.join("/");
}

// A plain class: main.js (the View) owns it and forwards init, render and close.
export default class Viewer {
  init(_props, cx) {
    const p = props() ?? {};
    this.on = p.on ?? null;
    this.file = p.file; this.source = false;
    this.editing = false; this.dirty = false; this.saving = false; this.saveError = null;
    if (!this.file) { this.error = "No file to show"; return; }
    this.load(cx);
    this.watch(cx);
  }

  // The state is rebuilt between modes: readonly is set at creation only.
  makeState(text, readonly) {
    return EditorState.new({ language: languageFor(this.file), readonly, value: text,
      font_family: settings().font_family, font_size: 12,
      syntax: this.syntax });
  }

  load(cx) {
    const file = this.file;
    cx.spawn(async cx => {
      try {
        const raw = await readTextFile(file, { on: this.on });
        if (this.closed || this.file !== file) return;
        if (raw === null) { this.error = "This file is no longer available"; return; }
        if (raw.includes("\0")) { this.error = "Binary file · no text preview"; return; }
        const text = raw.length > LIMIT ? raw.slice(0, LIMIT) + "\n… (file truncated)" : raw;
        // Editing holds the buffer: an external change does not clobber it.
        if (this.editing && this.code) { this.diskText = text; this.markDirty(); return; }
        if (this.code && text === this.text) return;
        const syntax = await syntaxColors();
        if (this.closed || this.file !== file) return;
        this.syntax = syntax;
        this.code?.release();
        this.text = text; this.error = null;
        this.code = this.makeState(text, !this.editing);
        this.code.on("change", () => this.dirty = this.code.value() !== this.text);
      } catch { if (this.file === file) this.error = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { if (!this.closed) cx.notify(); }
    });
  }

  // Local files reload when saved elsewhere; watchFolder only works on this machine.
  watch(cx) {
    if (this.on) return;
    const dir = dirname(this.file);
    if (this.watching === dir) return;
    this.watching = dir;
    cx.spawn(async cx => {
      try {
        while (!this.closed && this.watching === dir) {
          const changed = await watchFolder(dir);
          if (this.closed || this.watching !== dir) return;
          if (changed.some(c => c.endsWith(this.file) || this.file.startsWith(c + "/"))) this.load(cx);
        }
      } catch { if (this.watching === dir) this.watching = null; }
    });
  }

  // Linked files open in their own tab, like clicks in the Files panel.
  followLink(url, cx) {
    if (/^(https?|mailto):/i.test(url)) return cx.open_url(url);
    const next = resolve(this.file, url);
    if (!next || next === this.file) return;
    const space = focused()?.space ?? spaces().find(s => s.active)?.id;
    openFile({ file: next, on: this.on, space }, cx);
  }

  // ✎ Edit: rebuild the state writable and keep the scroll/selection as
  // close as the rebuild allows (value is preserved; cursor goes to 0).
  startEdit(cx) {
    if (!this.code || this.saving) return;
    this.editing = true;
    const value = this.code.value();
    this.code?.release();
    this.code = this.makeState(value, false);
    this.code.on("change", () => this.markDirty());
    this.code.focus();
    cx.notify();
  }

  markDirty() {
    const now = this.code ? this.code.value() !== (this.editing ? this.editBase : this.text) : false;
    if (now !== this.dirty) this.dirty = now;
    return this.dirty;
  }

  // Back to read-only. Offers to keep going when the buffer is dirty.
  doneEdit(cx) {
    if (this.saving) return;
    this.editing = false;
    const value = this.code ? this.code.value() : this.text;
    this.code?.release();
    this.code = this.makeState(this.text, true);
    this.dirty = false;
    cx.notify();
  }

  // Atomic write through Herdr: expected guards against clobbering a file
  // that changed on disk while we edited; the watcher reloads after.
  save(cx) {
    if (!this.editing || !this.code || this.saving) return;
    const value = this.code.value();
    this.saving = true; this.saveError = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        await writeTextFile(this.file, value, this.diskText ?? this.text);
        this.saving = false; this.dirty = false;
        this.editBase = value;
        cx.notify();
      } catch (e) {
        this.saving = false;
        this.saveError = `Save failed: ${String(e).slice(0, 200)}`;
        cx.notify();
      }
    });
  }

  // Send the file to a real editor: the same popup the Files panel's
  // right-click uses. available() runs before opening — props() is a
  // snapshot, the menu cannot fetch its own items.
  openIn(cx) {
    if (!this.file) return;
    cx.spawn(async cx => {
      const items = await available({ path: this.file, dir: false, on: this.on });
      if (!items.length) { this.saveError = "No editor app found for this file"; cx.notify(); return; }
      openOverlay({ mod: "files-open-with", kind: "popup", width: 240, height: 26 + items.length * 31,
        props: { role: "menu", path: this.file, dir: false, on: this.on, items } });
    });
  }

  body(t) {
    if (!this.code) return div().p(16).text_color(t.dim).child(this.error || "Loading file…");
    if (!isMarkdown(this.file) || this.source) return Editor.new(this.code).flex_1().min_h(0);
    return v_flex().id(`fow-md-${this.file}`).flex_1().min_h(0).overflow_y_scrollbar().px(24).py(16)
      .child(TextView.markdown(`fow-md-view-${this.file}`, this.text).selectable(true).scrollable(false).w_full()
        .text_size(14).text_color(t.foreground).on_link_click((url, cx) => this.followLink(url, cx)));
  }

  button(id, label, t, action) {
    return div().id(id).flex_none().px(8).h(24).flex().items_center().rounded(6).text_size(12).text_color(t.muted)
      .cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => action(cx)).child(label);
  }

  render(cx) {
    const t = theme();
    const editable = Boolean(this.code) && !this.on; // remote files are read-only here
    return v_flex().id("fow-viewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        // ctrl+s (cmd+s on macOS) saves in edit mode; the program never
        // sees this view. The platform modifier is always spelled cmd.
        if (this.editing && (e.keystroke === "cmd-s")) {
          cx.stop_propagation();
          this.save(cx);
        }
      })
      .child(h_flex().h(36).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.file ?? ""))
        .when(this.dirty, el => el.child(div().id("fow-dirty").flex_none().text_size(12).text_color(t.ansi3).child("● modified")))
        .when(isMarkdown(this.file) && Boolean(this.code), el => el.child(this.button("fow-mode", this.source ? "Preview" : "Source", t,
          cx => { this.source = !this.source; cx.notify(); })))
        .when(editable && !this.editing, el => el.child(this.button("fow-edit", "✎ Edit", t, cx => this.startEdit(cx))))
        .when(this.editing, el => el
          .child(this.button("fow-save", this.saving ? "Saving…" : "Save", t, cx => this.save(cx)))
          .child(this.button("fow-done", "Done", t, cx => this.doneEdit(cx))))
        .when(Boolean(this.code), el => el.child(this.button("fow-open-in", "Open in editor…", t, cx => this.openIn(cx)))))
      .when(Boolean(this.saveError), el => el.child(div().flex_none().px(10).py(4).text_size(11).text_color(t.ansi1).whitespace_normal().child(this.saveError ?? "")))
      .child(this.body(t));
  }

  close() {
    this.closed = true;
    this.code?.release(); this.code = null;
  }
}
