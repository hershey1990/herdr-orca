// What runs in a terminal, how to stop it, and how to start it again.
import { hc, exec, home, readTextFile } from "herdr";
import * as fs from "fs/promises";

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "pwsh", "login"]);
const base = (s) => String(s ?? "").split("/").pop().replace(/^-/, "");
const isShell = (s) => SHELLS.has(base(s));
export const machineOf = (address) => (String(address).includes("/") ? String(address).split("/")[0] : null);

const homes = new Map();
async function homeOn(on) {
  if (!on) return home();
  if (!homes.has(on)) {
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on });
    if (r.code !== 0 || !r.stdout) throw new Error(`no home on ${on}`);
    homes.set(on, r.stdout);
  }
  return homes.get(on);
}

export async function get(address) {
  const r = await hc(["get", "--json", address]).catch(() => null);
  if (!r || r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

export async function list() {
  const r = await hc(["ls", "--json"]).catch(() => null);
  try {
    return JSON.parse(r?.stdout ?? "").terminals ?? [];
  } catch {
    return [];
  }
}

// The program running in a terminal now, or null for an idle shell.
export function program(g) {
  const f = g?.foreground;
  if (!f || g.state !== "live") return null;
  if (f.pid === g.pid && isShell(f.argv?.[0] ?? f.name)) return null;
  return f;
}

export const idleShell = (g) => g?.state === "live" && !!g.foreground && program(g) === null;

function kind(g, f) {
  const app = g.status?.app;
  const b = base(f.argv?.[0]);
  if (app === "claude-code" || b === "claude") return "claude";
  if (app === "codex" || b === "codex") return "codex";
  if (app === "github-copilot" || b === "copilot") return "copilot";
  if (app === "opencode" || b === "opencode") return "opencode";
  if (b === "omp" || b === "pi" || app === "omp" || app === "pi") return "omp";
  return "program";
}

// The session id to resume with, per kind; null when the tool keeps none.
// claude and codex read their own pid-keyed state files (cheap); the rest
// go through the pid cache so their process cost is paid once per agent,
// not once per 30s pass.
async function sessionFor(k, f, cwd, on) {
  if (k === "claude") return claudeSession(f.pid, on);
  if (k === "codex") return codexSession(f.pid, on);
  const key = `${cwd}|${(f.argv ?? []).join(" ")}`;
  if (k === "copilot") return cachedSession(key, f.pid, cwd, (c) => copilotSession(c, on));
  if (k === "opencode") return cachedSession(key, f.pid, cwd, (c) => opencodeSession(c, on));
  if (k === "omp") return cachedSession(key, f.pid, cwd, (c) => ompSession(c, on));
  return null;
}

async function claudeSession(pid, on) {
  const text = await readTextFile(`${await homeOn(on)}/.claude/sessions/${pid}.json`, { on }).catch(() => null);
  try {
    return text ? JSON.parse(text).sessionId ?? null : null;
  } catch {
    return null;
  }
}

// Codex keeps its rollout file open; its name ends with the session id.
async function codexSession(pid, on) {
  const kids = await exec("pgrep", ["-P", String(pid)], { on }).catch(() => null);
  const pids = [String(pid), ...(kids?.stdout ?? "").split(/\s+/).filter(Boolean)];
  const r = await exec("lsof", ["-p", pids.join(","), "-Fn"], { on }).catch(() => null);
  const m = (r?.stdout ?? "").match(/rollout-[^\n]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/);
  return m ? m[1] : null;
}

// omp (and pi, which shares its storage): the newest session file for the
// terminal's folder. Sessions live at ~/.omp/agent/sessions/<slug>/<file>.jsonl
// where <slug> encodes the cwd: the home prefix stripped (else the drive
// letter), separators turned to dashes, "-" for the bare home.
function ompSlug(cwd, home) {
  let p = `${cwd}`.replaceAll("/", "\\");
  const h = `${home}`.replaceAll("/", "\\");
  if (p.toLowerCase().startsWith(h.toLowerCase())) p = p.slice(h.length);
  else p = p.replace(/^[A-Za-z]:/, "");
  p = p.replaceAll(/[:\\/]/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return p ? `-${p}` : "-";
}

async function ompSession(cwd, on) {
  const home = await homeOn(on);
  const dir = `${home.replaceAll("\\", "/")}/.omp/agent/sessions/${ompSlug(cwd, home)}`;
  // readdir is in-process: no PowerShell per agent per pass.
  const files = await fs.readdir(dir).catch(() => null);
  if (!files) return null;
  const jsonl = files.filter((f) => f.endsWith(".jsonl")).sort().at(-1);
  if (!jsonl) return null;
  const text = await readTextFile(`${dir}/${jsonl}`, { on }).catch(() => null);
  const line = text?.split("\n").find((l) => l.includes('"type":"session"'));
  try {
    const rec = line && JSON.parse(line);
    return rec?.id ?? null;
  } catch {
    return null;
  }
}

// OpenCode: its own CLI lists sessions for the current project, newest
// first, with the directory they ran in — no sqlite3 needed.
async function opencodeSession(cwd, on) {
  const r = await exec("opencode", ["session", "list", "--format", "json", "-n", "20"], { cwd, on, timeout: 20000 }).catch(() => null);
  try {
    const rows = JSON.parse(r?.stdout ?? "[]");
    const want = `${cwd}`.replaceAll("\\", "/").toLowerCase();
    const hit = rows.find((s) => `${s.directory ?? ""}`.replaceAll("\\", "/").toLowerCase() === want);
    return hit?.id ?? null;
  } catch {
    return null;
  }
}

// GitHub Copilot CLI: ~/.copilot/open-sessions-state.json names the sessions
// the person has open; the newest openedAt is the one a reboot interrupts.
// (Its chats tree does not record the cwd per session, so per-folder matching
// is not possible yet; resume itself accepts the id: copilot --resume=<id>.)
async function copilotSession(cwd, on) {
  const text = await readTextFile(`${await homeOn(on)}/.copilot/open-sessions-state.json`, { on }).catch(() => null);
  try {
    const opened = text && JSON.parse(text);
    const ids = Object.entries(opened ?? {})
      .sort((a, b) => String(b[1]?.openedAt ?? "").localeCompare(String(a[1]?.openedAt ?? "")));
    return ids[0]?.[0] ?? null;
  } catch {
    return null;
  }
}

// Session ids cost a process (PowerShell, an entire CLI) per agent; cache
// them by pid+cwd+argv so a running agent is looked up once, not on every
// 30s pass. A new pid (restart, resume) is a fresh lookup.
const sessionCache = new Map();

async function cachedSession(key, pid, cwd, lookup) {
  const hit = sessionCache.get(pid);
  if (hit && hit.key === key) return hit.session;
  const session = await lookup(cwd);
  sessionCache.set(pid, { key, session });
  return session;
}

// A snapshot entry for a terminal, or null when it runs nothing.
export async function describe(g) {
  const f = program(g);
  if (!f) return null;
  const k = kind(g, f);
  const on = machineOf(g.address);
  const cwd = f.cwd || g.cwd;
  const session = await sessionFor(k, f, cwd, on);
  return {
    address: g.address,
    shellPid: g.pid,
    argv: f.argv ?? [],
    cwd,
    kind: k,
    session,
    name: k === "claude" ? "Claude Code" : k === "codex" ? "Codex" : k === "copilot" ? "Copilot" : k === "opencode" ? "OpenCode" : k === "omp" ? "omp" : base(f.argv?.[0]) || f.name,
    status: g.status?.state ?? null,
    space: g.labels?.["herdr.space"] ?? null,
    tab: g.labels?.["herdr.tab"] ?? null,
    parent: g.parent ?? null,
  };
}

// Flags worth carrying over to a resumed agent.
const KEEP = {
  claude: { flags: ["--dangerously-skip-permissions", "--verbose"], valued: ["--model", "--permission-mode", "--add-dir", "--agent"] },
  codex: { flags: ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--search"], valued: ["--model", "-m", "--profile", "-p", "--sandbox", "-s"] },
  copilot: { flags: ["--allow-all"], valued: ["--model", "-m", "--agent"] },
  opencode: { flags: [], valued: ["--model", "-m", "--agent"] },
  omp: { flags: [], valued: ["--model", "-m", "--profile", "--plan", "--slow"] },
};

function kept(argv, k) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (KEEP[k].flags.includes(argv[i])) out.push(argv[i]);
    else if (KEEP[k].valued.includes(argv[i]) && i + 1 < argv.length) out.push(argv[i], argv[++i]);
  }
  return out;
}

export function resumeArgv(e) {
  if (e.kind === "claude") return e.session ? ["claude", ...kept(e.argv, "claude"), "--resume", e.session] : e.argv;
  if (e.kind === "codex") return ["codex", "resume", "--no-daemon", ...kept(e.argv, "codex"), e.session ?? "--last"];
  if (e.kind === "copilot") return e.session ? ["copilot", ...kept(e.argv, "copilot"), "--resume", e.session] : e.argv;
  if (e.kind === "opencode") return e.session ? ["opencode", ...kept(e.argv, "opencode"), "--session", e.session] : e.argv;
  if (e.kind === "omp") return e.session ? ["omp", ...kept(e.argv, "omp"), "--resume", e.session] : e.argv;
  return e.argv;
}

const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
export const commandLine = (e) => `cd ${q(e.cwd)} && ${resumeArgv(e).map(q).join(" ")}`;

// A send from another machine reaches a shell that once ran an agent as a tagged message
// (`<hc from=...>`), which the shell can't run: so a remote terminal is typed into from its own machine.
function send(address, text) {
  const on = machineOf(address);
  return on ? exec("hc", ["send", address.slice(on.length + 1), text], { on }) : hc(["send", address, text]);
}

const missing = async (address) => {
  const r = await hc(["get", "--json", address]).catch(() => null);
  return !!r && r.code !== 0 && /"kind":\s*"not_found"/.test(`${r.stdout}${r.stderr}`);
};

// Starts an entry again in its idle shell; never types into a busy one.
export async function start(e) {
  const g = await get(e.address);
  // A failed lookup (machine unreachable) isn't a gone terminal: leave it for the next wake.
  if (!g && !(await missing(e.address))) return false;
  let address = e.address;
  if (!g || g.state !== "live") {
    if (!e.space || !e.tab) return false;
    // Its terminal is gone: a new shell in the same tab.
    const on = machineOf(e.address);
    const r = await hc(["run", "--json", "--bg", "--keep", "--no-parent", ...(on ? ["--on", on] : []), "--cwd", e.cwd, "--label", `herdr.space=${e.space}`, "--label", `herdr.tab=${e.tab}`]).catch(() => null);
    try {
      address = JSON.parse(r?.stdout ?? "").address;
    } catch {
      return false;
    }
    if (!address) return false;
    // A retry types into this shell instead of opening another.
    e.address = address;
  } else if (!idleShell(g)) return false;
  const r = await send(address, commandLine(e)).catch(() => null);
  return r?.code === 0;
}

async function waitIdle(cx, address, ms) {
  for (let left = ms; left > 0; left -= 400) {
    await cx.sleep(400);
    const g = await get(address);
    if (g && (g.state !== "live" || idleShell(g))) return true;
  }
  return false;
}

// SIGTERM to the program's process group: ctrl+c (SIGINT) makes Herdr's launcher
// shell (zsh -lic '"$@"; exec "$0" -li') abort instead of returning to its prompt.
async function term(address) {
  const g = await get(address);
  const f = program(g);
  if (!f || f.pid === g.pid) return;
  const on = machineOf(address);
  const r = await exec("kill", ["-TERM", `-${f.pid}`], { on }).catch(() => null);
  if (r?.code !== 0) await exec("kill", ["-TERM", String(f.pid)], { on }).catch(() => null);
}

// Stops what runs in a terminal and leaves its shell in place.
export async function stop(cx, e) {
  const exitKey = { claude: "/exit", codex: "/quit", copilot: "/exit", opencode: "/exit", omp: "/exit" }[e.kind];
  if (exitKey) {
    if (e.status === "working" || e.status === "blocked") await hc(["interrupt", e.address, "--timeout", "5"]).catch(() => null);
    // Pressed as keys: a send from another machine reaches an agent as a tagged message, not a command.
    await hc(["keys", e.address, exitKey, "enter"]).catch(() => null);
    if (await waitIdle(cx, e.address, 10000)) return true;
  }
  await term(e.address);
  if (await waitIdle(cx, e.address, 5000)) return true;
  const g = await get(e.address);
  const f = program(g);
  if (f && f.pid !== g.pid) await exec("kill", ["-KILL", `-${f.pid}`], { on: machineOf(e.address) }).catch(() => null);
  return waitIdle(cx, e.address, 3000);
}
