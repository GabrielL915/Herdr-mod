import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme } from "herdr";

// System monitor: CPU (total + per core), RAM, swap, load, top memory users.
// Reads /proc on this computer every 2 seconds. Stop/Start button; the choice is remembered.

const EVERY_MS = 2000;

function parseStat(text) {
  const cpus = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const [name, ...rest] = line.trim().split(/\s+/);
    const v = rest.map(Number);
    const idle = (v[3] || 0) + (v[4] || 0); // idle + iowait
    const total = v.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
    cpus.push({ name, idle, total });
  }
  return cpus;
}

function parseMem(text) {
  const m = {};
  for (const line of text.split("\n")) {
    const r = line.match(/^(\w+):\s+(\d+)/);
    if (r) m[r[1]] = Number(r[2]) * 1024; // kB -> bytes
  }
  return m;
}

function gb(bytes) {
  return (bytes / 1024 ** 3).toFixed(1);
}

export default class SysMon extends View {
  init(_props, cx) {
    this.prev = null;
    this.cpu = []; // [{name, pct}]
    this.mem = null;
    this.load = "";
    this.top = [];
    this.error = "";
    this.task = null;
    let paused = false;
    try { paused = localStorage.getItem("paused") === "1"; } catch {}
    if (!paused) this.start(cx);
  }

  // Stopped means no timer and no commands at all: zero cost until started.
  start(cx) {
    if (this.task) return;
    this.prev = null;
    this.task = cx.timer.every(EVERY_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
    try { localStorage.setItem("paused", "0"); } catch {}
  }

  stop() {
    this.task?.cancel();
    this.task = null;
    this.cpu = [];
    this.mem = null;
    this.load = "";
    this.top = [];
    try { localStorage.setItem("paused", "1"); } catch {}
  }

  toggle(cx) {
    if (this.task) this.stop(); else this.start(cx);
    cx.notify();
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      if (!this.task) return;
      try {
        const [stat, mem, load, ps] = await Promise.all([
          exec("cat", ["/proc/stat"]),
          exec("cat", ["/proc/meminfo"]),
          exec("cat", ["/proc/loadavg"]),
          exec("sh", ["-c", "ps -eo rss=,comm= --sort=-rss | head -n 3"]),
        ]);
        const now = parseStat(stat.stdout);
        if (this.prev) {
          this.cpu = now.map((c, i) => {
            const p = this.prev[i];
            const dt = c.total - (p?.total ?? 0);
            const di = c.idle - (p?.idle ?? 0);
            return { name: c.name, pct: dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0 };
          });
        }
        this.prev = now;
        this.mem = parseMem(mem.stdout);
        this.load = load.stdout.trim().split(/\s+/).slice(0, 3).join("  ");
        if (!this.task) return; // stopped while reading
        this.top = ps.stdout.trim().split("\n").slice(0, 3).map((l) => {
          const [rss, ...name] = l.trim().split(/\s+/);
          return { name: name.join(" "), bytes: Number(rss) * 1024 };
        });
        this.error = "";
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  color(pct, t) {
    if (pct >= 85) return t.blocked;
    if (pct >= 60) return t.ansi3;
    return t.accent;
  }

  bar(pct, t, h = 6) {
    return div().w_full().h(h).rounded(h / 2).bg(t.raised).overflow_hidden()
      .child(div().h_full().rounded(h / 2).bg(this.color(pct, t)).w(`${pct.toFixed(1)}%`)
        .transition("width", { duration: 400 }));
  }

  row(label, value, pct, t) {
    return v_flex().gap(4)
      .child(h_flex().justify_between()
        .child(div().text_color(t.foreground).font_semibold().child(label))
        .child(div().text_color(t.muted).child(value)))
      .child(this.bar(pct, t));
  }

  render() {
    const t = theme();
    const total = this.cpu[0];
    const cores = this.cpu.slice(1);
    const m = this.mem;
    const memUsed = m ? m.MemTotal - (m.MemAvailable ?? m.MemFree) : 0;
    const memPct = m ? (memUsed / m.MemTotal) * 100 : 0;
    const swapUsed = m ? m.SwapTotal - m.SwapFree : 0;
    const swapPct = m && m.SwapTotal ? (swapUsed / m.SwapTotal) * 100 : 0;

    const running = Boolean(this.task);
    const header = h_flex().justify_between().items_center()
      .child(div().text_size(12).text_color(t.muted).child("System"))
      .child(div().id("sysmon-toggle").px(8).py(2).rounded(4).text_size(11)
        .border(1).border_color(t.border).text_color(running ? t.muted : t.accent)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggle(cx))
        .child(running ? "Stop" : "Start"));
    const narrow = this.size && this.size.width < 150;

    if (narrow) {
      return v_flex().id("root").size_full().items_center().justify_center().gap(4).text_size(10)
        .text_color(t.muted)
        .on_size_change((size, cx) => { this.size = size; cx.notify(); })
        .child(div().id("sysmon-mini").on_click((_e, cx) => this.toggle(cx))
          .child(running ? `${total ? total.pct.toFixed(0) : "…"}%` : "off"))
        .when(running && m, (el) => el.child(div().child(`${memPct.toFixed(0)}%`)));
    }

    if (!running) {
      return v_flex().id("root").size_full().px(16).py(10).gap(8).text_size(12).text_color(t.dim)
        .on_size_change((size, cx) => { this.size = size; cx.notify(); })
        .child(header)
        .child(div().child("Stopped. Not using any CPU."));
    }

    return v_flex().id("root").size_full().px(16).py(10).gap(10).text_size(12)
      .text_color(t.muted).overflow_y_scrollbar()
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .child(header)
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(this.row("CPU", total ? `${total.pct.toFixed(0)}%` : "…", total?.pct ?? 0, t))
      .when(cores.length > 0, (el) => el.child(
        h_flex().gap(3).items_end().h(28).children(cores.map((c) =>
          div().id(`core-${c.name}`).flex_1().h_full().rounded(2).bg(t.raised).flex().flex_col().justify_end()
            .child(div().w_full().rounded(2).bg(this.color(c.pct, t)).h(`${Math.max(4, c.pct).toFixed(1)}%`)
              .transition("height", { duration: 400 }))))))
      .child(this.row("RAM", m ? `${gb(memUsed)} / ${gb(m.MemTotal)} GB` : "…", memPct, t))
      .when(Boolean(m && m.SwapTotal), (el) =>
        el.child(this.row("Swap", `${gb(swapUsed)} / ${gb(m.SwapTotal)} GB`, swapPct, t)))
      .child(h_flex().justify_between()
        .child(div().text_color(t.foreground).font_semibold().child("Load"))
        .child(div().child(this.load || "…")))
      .child(v_flex().gap(4)
        .child(div().text_color(t.foreground).font_semibold().child("Top memory"))
        .children(this.top.map((p, i) => h_flex().id(`top-${i}`).justify_between().gap(8)
          .child(div().flex_1().truncate().child(p.name))
          .child(div().text_color(t.dim).child(`${(p.bytes / 1024 ** 2).toFixed(0)} MB`)))));
  }
}
