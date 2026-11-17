// Opens the focused terminal's folder in this computer's Zed. Local folders
// only: Zed has no remote-ssh story like VS Code's, so a folder on another
// machine is refused with a clear message instead of opening the wrong thing.
//
// Run it with `mod.open {name: "open-zed"}`: from a key, or a menu row.
// Windows note: `zed` on PATH is a bash shim that fails outside its own
// folder; the installed binary this mod launches is `Zed.exe` beside it.
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { closeOverlay, exec, focused, home, spaces, theme, window as appWindow } from "herdr";

// Locations the Zed installer uses, relative to the profile root. The CLI on
// PATH is a bash shim that cannot run from another cwd, so look for the real
// files: `bin\Zed.exe` is the relay CLI; the root `Zed.exe` is the GUI.
const WINDOWS_CANDIDATES = [
  "AppData/Local/Programs/Zed/bin/Zed.exe",
  "AppData/Local/Programs/Zed/Zed.exe",
  "Program Files/Zed/bin/Zed.exe",
  "Program Files/Zed/Zed.exe",
];

// A single-quoted PowerShell string.
const ps = (s) => `'${s.replaceAll("'", "''")}'`;

async function zedCommand() {
  if (appWindow()?.platform === "windows") {
    const userHome = home().replace(/\\/g, "/");
    for (const rel of WINDOWS_CANDIDATES) {
      const exe = `${userHome}/${rel}`;
      const r = await exec("powershell", ["-NoProfile", "-Command", `Test-Path '${ps(exe)}'`]);
      if (r.code === 0 && r.stdout.trim() === "True") return exe;
    }
    return null;
  }
  const r = await exec("zed", ["--version"]).catch(() => null);
  return r?.code === 0 ? "zed" : null;
}

async function launch(folder) {
  const zed = await zedCommand();
  if (!zed) throw new Error("Zed was not found. Install it from https://zed.dev, or reopen this menu once it is on PATH.");
  if (appWindow()?.platform === "windows") {
    // Start-Process never waits: Zed's relay blocks for seconds on a cold
    // start (first launch of the day), and the GUI exe blocks for good.
    const r = await exec("powershell", ["-NoProfile", "-Command", `Start-Process -FilePath '${ps(zed)}' -ArgumentList '${ps(folder)}'`], { timeout: 15000 });
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
