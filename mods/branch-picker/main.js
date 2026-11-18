// The branch switcher: lists the checkout's branches, marks the current one,
// greys the ones other worktrees hold, and checks out with git's own words
// when it refuses. Asked from the space menu (my-menu) with props
// { space, folder, machine }: the space's first terminal defines the checkout.
//
// "When possible": git itself refuses a branch another worktree has checked
// out, and a checkout with uncommitted changes may fail too. The list shows
// both cases up front (held branches dimmed with the holding worktree's
// folder name), and a failure shows git's error instead of guessing.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { exec, props, closeOverlay, theme, run, spaces, panes } from "herdr";

// A single-quoted PowerShell string.
const ps = (s) => `'${s.replaceAll("'", "''")}'`;

const shellArgs = (args, { cwd, on, timeout } = {}) =>
  window().platform === "windows" && !on
    ? ["powershell", ["-NoProfile", "-Command", `& git ${args.map(a => (a.includes(" ") ? ps(a) : a)).join(" ")}`], { timeout: timeout ?? 15000 }]
    : ["git", args, { cwd, on, timeout: timeout ?? 15000 }];

async function git(args, cwd, on, timeout) {
  const [command, argv, opts] = shellArgs(args, { cwd, on, timeout });
  const r = await exec(command, argv, opts).catch((e) => ({ code: -1, stderr: String(e).slice(0, 200), stdout: "" }));
  return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Windows runs git without a cwd through Herdr's exec; give it one always.
// Every argument is single-quoted on this path: PowerShell reads | ( ) $ in
// bare words as its own syntax, not as part of a git argument.
async function gitIn(args, cwd, on, timeout) {
  if (window().platform === "windows" && !on) {
    const script = `Set-Location -LiteralPath ${ps(cwd)}; & git ${args.map(a => ps(a)).join(" ")}`;
    const r = await exec("powershell", ["-NoProfile", "-Command", script], { timeout: timeout ?? 15000 })
      .catch((e) => ({ code: -1, stderr: String(e).slice(0, 200), stdout: "" }));
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  return git(args, cwd, on, timeout);
}

function parseBranches(stdout, current) {
  const out = [];
  for (const line of stdout.split("\n")) {
    const m = /^\*?\s*([0-9a-f]+)\s+(\*|\s)\s*(\S+)\s*(.*)$/.exec(line);
    if (!m || !m[3] || m[3] === "HEAD") continue;
    out.push({ hash: m[1], name: m[3], note: m[4] === "]" ? "" : (m[4] || "").replace(/^\]\s*/, ""), current: m[2] === "*" });
  }
  return out;
}

export default class BranchPicker extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.filter = "";
    this.busy = null;
    this.error = null;
    this.branches = [];
    this.held = new Map();
    this.dirty = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input = InputState.new({ placeholder: "Filter branches…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value().trim().toLowerCase(); cx.notify(); });
    if (p.folder) {
      this.space = p.space ?? null;
      this.folder = p.folder;
      this.on = p.machine ?? null;
    } else {
      // No props (a key, `mod.open`): the active space's checkout. Its first
      // terminal defines it, as everywhere else in Herdr.
      const space = spaces().find((s) => s.active);
      const ps = panes();
      const tabIDs = new Set((space?.tabs ?? []).map((t) => t.id));
      const pane = ps.find((x) => tabIDs.has(x.tab) && x.cwd);
      this.space = space?.id ?? null;
      this.folder = pane?.cwd ?? space?.folder ?? null;
      this.on = space?.machine ?? null;
    }
    if (!this.folder) { this.error = "This space has no folder."; return; }
    this.load(cx);
  }

  async load(cx) {
    const folder = this.folder, on = this.on;
    // One git for the list: branches with their tips, the worktree list (who
    // holds what), and a compact status count. All read-only.
    const [branches, worktrees, status] = await Promise.all([
      gitIn(["branch", "--format=%(objectname:short)|%(HEAD)|%(refname:short)|%(upstream:short)|%(subject)", "-q"], folder, on),
      gitIn(["worktree", "list", "--porcelain"], folder, on),
      gitIn(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], folder, on, 30000),
    ]);
    if (this.closed) return;
    if (branches.code !== 0) { this.error = branches.stderr || "Cannot read branches."; cx.notify(); return; }
    this.branches = branches.stdout.split("\n").filter(Boolean).map((line) => {
      const [hash, head, name, upstream, ...rest] = line.split("|");
      return { hash, current: head === "*", name, upstream, subject: rest.join("|") };
    });
    // worktree list --porcelain: blocks separated by blank lines, each with a
    // "worktree <path>" and optionally "detached", "HEAD", "branch <ref>".
    this.held = new Map();
    for (const block of worktrees.stdout.split(/\n\s*\n/)) {
      const wt = /^worktree (.*)$/m.exec(block)?.[1];
      const br = /^branch (.*)$/m.exec(block)?.[1];
      if (!wt || !br) continue;
      const ref = br.replace(/^refs\/heads\//, "");
      this.held.set(ref, wt);
    }
    this.dirty = status.code === 0 ? status.stdout.split("\0").filter(Boolean).length : null;
    cx.notify();
  }

  // A branch is switchable when git would allow it: nobody else holds it, and
  // it exists. Held ones stay visible but dimmed, with the holding folder.
  blocked(name) {
    const holder = this.held.get(name);
    if (!holder || holder.replaceAll("\\", "/") === `${this.folder}`.replaceAll("\\", "/")) return null;
    const parts = holder.split(/[\\/]/);
    return parts.slice(-2).join("/");
  }

  matches(b) {
    if (!this.filter) return true;
    return b.name.toLowerCase().includes(this.filter) || b.subject.toLowerCase().includes(this.filter);
  }

  switch(branch, cx) {
    if (this.busy || branch.current || this.blocked(branch.name)) return;
    const folder = this.folder, on = this.on, name = branch.name;
    this.busy = name;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await gitIn(["checkout", name], folder, on, 60000);
      if (r.code !== 0) {
        if (this.folder !== folder) return;
        this.busy = null;
        this.error = (r.stderr || r.stdout || `git checkout ${name} failed`).trim().slice(0, 400);
        cx.notify();
        return;
      }
      closeOverlay(props()?.overlay);
      run("notify", { title: `Switched to ${name}`, body: folder, level: "info", timeout: 4000 });
    });
  }

  render(cx) {
    const t = theme();
    const list = (this.branches ?? []).filter((b) => this.matches(b));
    return v_flex().id("branch-picker").track_focus(this.handle).size_full().gap(8).p(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().gap(8).items_center()
        .child(svg("mods/workspace-chrome/branch.svg").size(14).text_color(t.muted))
        .child(div().font_semibold().child("Switch branch"))
        .child(div().flex_1())
        .when(this.dirty !== null, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${this.dirty} uncommitted`))))
      .child(div().id("branch-filter").h(30).flex_none().px(9).flex().items_center().rounded(7).border_1().border_color(this.handle.focused ? t.accent : t.border)
        .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
      .child(div().id("branch-list").flex_1().min_h(0).relative()
        .child(v_flex().absolute().inset_0().overflow_y_scroll().gap(1)
          .children(list.map((b) => {
            const held = this.blocked(b.name);
            const disabled = Boolean(held) || b.current || Boolean(this.busy);
            return h_flex().id(`branch-${b.name}`).h(30).flex_none().px(9).gap(8).items_center().rounded(7)
              .bg(b.current ? t.selected : undefined)
              .text_color(held ? t.dim : t.foreground)
              .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
              .on_click((_e, cx) => this.switch(b, cx))
              .child(div().w(14).flex_none().text_color(t.accent).child(b.current ? "•" : ""))
              .child(h_flex().flex_1().min_w(0).gap(6).items_center()
                .child(div().truncate().child(b.name))
                .when(Boolean(held), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`held · ${held}`)))
                .when(Boolean(this.busy === b.name), (el) => el.child(div().flex_none().text_size(10).text_color(t.accent).child("switching…"))))
              .child(div().flex_none().text_size(10).text_color(t.dim).truncate().max_w(140).child(b.upstream || ""));
          }))
          .when(!list.length, (el) => el.child(div().p(10).text_color(t.dim).child(this.error ? "" : (this.branches ?? []).length ? "No branch matches." : this.busy ? "" : "Loading branches…"))))
        .child(Scrollbar.vertical().absolute().inset_0()))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).whitespace_normal().child(this.error ?? "")));
  }
}
