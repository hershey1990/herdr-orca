// Locating Zed on this computer, shared by the launcher (open-zed) and the
// + menu row (my-new-menu). Keep this file identical in both mods, as with
// project-settings' hooks.js.
import { exec } from "herdr";
import { window as appWindow } from "herdr";

// A single-quoted PowerShell string.
const ps = (s) => `'${s.replaceAll("'", "''")}'`;

// Zed's install roots, newest layout first. LOCALAPPDATA is read inside
// PowerShell: mods have no process.env. `bin\Zed.exe` is the relay CLI; the
// root `Zed.exe` is the GUI (launching it waits forever, so it is only a
// last resort). `zed.exe` on PATH is the last check: the shipped shim is a
// bash script that fails elsewhere, but some setups have a real one.
const PROBE = [
  `$roots = @("$env:LOCALAPPDATA\\Programs\\Zed", "$env:ProgramFiles\\Zed");`,
  `foreach ($r in $roots) { $p = Join-Path $r 'bin\\Zed.exe'; if (Test-Path $p) { Write-Output $p; exit 0 } }`,
  `foreach ($r in $roots) { $p = Join-Path $r 'Zed.exe'; if (Test-Path $p) { Write-Output $p; exit 0 } }`,
  `$c = Get-Command zed.exe -ErrorAction SilentlyContinue; if ($c) { Write-Output $c.Source; exit 0 }`,
  `$c = Get-Command zed -CommandType Application -ErrorAction SilentlyContinue; if ($c -and $c.Source -notlike '*.sh') { Write-Output $c.Source; exit 0 }`,
  `exit 1`,
].join(" ");

// Returns the absolute path of the relay CLI to launch, or null when Zed is
// not installed on this computer.
export async function zedCommand() {
  if (appWindow()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", PROBE], { timeout: 15000 });
    const found = r.stdout.trim();
    return r.code === 0 && found ? found : null;
  }
  const r = await exec("zed", ["--version"]).catch(() => null);
  return r?.code === 0 ? "zed" : null;
}

export { ps };
