// A file in its own tab, opened by panel.js with props { role: "viewer", file (absolute), on }.
// Markdown renders formatted (Source toggles to text). ✎ Edit turns the code
// view into a basic editor: save with the button or ctrl+s, ● modified when
// the buffer differs from the file. Open-in-editor stays one click away for
// real editing.
import { div, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, readTextFile, writeTextFile, watchFolder, theme, settings, focused, spaces, openOverlay, appHome } from "herdr";
import * as fs from "fs/promises";
import { openFile } from "./tabs.js";
import { available } from "./items.js";
import { syntaxColors, languageFor } from "./syntax.js";

const LIMIT = 400000;
const isMarkdown = path => /\.(md|markdown|mdx)$/i.test(path ?? "");
// Intrinsic size from the file header, so the SVG viewport matches the image
// (an SVG without width/height defaults to 300x150 and pictures render tiny).
function imageSize(b) {
  const be32 = (o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const le32 = (o) => ((b[o]) + (b[o + 1] << 8) + (b[o + 2] << 16) + ((b[o + 3] << 24) >>> 0)) >>> 0;
  const le16 = (o) => b[o] + (b[o + 1] << 8);
  const be16 = (o) => (b[o] << 8) + b[o + 1];
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: be32(16), h: be32(20) };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: le16(6), h: le16(8) };
  if (b[0] === 0x42 && b[1] === 0x4d) return { w: le32(18), h: Math.abs((b[22] << 24 >> 24)) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o += 1; continue; }
      const m = b[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: be16(o + 5), w: be16(o + 7) };
      o += 2 + be16(o + 2);
    }
  }
  return null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
const isImage = path => IMAGE_EXT.test(path ?? "");
const isSvg = path => /\.svg$/i.test(path ?? "");

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
    this.file = p.file; this.source = false; this.imagePath = null;
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

  // Images render in place: GPUI's image() takes app-relative paths, so the
  // file is copied into the app's data folder once (per mtime) and shown.
  // SVGs ship as-is (text-safe, no copy needed is false — they are binary
  // to readTextFile too, so same copy). Remote machines: not copied, the
  // old binary message stands.
  // Images render through an SVG wrapper: GPUI's image() loads app-
  // relative files, but the runtime's fs.writeFile only accepts strings
  // (Uint8Array/Buffer writes come out empty) and herdr's readTextFile
  // returns null for binary. So: node fs reads the bytes, they are
  // base64'd (btoa over chunks), embedded as a data URI inside an SVG
  // text file under this mod's data folder, and image() shows that SVG.
  async loadImage(file) {
    const ext = (file.match(IMAGE_EXT)?.[1] ?? "png").toLowerCase();
    const dir = `${appHome().replaceAll("\\\\", "/")}/data/files-open-with`;
    await fs.mkdir(dir, { recursive: true });
    const bin = await fs.readFile(file.replaceAll("\\\\", "/"));
    const name = `img-${file.replaceAll("\\\\", "/").split("/").at(-1).replace(/[^A-Za-z0-9._-]/g, "_")}-${bin.length}.svg`;
    let binary = "";
    for (let i = 0; i < bin.length; i += 0x8000) binary += String.fromCharCode(...bin.subarray(i, i + 0x8000));
    const mime = ext === "jpg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : `image/${ext}`;
    const size = imageSize(bin);
    const dim = size ? ` width="${size.w}" height="${size.h}" viewBox="0 0 ${size.w} ${size.h}"` : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${dim}><image width="100%" height="100%" xlink:href="data:${mime};base64,${btoa(binary)}"/></svg>`;
    await fs.writeFile(`${dir}/${name}`, svg);
    return `data/files-open-with/${name}`;
  }

  load(cx) {
    const file = this.file;
    cx.spawn(async cx => {
      try {
        if (isImage(file) && !isSvg(file) && !this.on) {
          const rel = await this.loadImage(file);
          if (this.closed || this.file !== file) return;
          this.imagePath = rel; this.code?.release(); this.code = null;
          this.error = null; this.editing = false; this.dirty = false;
          cx.notify();
          return;
        }
        this.imagePath = null;
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
      } catch (e) { if (this.file === file) this.error = `Cannot preview this file: ${String(e).slice(0, 160)}`; }
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
    if (this.imagePath)
      return v_flex().flex_1().min_h(0).items_center().justify_center().p(12).overflow_y_scroll()
        .child(image(this.imagePath).max_w_full().max_h_full());
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
