// A folder picker that works where herdr's own pickFolder does not resolve on
// this machine (Windows, herdr.exe x64 under emulation: the native dialog
// never opens and the promise hangs). Runs FolderBrowserDialog in a child
// PowerShell: the dialog appears over whatever is frontmost (TopMost owner),
// the child exits 0 with the chosen path on stdout, 1 on cancel.
// Keep in sync with nothing — better-sidebar and my-new-menu each hold a copy,
// like project-settings' hooks.js.
import { exec, window } from "herdr";

const ps = (s) => `'${s.replaceAll("'", "''")}'`;

export async function pickFolderDialog(prompt) {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$o = New-Object System.Windows.Forms.Form",
    "$o.TopMost = $true",
    "$o.MinimizeBox = $false",
    "$o.MaximizeBox = $false",
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
    ` $f.Description = ${ps(prompt ?? "Choose a folder")}`,
    "$f.ShowNewFolderButton = $true",
    "$r = $f.ShowDialog($o)",
    "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath } else { exit 1 }",
  ].join("; ");
  const r = await exec("powershell", ["-NoProfile", "-STA", "-Command", script], { timeout: 300000 })
    .catch((e) => ({ code: -1, stdout: "", stderr: String(e).slice(0, 200) }));
  const folder = (r.stdout ?? "").trim();
  return r.code === 0 && folder ? folder : null;
}

export { ps };
