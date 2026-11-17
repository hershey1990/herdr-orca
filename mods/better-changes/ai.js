// AI commit-message drafts for the commit box. Ported from the changes-ai mod
// (a clone of Herdr's Changes panel): the providers and prompt are the same.
// Two kinds of provider:
//  - a coding-agent CLI already installed and logged in (no key here), or
//  - a direct HTTP API (deepseek, opencode-go) with "api_key" in config.json.
import { exec, readTextFile, appHome } from "herdr";

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

const AI_DEFAULTS = {
  provider: "auto", // auto | opencode | claude | copilot | codex | gemini | deepseek | opencode-go
  model: "", // optional; empty uses the provider's default
  api_key: "", // direct providers only; config.json is gitignored
  base_url: "", // optional override for direct providers
  language: "English", // language of the generated message
  style: "conventional", // conventional | plain
  max_diff_chars: 16000, // a Windows argv is capped near 32767 characters
  max_output_tokens: 1024, // direct providers: reply budget
  timeout_ms: 180000,
};

// Ordered by how likely they are to work unattended on Windows.
const AI_PROVIDERS = {
  opencode: { args: (prompt, cfg) => ["run", ...(cfg.model ? ["--model", cfg.model] : []), prompt] },
  claude: { args: (prompt) => ["-p", prompt] },
  copilot: { args: (prompt, cfg) => ["-p", prompt, ...(cfg.model ? ["--model", cfg.model] : [])] },
  codex: { args: (prompt, cfg) => ["exec", ...(cfg.model ? ["--model", cfg.model] : []), prompt] },
  gemini: { args: (prompt, cfg) => ["-p", prompt, ...(cfg.model ? ["-m", cfg.model] : [])] },
};
const AI_ORDER = ["opencode", "claude", "copilot", "codex", "gemini"];

// OpenAI-compatible chat-completions endpoints, called with fetch.
const AI_HTTP = {
  deepseek: {
    base_url: "https://api.deepseek.com",
    model: "deepseek-flash",
    keys: "https://platform.deepseek.com/api_keys",
  },
  "opencode-go": {
    base_url: "https://opencode.ai/inference/go/openai/v1",
    model: "deepseek-v4.1-flash",
    keys: "https://opencode.ai/console",
  },
};

function httpProvider(name, cfg) {
  const spec = AI_HTTP[name], base = (cfg.base_url || spec.base_url).replace(/\/+$/, "");
  return {
    kind: "http",
    name,
    model: cfg.model || spec.model,
    url: base.endsWith("/chat/completions") ? base : `${base}/chat/completions`,
    apiKey: String(cfg.api_key || "").trim(),
    keys: spec.keys,
  };
}

async function askHttp(provider, prompt, cfg, session) {
  if (!provider.apiKey) {
    throw new Error(`Set "api_key" in config.json for ${provider.name} (get one at ${provider.keys})`);
  }
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${provider.apiKey}`,
    "user-agent": "herdr-changes-ai/1.0",
  };
  if (provider.name === "opencode-go") headers["x-opencode-session"] = session;
  const body = {
    model: provider.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: Math.min(Math.max(Number(cfg.max_output_tokens) || AI_DEFAULTS.max_output_tokens, 128), 8000),
    temperature: 0.3,
    stream: false,
  };
  let response;
  try {
    response = await fetch(provider.url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`Cannot reach ${provider.name}: ${String(e).slice(0, 200)}`);
  }
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!response.ok) {
    const why = data?.error?.message || data?.message || text;
    const hint = response.status === 401 || response.status === 403 ? ` Check api_key (${provider.keys}).` : "";
    throw new Error(`${provider.name} ${response.status}: ${String(why).slice(0, 300)}${hint}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`${provider.name} returned no message${data?.error?.message ? `: ${data.error.message}` : ""}`);
  }
  return content;
}

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

const clip = (text, max) => (text.length > max ? text.slice(0, max) + "\n… (truncated)" : text);

// Models like to wrap the answer in fences, quotes or a preamble.
function cleanMessage(text) {
  let s = text.trim();
  const fence = /```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/.exec(s);
  if (fence && fence[1].trim()) s = fence[1].trim();
  s = s.replace(/^commit message:\s*/i, "");
  if (/^(here('?s| is)|sure[,!])/i.test(s)) {
    const end = s.indexOf("\n");
    if (end > 0) s = s.slice(end + 1).trim();
  }
  s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
  return s
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPrompt(cfg, { root, branch, log, status, diff, untracked }) {
  const style = cfg.style === "plain"
    ? "Write a plain, descriptive commit message: a short summary line, then an optional body."
    : "Use Conventional Commits: <type>(<optional scope>): <subject>, then an optional body.";
  return [
    "You write git commit messages. Reply with only the commit message: no code fences, no quotes, no explanation.",
    "",
    "Rules:",
    `- ${style}`,
    "- Subject in the imperative mood, lowercase, no trailing period, at most 72 characters.",
    "- Add a body only when it helps explain why the change was made; wrap it at 72 columns.",
    `- Write in ${cfg.language}.`,
    "- Describe what actually changed in the diff below.",
    "",
    `Repository: ${root}`,
    `Branch: ${branch || "(detached)"}`,
    log ? `Recent commit subjects (match their style):\n${log}` : "",
    `Changed files:\n${status}`,
    untracked.length ? `Untracked files (content excerpts):\n\n${untracked}` : "",
    `Diff:\n${diff || "(no tracked changes)"}`,
  ].filter(Boolean).join("\n");
}

export const aiMethods = {
  // config.json sits beside this mod's mod.json, so both panel copies share it.
  async aiConfig() {
    let raw = null;
    try { raw = await readTextFile(`${appHome()}/mods/better-changes/config.json`); } catch { raw = null; }
    let custom = {};
    try { custom = raw ? JSON.parse(raw) : {}; } catch { custom = {}; }
    return { ...AI_DEFAULTS, ...custom };
  },

  async aiProvider(cfg) {
    if (cfg.provider && cfg.provider !== "auto") {
      if (AI_HTTP[cfg.provider]) return httpProvider(cfg.provider, cfg);
      const p = AI_PROVIDERS[cfg.provider];
      if (!p) throw new Error(`Unknown provider "${cfg.provider}" in config.json`);
      return { kind: "cli", name: cfg.provider, ...p };
    }
    for (const name of AI_ORDER) {
      try {
        const r = await exec(name, ["--version"], { timeout: 8000 });
        if (r.code === 0) return { kind: "cli", name, ...AI_PROVIDERS[name] };
      } catch { /* not installed */ }
    }
    throw new Error("No AI CLI found. Install opencode, claude, copilot, codex or gemini, or set \"provider\": \"deepseek\" / \"opencode-go\" with an api_key in config.json");
  },

  // One AI draft. Only fills the message field: staging and committing stay
  // with the panel's own Commit button, and a draft the person has typed is
  // never replaced.
  aiGenerate(cx) {
    if (!this.root || !this.allFiles?.length || this.busy || this.loading || this.generating) return;
    if (this.mode !== "sidebar") return;
    const { root, on } = this;
    const context = this.contextKey();
    const files = this.allFiles;
    const before = this.input.value();
    const run = (this.aiRun = (this.aiRun || 0) + 1);
    this.generating = true;
    this.aiNote = null;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const cfg = await this.aiConfig();
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on, timeout: 30000 });
        const [branch, log] = await Promise.all([
          git(["rev-parse", "--abbrev-ref", "HEAD"]),
          git(["log", "-n", "12", "--format=%s"]),
        ]);
        const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color"];
        let diff = "";
        if (this.hasHead) {
          const r = await git(["diff", "HEAD", ...DIFF]);
          if (r.code === 0) diff = r.stdout;
        } else {
          const [cached, unstaged] = await Promise.all([git(["diff", "--cached", ...DIFF]), git(["diff", ...DIFF])]);
          diff = (cached.stdout || "") + (unstaged.stdout || "");
        }
        // Untracked files have no diff: read short excerpts so the model sees them.
        const untracked = [];
        for (const file of files.filter((f) => f.fresh).slice(0, 6)) {
          try {
            const text = await readTextFile(`${root}/${file.path}`, { on });
            if (text !== null && !text.includes("\0")) untracked.push(`--- ${file.path} ---\n${clip(text, 3000)}`);
          } catch { /* unreadable, skip */ }
        }
        const prompt = clip(buildPrompt(cfg, {
          root,
          branch: branch.code === 0 ? branch.stdout.trim() : "",
          log: log.code === 0 ? log.stdout.trim() : "",
          status: files.map((f) => `${f.status} ${f.path}`).join("\n"),
          diff: clip(diff, Math.max(4000, Number(cfg.max_diff_chars) || AI_DEFAULTS.max_diff_chars)),
          untracked: clip(untracked.join("\n\n"), 4000),
        }), 28000);
        const provider = await this.aiProvider(cfg);
        const timeout = Math.min(Math.max(Number(cfg.timeout_ms) || AI_DEFAULTS.timeout_ms, 15000), 600000);
        let raw;
        if (provider.kind === "http") {
          let done = false;
          cx.timer.after(timeout, (cx) => {
            if (done || run !== this.aiRun) return;
            done = true; this.generating = false;
            if (this.isCurrent(context)) { this.aiNote = `AI failed: ${provider.name} timed out after ${Math.round(timeout / 1000)}s`; cx.notify(); }
          });
          raw = await askHttp(provider, prompt, cfg, `herdr-changes-${Math.random().toString(36).slice(2, 12)}`);
          if (done) return;
          done = true;
        } else {
          const result = await exec(provider.name, provider.args(prompt, cfg), { cwd: root, on, timeout });
          if (result.code !== 0) {
            const why = stripAnsi(result.stderr || result.stdout).trim();
            throw new Error((why || `${provider.name} exited with ${result.code}`).slice(0, 500));
          }
          raw = result.stdout;
        }
        const message = cleanMessage(stripAnsi(raw));
        if (!message) throw new Error(`${provider.name} returned an empty message`);
        if (run === this.aiRun && this.isCurrent(context) && this.input.value() === before) {
          this.message = message;
          this.input.set_value(message);
        }
      } catch (e) {
        if (run === this.aiRun && this.isCurrent(context)) this.aiNote = `AI failed: ${String(e).slice(0, 400)}`;
      } finally {
        if (run === this.aiRun) this.generating = false;
        cx.notify();
      }
    });
  },

  aiNoteLine() {
    return this.aiNote ?? null;
  },
};
