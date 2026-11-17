// Opens the focused terminal's folder in this computer's Zed. Local folders
// only: Zed has no remote-ssh story like VS Code's, so a folder on another
// machine is refused with a clear message instead of opening the wrong thing.
//
// Run it with `mod.open {name: "open-zed"}`: from a key, or a menu row.
// Windows note: the `zed` on PATH is a bash shim that fails outside its own
// folder, so zed.js locates the real relay (`bin\Zed.exe`) instead.
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { closeOverlay, exec, focused, props, spaces, theme, window as appWindow } from "herdr";
import { zedCommand, ps } from "./zed.js";

async function launch(folder) {
  const zed = await zedCommand();
  if (!zed) throw new Error("Zed was not found. Install it from https://zed.dev, then try again.");
  if (appWindow()?.platform === "windows") {
    // Start-Process never waits: Zed's relay blocks for seconds on a cold
    // start (first launch of the day), and the GUI exe blocks for good.
    // ps() adds the quotes; adding more yields ''path'', an empty FilePath.
    const r = await exec("powershell", ["-NoProfile", "-Command", `Start-Process -FilePath ${ps(zed)} -ArgumentList ${ps(folder)}`], { timeout: 15000 });
    if (r.code !== 0) throw new Error((r.stderr || `PowerShell exited with ${r.code}`).trim().slice(0, 300));
    return;
  }
  const r = await exec(zed, [folder], { timeout: 15000 }).catch((e) => { throw new Error(String(e).slice(0, 300)); });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `Zed exited with ${r.code}`).trim().slice(0, 300));
}

export default class OpenZed extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    const f = focused();
    const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
    this.folder = f?.cwd || space?.folder || "";
    this.machine = space?.machine ?? null;
    this.error = this.machine ? `This space lives on "${this.machine}". Zed opens local folders only.` : this.folder ? null : "This space has no folder yet.";
    if (this.error) return;
    cx.spawn(async (cx) => {
      try {
        await launch(this.folder);
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = e?.message ?? String(e);
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    return v_flex().id("open-zed").track_focus(this.handle).size_full().p(16).gap(6).justify_center().bg(t.popover).text_size(13)
      .child(div().text_color(this.error ? t.blocked : t.foreground).font_semibold().child(this.error ? "Could not open Zed" : "Opening in Zed…"))
      .child(div().text_size(12).text_color(t.muted).child(this.error ?? this.folder));
  }
}
