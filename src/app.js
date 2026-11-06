import {
  SAMPLE, TAG_LABELS, budgetUsed, decodeDoc, encodeDoc, fmtMinutes, metrics, parseTimeline, phases,
  suggestSeverity, toMarkdown,
} from "./incident.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const SVG_NS = "http://www.w3.org/2000/svg";
const STORE = "incident-review:v1";

let doc = decodeDoc(location.hash) || loadLocal() || { ...SAMPLE };

function loadLocal() {
  try {
    return decodeDoc(localStorage.getItem(STORE) || "");
  } catch {
    return null;
  }
}

function save() {
  const code = encodeDoc(doc);
  history.replaceState(null, "", `#${code}`);
  try {
    localStorage.setItem(STORE, code);
  } catch {
    // Storage can be unavailable in private windows. The URL still has the draft.
  }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function fillForm() {
  for (const f of form.elements) {
    if (!f.name) continue;
    f.value = f.dataset.pct !== undefined ? Math.round(doc[f.name] * 100) : doc[f.name];
  }
}

function card(label, value, sub) {
  return el("div", { class: "card" }, [el("span", { class: "card-label", text: label }), el("span", { class: "card-total", text: value }), el("span", { class: "card-sub", text: sub })]);
}

const clock = (t) => new Date(t).toISOString().slice(11, 16);

function update() {
  const { events, problems } = parseTimeline(doc.timeline);
  const m = metrics(events);
  const sev = suggestSeverity(m.impactMinutes, doc.usersAffected);
  const used = budgetUsed(m.impactMinutes, doc.usersAffected, doc.slo);

  $("warnings").replaceChildren(...[...problems, ...(events.length ? m.problems : [])].map((p) => el("li", { text: p })));
  $("cards").replaceChildren(
    card("Time to detect", fmtMinutes(m.timeToDetect), "impact began to alert"),
    card("Time to acknowledge", fmtMinutes(m.timeToAck), "alert to a responder"),
    card("Time to mitigate", fmtMinutes(m.timeToMitigate), "impact began to impact ended"),
    card("Time to resolve", fmtMinutes(m.timeToResolve), "impact began to closed"),
    card("Error budget used", used == null ? "n/a" : `${Math.round(used * 100)}%`, sev.level ? `of 30 days at ${doc.slo}%. Suggests SEV${sev.level}.` : `of 30 days at ${doc.slo}%`),
  );
  drawChart(events, m);
  $("markdown").textContent = toMarkdown(doc);
  save();
}

function drawChart(events, m) {
  const chart = $("chart");
  const W = 680, H = 132, m0 = { l: 16, r: 16 }, barY = 40, barH = 30;
  chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const ph = phases(m);
  if (!events.length) {
    chart.replaceChildren();
    $("chart-note").textContent = "";
    return;
  }
  const t0 = Math.min(...events.map((e) => e.at)), t1 = Math.max(...events.map((e) => e.at));
  const span = Math.max(1, t1 - t0);
  const x = (t) => m0.l + ((t - t0) / span) * (W - m0.l - m0.r);
  const nodes = [];

  for (const p of ph) {
    const w = Math.max(1, x(p.to) - x(p.from));
    nodes.push(svg("rect", { x: x(p.from), y: barY, width: w, height: barH, rx: 3, class: `seg p-${p.key}` }));
    const minutes = (p.to - p.from) / 60000;
    if (w > 46) nodes.push(svg("text", { x: x(p.from) + w / 2, y: barY + barH / 2 + 4, class: "seg-label", "text-anchor": "middle" }, fmtMinutes(minutes)));
  }

  // Event markers below the bar, staggered so close events stay readable.
  const tip = $("tooltip");
  let lastX = -Infinity, row = 0;
  for (const e of events) {
    const cx = x(e.at);
    row = cx - lastX < 14 ? (row + 1) % 3 : 0;
    lastX = cx;
    const cy = barY + barH + 22 + row * 16;
    nodes.push(svg("line", { x1: cx, x2: cx, y1: barY + barH, y2: cy, class: "stem" }));
    const dot = svg("circle", { cx, cy, r: e.tag === "note" ? 4 : 6, class: `ev ${e.tag === "note" ? "note" : ""}`, tabindex: 0, "aria-label": `${clock(e.at)} ${e.text}` });
    const show = () => {
      dot.classList.add("active");
      tip.replaceChildren(el("strong", { text: `${clock(e.at)} UTC${e.tag !== "note" ? `, ${TAG_LABELS[e.tag]}` : ""}` }), el("div", { text: e.text }));
      tip.hidden = false;
      const box = chart.getBoundingClientRect();
      const px = (cx / W) * box.width;
      tip.style.left = `${px > box.width / 2 ? px - tip.offsetWidth - 12 : px + 12}px`;
      tip.style.top = `${(cy / H) * box.height + 8}px`;
    };
    const hide = () => { dot.classList.remove("active"); tip.hidden = true; };
    dot.addEventListener("pointerenter", show);
    dot.addEventListener("focus", show);
    dot.addEventListener("pointerleave", hide);
    dot.addEventListener("blur", hide);
    nodes.push(dot);
  }
  nodes.push(svg("text", { x: m0.l, y: 22, class: "tick" }, `${clock(t0)} UTC`));
  nodes.push(svg("text", { x: W - m0.r, y: 22, class: "tick", "text-anchor": "end" }, `${clock(t1)} UTC`));
  chart.replaceChildren(...nodes);

  $("legend").replaceChildren(...ph.map((p) => el("li", {}, [el("i", { class: `swatch p-${p.key}` }), p.label])));
  // Recovery happens after users stop seeing errors, so look for the biggest win before that.
  const impact = ph.filter((p) => p.key !== "recovering");
  const longest = [...impact].sort((a, b) => b.to - b.from - (a.to - a.from))[0];
  $("chart-note").textContent = longest
    ? `While users were affected, the longest phase was "${longest.label.toLowerCase()}" at ${fmtMinutes((longest.to - longest.from) / 60000)}. Shortening it is usually the best action item. Hover a dot to read the event.`
    : "Tag the milestones to see the phases.";
}

form.addEventListener("input", (e) => {
  const f = e.target;
  if (!f.name) return;
  if (f.type === "number") {
    const n = Number(f.value);
    if (f.value === "" || !Number.isFinite(n)) return;
    if (f.name === "slo" && !(n > 0 && n < 100)) return;
    doc = { ...doc, [f.name]: f.dataset.pct !== undefined ? Math.min(1, Math.max(0, n / 100)) : n };
  } else doc = { ...doc, [f.name]: f.value };
  update();
});

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1500);
}

async function copy(btn, text, done) {
  try {
    await navigator.clipboard.writeText(text);
    flash(btn, done);
  } catch {
    flash(btn, "Copy failed");
  }
}

$("copy").addEventListener("click", (e) => copy(e.target, toMarkdown(doc), "Copied"));
$("share").addEventListener("click", (e) => copy(e.target, location.href, "Link copied"));
$("download").addEventListener("click", () => {
  const name = (doc.title || "postmortem").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "postmortem";
  const url = URL.createObjectURL(new Blob([toMarkdown(doc)], { type: "text/markdown" }));
  el("a", { href: url, download: `${name}.md` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("reset").addEventListener("click", () => {
  doc = { ...SAMPLE };
  fillForm();
  update();
});

fillForm();
update();
