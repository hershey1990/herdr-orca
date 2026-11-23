// The sidebar: its tabs, options menu, file groups and commit views.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, shared, setShared } from "herdr";
import { fileTree, timeAgo } from "../git/model.js";
import {
  TEXT,
  SPIN_MS,
  SIZE,
  codeFont,
  FileIcon,
  Chevron,
  Panel,
  PanelHeader,
  HeaderTab,
  IconButton,
  TextButton,
  GroupHeader,
  Row,
  DiffStat,
  StatusLetter,
  Message,
  Menu,
  MenuLabel,
  MenuDivider,
  MenuOption,
  TextBox,
  SplitButton,
  SplitTrigger,
} from "./ui.js";

const SHOW_ROWS = 150;

const VIEWS = [
  { id: "flat", label: "Flat", icon: "flat" },
  { id: "tree", label: "Tree", icon: "tree" },
];
const LAYOUTS = [
  { id: "inline", label: "Inline", icon: "diff-inline" },
  { id: "split", label: "Side by side", icon: "diff-split" },
];

export const sidebarMethods = {
  // ── Preferences ───────────────────────────────────────────────────────────

  setTab(tab, cx) {
    this.tab = tab;
    localStorage.setItem("tab", tab);
    if (tab === "commit") this.loadCommits(cx);
    cx.notify();
  },

  setView(view, cx) {
    this.view = view;
    localStorage.setItem("view", view);
    cx.notify();
  },

  toggleGroup(scope, cx) {
    if (!this.collapsed.delete(scope)) this.collapsed.add(scope);
    localStorage.setItem("collapsed", JSON.stringify([...this.collapsed]));
    cx.notify();
  },

  setDiffLayout(style, cx) {
    this.diffLayout = style;
    localStorage.setItem("diff-layout", style);
    setShared("better-changes.diff-layout", style);
    cx.notify();
  },

  // ── Sidebar ───────────────────────────────────────────────────────────────

  render() {
    if (this.mode === "panel-key") return div();
    if (this.mode === "pane-header") return this.renderPaneHeader();
    if (this.mode === "diff") return this.renderDiff();
    return Panel({ id: "better-changes" })
      .child(this.renderHeader())
      .child(
        this.tab === "commit"
          ? this.selectedCommit
            ? this.renderCommit()
            : this.renderHistory()
          : this.renderChanges(),
      );
  },

  renderHeader() {
    const unpushed = this.committed?.unpushed.size;
    return PanelHeader()
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .ml(-8) // Lines the pills up with the list rows below.
          .gap(4)
          .items_center()
          .role("tab_list")
          .child(
            HeaderTab({
              id: "tab-changes",
              label: "Changes",
              count: this.total || null,
              active: this.tab === "changes",
              onClick: (cx) => this.setTab("changes", cx),
            }),
          )
          .child(
            HeaderTab({
              id: "tab-commit",
              label: "Commits",
              count: unpushed,
              active: this.tab === "commit",
              onClick: (cx) => this.setTab("commit", cx),
            }),
          ),
      )
      .child(
        IconButton({
          id: "refresh",
          icon: "refresh",
          label: "Refresh",
          spinning: this.refreshSpinning,
          onClick: (cx) => this.refreshAll(cx),
        }),
      )
      .child(this.renderMore());
  },

  refreshAll(cx) {
    this.refresh(cx);
    if (this.tab === "commit") this.loadCommits(cx);
    if (this.refreshSpinning) return;
    this.refreshSpinning = true;
    cx.notify();
    cx.timer.after(SPIN_MS, (cx) => this.stopSpinningWhenRead(cx));
  },

  // Git usually answers at once, so the icon always makes a full turn to be seen.
  stopSpinningWhenRead(cx) {
    if (this.loading || this.commitsLoading) {
      cx.timer.after(SPIN_MS, (cx) => this.stopSpinningWhenRead(cx));
      return;
    }
    this.refreshSpinning = false;
    cx.notify();
  },

  renderMore() {
    const option = (group, choice, selected, set) =>
      MenuOption({
        id: `${group}-${choice.id}`,
        icon: choice.icon,
        label: choice.label,
        selected,
        onClick: (cx) => {
          this.menuOpen = false;
          set(choice.id, cx);
          cx.notify();
        },
      });
    return Menu({
      id: "more",
      open: this.menuOpen,
      focus: this.menuFocus,
      onOpenChange: (open, cx) => {
        this.menuOpen = open;
        cx.notify();
      },
      trigger: IconButton({ id: "more-trigger", icon: "more", label: "Options" }),
      children: [
        MenuLabel("Changes"),
        ...VIEWS.map((v) =>
          option("view", v, this.view === v.id, (id, cx) => this.setView(id, cx)),
        ),
        MenuDivider(),
        MenuLabel("Diff"),
        ...LAYOUTS.map((l) =>
          option("layout", l, this.diffLayout === l.id, (id, cx) => this.setDiffLayout(id, cx)),
        ),
      ],
    });
  },

  // The changes list as flat spec rows: group headers, folders, files.
  // Built once per state change (not per render), consumed by the virtual
  // list below — a large repository (840+ files) stays a small frame.
  // The changes list as flat spec rows: group headers, folders, files.
  // Built once per state change (not per render), consumed by the virtual
  // list below — a large repository (840+ files) stays a small frame.
  // Large repositories: rendering every row in one frame breaks past a few
  // thousand GPUI elements ("view could not be re-rendered"). Each group
  // shows at most SHOW_ROWS rows; a Show-all row renders the rest. Groups
  // beyond the first stay collapsed until opened, which keeps the initial
  // frame small without losing any interaction — everything stays the
  // ordinary clickable rows, no virtual-list handler restrictions.
  changesSpec() {
    const spec = [];
    const conflicts = this.files.filter((f) => f.conflict);
    const unstaged = this.files.filter((f) => f.unstaged && !f.conflict);
    const staged = this.files.filter((f) => f.staged);
    const committed = this.committed?.total ? this.committed : null;
    if (!conflicts.length && !unstaged.length && !staged.length && !committed) spec.push({ kind: "empty" });
    this.groupsDrawn = 0;
    const shown = this.shownRows ?? {};
    const group = (scope, label, files, detail, count) => {
      if (!files.length) return;
      const collapsed = this.collapsed.has(scope);
      const bulk = {
        unstaged: { action: "stage", icon: "plus", label: "Stage all" },
        staged: { action: "unstage", icon: "minus", label: "Unstage all" },
      }[scope];
      spec.push({ kind: "group", scope, label, count: count ?? files.length, detail, danger: scope === "conflict",
        divided: this.groupsDrawn++ > 0, collapsed, bulk });
      if (collapsed) return;
      const cap = shown[scope] ?? SHOW_ROWS;
      const draw = files.slice(0, cap);
      if (this.view === "flat") {
        for (const file of draw) spec.push({ kind: "file", file, scope, depth: 0 });
      } else {
        const closed = new Set([...this.closed].filter((k) => k.startsWith(`${scope}:`)).map((k) => k.slice(scope.length + 1)));
        for (const row of fileTree(draw, closed))
          spec.push(row.kind === "folder"
            ? { kind: "folder", path: row.path, name: row.name, scope, depth: row.depth, closed: closed.has(row.path) }
            : { kind: "file", file: row.file, scope, depth: row.depth });
      }
      if (files.length > draw.length)
        spec.push({ kind: "more", scope, shown: draw.length, total: files.length });
    };
    group("conflict", "Conflicts", conflicts);
    group("staged", "Staged", staged);
    group("unstaged", "Unstaged", unstaged);
    if (committed) group("committed", "Committed", committed.files, `not on ${committed.name}`, committed.total);
    return spec;
  },

  renderChanges() {
    const list = v_flex().id("changes-list").flex_1().min_h(0).p(6).overflow_y_scrollbar();
    if (this.error) {
      // A stable state: the location is anchored per space, so this banner
      // means the space's folder itself holds no repository (yet).
      const t = theme();
      list.child(
        v_flex().gap(4).p(8).child(Message(this.error, true)).child(
          div().text_size(TEXT.caption).text_color(t.dim).whitespace_normal().child(this.root ?? this.location().cwd ?? ""),
        ),
      );
      return list;
    }
    if (this.loading && !this.files.length) {
      list.child(Message("Loading changes…"));
      return list;
    }
    const t = theme();
    const spec = this.changesSpec();
    if (!spec.length) list.child(Message("No changes"));
    for (const row of spec) {
      if (row.kind === "empty") { list.child(Message(this.loading ? "Loading changes…" : "No changes")); continue; }
      if (row.kind === "group") {
        const bulk = row.bulk && TextButton({
          id: `${row.bulk.action}-all`,
          icon: row.bulk.icon,
          label: row.bulk.label,
          onClick: (cx) => this.indexAction(row.bulk.action, null, cx),
        });
        list.child(GroupHeader({
          id: `group-${row.scope}`,
          label: row.label,
          count: row.count,
          detail: row.detail,
          danger: row.danger,
          collapsed: row.collapsed,
          divided: row.divided,
          action: bulk,
          onClick: (cx) => this.toggleGroup(row.scope, cx),
        }));
        continue;
      }
      if (row.kind === "folder") {
        list.child(this.folderRow({ path: row.path, name: row.name, depth: row.depth }, row.scope, row.closed));
        continue;
      }
      if (row.kind === "more") {
        list.child(
          h_flex().id(`more-${row.scope}`).h(SIZE.row).flex_none().px(8).gap(7).items_center().rounded(7)
            .cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.shownRows = { ...(this.shownRows ?? {}), [row.scope]: row.total }; cx.notify(); })
            .child(div().text_size(TEXT.caption).text_color(t.accent)
              .child(`Show all ${row.total.toLocaleString()} (${row.shown.toLocaleString()} shown)`)),
        );
        continue;
      }
      list.child(this.fileRow(row.file, row.scope, row.depth));
    }
    const limit = this.settings.limits.files;
    if (this.total > limit)
      list.child(Message(`Showing the first ${limit.toLocaleString()} changed files.`));
    return v_flex().id("changes").flex_1().min_h(0).child(list).child(this.renderCommitBox());
  },

  renderCommitBox() {
    const t = theme();
    const hint = this.commitBoxHint();
    return v_flex()
      .id("commit-box")
      .flex_none()
      .p(10)
      .gap(8)
      .border_t(1)
      .border_color(t.border)
      .when(Boolean(this.note), (el) =>
        el.child(
          div()
            .text_size(TEXT.small)
            .text_color(t.ansi1)
            .whitespace_normal()
            .child(this.note ?? ""),
        ),
      )
      .child(
        TextBox({
          id: "commit-message",
          state: this.input,
          focused: this.typing,
          label: "Commit message",
        }),
      )
      .child(
        h_flex()
          .w_full()
          .gap(8)
          .child(this.renderAiButton())
          .child(
            h_flex().id("commit-main").flex_1().min_w(0).child(this.renderCommitButton()),
          ),
      )
      .when(Boolean(this.aiNote), (el) =>
        el.child(
          div()
            .text_size(TEXT.caption)
            .text_color(t.ansi1)
            .whitespace_normal()
            .child(this.aiNote ?? ""),
        ),
      )
      .when(Boolean(hint), (el) =>
        el.child(
          div()
            .text_size(TEXT.caption)
            .text_color(this.commitMode === "amend" ? t.working : t.dim)
            .whitespace_normal()
            .child(hint ?? ""),
        ),
      );
  },

  // The AI ✦ button: asks the configured provider to draft a commit message
  // from the uncommitted changes and fills the field. You review it and press
  // Commit yourself; the panel never stages or commits from this button.
  renderAiButton() {
    const t = theme();
    const enabled = Boolean(
      this.root &&
        this.allFiles?.length &&
        this.mode === "sidebar" &&
        !this.busy &&
        !this.loading &&
        !this.generating,
    );
    return h_flex()
      .id("ai-commit")
      .h(SIZE.button)
      .w(76)
      .flex_none()
      .gap(6)
      .items_center()
      .justify_center()
      .rounded(8)
      .border_1()
      .border_color(this.generating ? t.accent : t.border)
      .bg(t.raised)
      .text_size(TEXT.small)
      .text_color(enabled ? t.accent : t.dim)
      .when(this.generating, (el) => el.child(div().frames(["AI ·", "AI ··", "AI ···"], 320)))
      .when(!this.generating, (el) => el.child("AI ✦"))
      .tooltip("Draft a commit message with AI")
      .when(enabled, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.aiGenerate(cx)),
      );
  },

  commitBoxHint() {
    if (this.amendLoading) return "Loading the latest commit…";
    if (this.conflicts) return "Resolve conflicts and stage the files before committing.";
    if (this.commitMode === "amend") {
      return "Amend rewrites the latest commit. Unstaged changes stay untouched.";
    }
    return null;
  },

  commitButtonLabel() {
    if (this.operation === "commit") return "Committing…";
    if (this.operation === "commit-push") return "Committing…";
    if (this.operation === "push") return "Pushing…";
    if (this.operation === "amend") return "Amending…";
    return this.commitMode === "amend" ? "Amend" : "Commit";
  },

  renderCommitButton() {
    const amend = this.commitMode === "amend";
    return SplitButton({
      id: "commit",
      icon: amend ? "amend" : "commit",
      label: this.commitButtonLabel(),
      enabled: this.canCommit(),
      primary: !amend,
      onClick: (cx) => this.commit(cx),
      menu: this.renderCommitMenu(),
    });
  },

  renderCommitMenu() {
    const amend = this.commitMode === "amend";
    const choose = (mode) => (cx) => this.setCommitMode(mode, cx);
    const options = [
      MenuOption({
        id: "mode-commit",
        icon: "commit",
        label: "Commit",
        selected: !amend,
        onClick: choose("commit"),
      }),
    ];
    if (this.hasHead) {
      options.push(
        MenuOption({
          id: "mode-amend",
          icon: "amend",
          label: "Amend",
          selected: amend,
          onClick: choose("amend"),
        }),
      );
    }
    // Actions, not modes: they run now with the current message, then the
    // menu closes. Commit & Push commits first and pushes right after; a
    // failed push keeps the commit and says so under the box.
    options.push(
      MenuOption({
        id: "action-commit-push",
        icon: "commit",
        label: "Commit & Push",
        selected: false,
        onClick: (cx) => this.commit(cx, { push: true }),
      }),
      MenuOption({
        id: "action-push",
        icon: "external-link",
        label: "Push",
        selected: false,
        onClick: (cx) => this.push(cx),
      }),
    );
    return Menu({
      id: "commit-menu",
      open: this.commitMenuOpen,
      focus: this.commitMenuFocus,
      anchor: "bottom_right",
      onOpenChange: (open, cx) => {
        this.commitMenuOpen = open;
        cx.notify();
      },
      trigger: SplitTrigger({ id: "commit-options", label: "Commit options" }),
      children: options,
    });
  },

  folderRow(row, scope, closed) {
    const t = theme();
    const key = `${scope}:${row.path}`;
    return Row({
      id: `folder-${key}`,
      depth: row.depth,
      stem: !closed,
      onClick: (cx) => {
        if (closed) this.closed.delete(key);
        else this.closed.add(key);
        cx.notify();
      },
    })
      .child(Chevron(!closed))
      .when(Boolean(this.fileIcons), (el) =>
        el.child(FileIcon({ icons: this.fileIcons, path: `${this.root}/${row.path}`, dir: true, open: !closed, t })),
      )
      .child(div().flex_1().min_w(0).truncate().child(row.name));
  },

  // The commit checkbox, Zed-style: checked = the file takes part in the next
  // commit. In this panel a commit is what is staged, so checked means staged:
  // toggling stages or unstages that one file, and the check reflects Git's
  // answer after the index action lands. Conflicts never join on their own.
  renderCommitCheck(file, scope) {
    const t = theme();
    const checked =
      scope === "staged" ? true : scope === "unstaged" ? false : Boolean(file.staged);
    const actionable =
      !file.conflict && (scope === "mixed" ? Boolean(file.staged) !== Boolean(file.unstaged) : true);
    const toggle = (cx) => {
      cx.stop_propagation();
      const target = scope === "staged" ? "unstage" : "stage";
      this.indexAction(target, file.path, cx);
    };
    return div()
      .id(`check-${scope}-${file.path}`)
      .w(14)
      .h(14)
      .flex_none()
      .rounded(3)
      .border_1()
      .border_color(checked ? t.accent : t.border)
      .when(checked, (el) => el.bg(t.accent))
      .child(
        checked
          ? svg("mods/better-changes/icons/check.svg").size(10).text_color(t.background)
          : div(),
      )
      .when(actionable, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.border_color(t.accent))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => toggle(cx)),
      );
  },

  fileRow(file, scope, depth) {
    const t = theme();
    const parts = file.path.split("/");
    const name = parts.pop();
    const tree = this.view === "tree";
    const stats =
      scope === "staged" ? file.stagedStats : scope === "unstaged" ? file.unstagedStats : file;
    const status =
      scope === "staged"
        ? file.stagedStatus
        : scope === "unstaged"
          ? file.unstagedStatus
          : file.status;
    const open = shared("better-changes.selection");
    const row = Row({
      id: `file-${scope}-${file.path}`,
      depth,
      selected: open?.path === file.path && open?.scope === scope,
      onClick: (cx) => this.pick(file, scope, cx),
    })
      .child(this.renderCommitCheck(file, scope))
      .child(FileIcon({ icons: this.fileIcons, path: `${this.root}/${file.path}`, color: t.muted, t }));
    if (tree) row.child(div().flex_1().min_w(0).truncate().child(name));
    else
      row.child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(6)
          .items_center()
          .child(div().max_w(190).flex_none().truncate().child(name))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(TEXT.small)
              .text_color(t.dim)
              .child(parts.join("/")),
          ),
      );
    if (file.conflict)
      row.child(
        div().flex_none().text_size(TEXT.caption).text_color(t.ansi1).child(file.conflictKind),
      );
    else row.child(DiffStat(stats)).child(StatusLetter(status));
    if (scope === "unstaged")
      row.child(
        IconButton({
          id: `stage-${file.path}`,
          icon: "plus",
          label: "Stage",
          small: true,
          onClick: (cx) => this.indexAction("stage", file.path, cx),
        }),
      );
    if (scope === "staged")
      row.child(
        IconButton({
          id: `unstage-${file.path}`,
          icon: "minus",
          label: "Unstage",
          small: true,
          onClick: (cx) => this.indexAction("unstage", file.path, cx),
        }),
      );
    return row;
  },

  renderHistory() {
    const list = v_flex().id("commit-list").flex_1().min_h(0).overflow_y_scrollbar().p(6);
    if (this.commitsError) return list.child(Message(this.commitsError, true));
    if (!this.commits.length)
      return list.child(
        Message(this.commitsLoading || !this.root ? "Loading history…" : "No commits yet"),
      );
    this.groupsDrawn = 0;
    const remote = this.committed;
    const more = this.commitsDone ? "" : "+";
    const local = this.branch ?? "HEAD";
    if (!remote) {
      this.addCommits(list, {
        scope: "branch",
        label: local,
        count: `${this.commits.length}${more}`,
        commits: this.commits,
        withMore: true,
      });
      return list;
    }
    const notPulled = (n) => (n ? `${n} not pulled` : null);
    const detail = (...parts) => parts.filter(Boolean).join(" · ");
    const head = this.remoteHead;
    const pushed = this.commits.filter((c) => !remote.unpushed.has(c.hash));
    this.addCommits(list, {
      scope: "branch",
      label: local,
      count: remote.unpushed.size,
      commits: this.commits.filter((c) => remote.unpushed.has(c.hash)),
    });
    if (head && head.target !== remote.name) {
      // A feature branch: what the remote branch has, then the default branch under it.
      const onBranch = pushed.filter((c) => head.ahead.has(c.hash));
      const onDefault = pushed.filter((c) => !head.ahead.has(c.hash));
      this.addCommits(list, {
        scope: "remote",
        label: remote.name,
        count: onBranch.length,
        commits: onBranch,
        detail: notPulled(this.behind),
      });
      this.addCommits(list, {
        scope: "default",
        label: head.name,
        count: `${onDefault.length}${more}`,
        commits: onDefault,
        detail: detail(head.target, notPulled(head.behind)),
        withMore: true,
      });
      return list;
    }
    this.addCommits(list, {
      scope: "remote",
      label: remote.name,
      count: `${pushed.length}${more}`,
      commits: pushed,
      detail: detail(head?.name, notPulled(this.behind)),
      withMore: true,
    });
    return list;
  },

  addCommits(list, { scope, label, count, commits, detail, withMore = false }) {
    if (!commits.length) return;
    const t = theme();
    const collapsed = this.collapsed.has(scope);
    list.child(
      GroupHeader({
        id: `group-${scope}`,
        label,
        count,
        detail,
        collapsed,
        divided: this.groupsDrawn++ > 0,
        onClick: (cx) => this.toggleGroup(scope, cx),
      }),
    );
    if (collapsed) return;
    for (const commit of commits) list.child(this.commitRow(commit));
    if (withMore && !this.commitsDone)
      list.child(
        Row({ id: "commits-more", onClick: (cx) => this.loadCommits(cx, true) })
          .justify_center()
          .text_size(TEXT.small)
          .text_color(t.muted)
          .child(this.commitsLoading ? "Loading…" : "Load more"),
      );
  },

  commitRow(commit) {
    const t = theme();
    return h_flex()
      .id(`commit-${commit.hash}`)
      .flex_none()
      .px(8)
      .py(6)
      .gap(8)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openCommit(commit, cx))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          .child(div().truncate().child(commit.subject))
          .child(
            div()
              .truncate()
              .text_size(TEXT.caption)
              .text_color(t.dim)
              .child(`${commit.author} · ${timeAgo(commit.at)}`),
          ),
      )
      .child(
        div()
          .flex_none()
          .text_size(TEXT.caption)
          .text_color(t.dim)
          .font_family(codeFont())
          .child(commit.short),
      );
  },

  renderCommit() {
    return v_flex()
      .id("commit-detail")
      .flex_1()
      .min_h(0)
      .child(this.renderCommitTopRow())
      .child(
        v_flex()
          .id("commit-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .child(this.renderCommitAbout())
          .child(this.renderCommitChanges()),
      );
  },

  // Only a commit the remote has can be opened there.
  commitUrl(commit) {
    if (!this.repo || this.committed?.unpushed.has(commit.hash)) return null;
    return `https://github.com/${this.repo}/commit/${commit.hash}`;
  },

  renderCommitTopRow() {
    const t = theme();
    const commit = this.selectedCommit;
    const url = this.commitUrl(commit);
    const row = PanelHeader()
      .px(8)
      .gap(4)
      .child(
        IconButton({
          id: "commit-back",
          icon: "chevron-left",
          label: "Back to commits",
          onClick: (cx) => {
            this.selectedCommit = null;
            this.commitToken++;
            cx.notify();
          },
        }),
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(TEXT.small)
          .text_color(t.dim)
          .font_family(codeFont())
          .child(commit.short),
      );
    if (url) {
      row.child(
        IconButton({
          id: "commit-open",
          icon: "external-link",
          label: "Open on GitHub",
          onClick: (cx) => cx.open_url(url),
        }),
      );
    }
    return row;
  },

  renderCommitAbout() {
    const t = theme();
    const commit = this.selectedCommit;
    const when = new Date(commit.at * 1000).toLocaleString();
    const about = v_flex()
      .id("commit-about")
      .flex_none()
      .px(14)
      .py(10)
      .gap(4)
      .border_b(1)
      .border_color(t.border)
      .child(div().font_medium().whitespace_normal().child(commit.subject))
      .child(
        div()
          .text_size(TEXT.caption)
          .text_color(t.dim)
          .whitespace_normal()
          .child(`${commit.author} · ${when}`),
      );
    if (commit.body) {
      about.child(
        div()
          .pt(6)
          .text_size(TEXT.small)
          .text_color(t.muted)
          .whitespace_normal()
          .child(commit.body),
      );
    }
    return about;
  },

  renderCommitChanges() {
    const changes = v_flex().id("commit-changes").flex_none().p(6);
    if (this.commitFilesError) return changes.child(Message(this.commitFilesError, true));
    if (this.commitFilesLoading) return changes.child(Message("Loading changes…"));
    if (this.commitFiles.length) {
      changes.child(
        GroupHeader({ id: "group-commit", label: "Changes", count: this.commitFiles.length }),
      );
    }
    this.addRows(changes, "commit", this.commitFiles);
    return changes;
  },
};
