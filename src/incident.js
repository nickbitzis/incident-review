// Parse an incident timeline, compute response metrics, and draft a postmortem.
// No DOM code here, so all of it runs under Node's test runner.

export const TAGS = ["start", "detect", "ack", "mitigate", "resolve"];
export const TAG_LABELS = {
  start: "Impact began",
  detect: "Detected",
  ack: "Acknowledged",
  mitigate: "Mitigated",
  resolve: "Resolved",
  note: "Note",
};

export const SAMPLE = {
  title: "Checkout errors after a payment config deploy",
  service: "checkout-api",
  usersAffected: 0.35, // share of requests or users affected while impact lasted
  slo: 99.9,
  timeline: `2026-10-14 09:02 [start] Deploy 4812 rolls out a new payment provider timeout setting
09:02 Error rate on POST /checkout climbs from 0.1% to 34%
09:09 [detect] Burn-rate alert pages the on-call engineer
09:16 [ack] On-call acknowledges and opens an incident channel
09:21 Dashboards show errors only on the new provider path
09:27 Deploy 4812 identified as the likely cause
09:31 [mitigate] Deploy 4812 rolled back, error rate back under 0.2%
09:48 Queued orders from the impact window retried successfully
10:05 [resolve] Monitoring stable for 30 minutes, incident closed`,
  actions: `Add the payment timeout setting to the canary checks | payments team | P1
Page on checkout error rate after 2 minutes instead of 5 | on-call lead | P1
Link the deploy log to the incident channel automatically | platform | P2`,
};

const STAMP = /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{1,2}):(\d{2})\s*(.*)$/;

/**
 * One event per line: "2026-10-14 09:02 [start] text". The date can be left
 * off after the first line. A time earlier than the one before it rolls over
 * to the next day, since incidents cross midnight.
 */
export function parseTimeline(text) {
  const events = [];
  const problems = [];
  let day = null;
  let last = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(STAMP);
    if (!m) {
      problems.push(`Line ${i + 1}: start with a time like 09:15 or 2026-10-14 09:15.`);
      return;
    }
    const [, date, hh, mm, rest] = m;
    if (date) day = date;
    if (!day) {
      problems.push(`Line ${i + 1}: the first event needs a date, like 2026-10-14 ${hh.padStart(2, "0")}:${mm}.`);
      return;
    }
    if (+hh > 23 || +mm > 59) {
      problems.push(`Line ${i + 1}: ${hh}:${mm} is not a valid time.`);
      return;
    }
    let at = Date.parse(`${day}T${hh.padStart(2, "0")}:${mm}:00Z`);
    if (!date && last != null && at < last) {
      at += 86400000;
      day = new Date(at).toISOString().slice(0, 10);
    }
    last = at;
    const tagMatch = rest.match(/^\[(\w+)\]\s*(.*)$/);
    let tag = "note";
    let text = rest;
    if (tagMatch) {
      const t = tagMatch[1].toLowerCase();
      if (TAGS.includes(t)) {
        tag = t;
        text = tagMatch[2];
      } else problems.push(`Line ${i + 1}: unknown tag [${tagMatch[1]}]. Use ${TAGS.map((x) => `[${x}]`).join(", ")}.`);
    }
    events.push({ at, tag, text: text.trim(), line: i + 1 });
  });
  return { events, problems };
}

/** The first event with each tag, in minutes, and the standard response metrics. */
export function metrics(events) {
  const first = {};
  for (const e of events) if (e.tag !== "note" && first[e.tag] == null) first[e.tag] = e.at;
  const problems = [];
  for (const t of TAGS) if (first[t] == null) problems.push(`No [${t}] event, so metrics that need it are left out.`);
  for (let i = 1; i < TAGS.length; i++) {
    const a = TAGS[i - 1], b = TAGS[i];
    if (first[a] != null && first[b] != null && first[b] < first[a]) problems.push(`[${b}] comes before [${a}]. Check the order.`);
  }
  const mins = (a, b) => (first[a] != null && first[b] != null ? (first[b] - first[a]) / 60000 : null);
  const impactEnd = first.mitigate ?? first.resolve;
  return {
    first,
    problems,
    timeToDetect: mins("start", "detect"),
    timeToAck: mins("detect", "ack"),
    timeToMitigate: mins("start", "mitigate"),
    timeToResolve: mins("start", "resolve"),
    impactMinutes: first.start != null && impactEnd != null ? (impactEnd - first.start) / 60000 : null,
  };
}

/**
 * Error budget used, as a share of a 30-day budget. Impact minutes are
 * weighted by the share of users or requests affected.
 */
export function budgetUsed(impactMinutes, usersAffected, slo) {
  if (impactMinutes == null) return null;
  const budget = 30 * 24 * 60 * (1 - slo / 100);
  return budget > 0 ? (impactMinutes * usersAffected) / budget : null;
}

/**
 * A common severity rubric: wide, long impact is SEV1. Teams have their own,
 * so this is a suggestion shown next to the reasoning.
 */
export function suggestSeverity(impactMinutes, usersAffected) {
  if (impactMinutes == null) return { level: null, why: "needs [start] and [mitigate] or [resolve] events" };
  if (usersAffected >= 0.25 && impactMinutes >= 15) return { level: 1, why: "a quarter or more of users affected for 15 minutes or longer" };
  if (usersAffected >= 0.05 && impactMinutes >= 15) return { level: 2, why: "a noticeable share of users affected for 15 minutes or longer" };
  if (usersAffected >= 0.05 || impactMinutes >= 30) return { level: 3, why: "limited in either reach or duration" };
  return { level: 4, why: "small and short" };
}

/** Phases for the timeline chart, each from one milestone to the next. */
export function phases(m) {
  const f = m.first;
  const span = (key, label, from, to) => (f[from] != null && f[to] != null && f[to] >= f[from] ? { key, label, from: f[from], to: f[to] } : null);
  return [
    span("undetected", "Undetected", "start", "detect"),
    span("unacked", "Waiting for a responder", "detect", "ack"),
    span("mitigating", "Diagnosing and mitigating", "ack", "mitigate"),
    span("recovering", "Recovering", "mitigate", "resolve"),
  ].filter(Boolean);
}

export function parseActions(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [what, owner = "", priority = ""] = l.split("|").map((s) => s.trim());
      return { what, owner, priority };
    });
}

export function fmtMinutes(m) {
  if (m == null) return "n/a";
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return r ? `${h} h ${r} min` : `${h} h`;
}

const clock = (t) => new Date(t).toISOString().slice(11, 16);
const esc = (s) => String(s).replace(/\|/g, "\\|");

/** A blameless postmortem draft in Markdown, with the facts filled in and the judgment left to people. */
export function toMarkdown(doc) {
  const { events } = parseTimeline(doc.timeline);
  const m = metrics(events);
  const sev = suggestSeverity(m.impactMinutes, doc.usersAffected);
  const used = budgetUsed(m.impactMinutes, doc.usersAffected, doc.slo);
  const start = m.first.start ?? events[0]?.at;
  const offset = (t) => (start == null ? "" : `T${t >= start ? "+" : "-"}${Math.round(Math.abs(t - start) / 60000)}m`);
  const lines = [
    `# Postmortem: ${doc.title || "Untitled incident"}`,
    "",
    `**Service:** ${doc.service || "n/a"}  `,
    `**Date:** ${start != null ? new Date(start).toISOString().slice(0, 10) : "n/a"} (times in UTC)  `,
    `**Suggested severity:** ${sev.level ? `SEV${sev.level}` : "n/a"} (${sev.why})  `,
    `**Status:** Draft`,
    "",
    "This review is blameless. It describes what the systems and the process did, so that the fixes target them.",
    "",
    "## Impact",
    "",
    `About ${Math.round(doc.usersAffected * 100)}% of users or requests were affected for ${fmtMinutes(m.impactMinutes)}.` +
      (used != null ? ` That used ${Math.round(used * 100)}% of the 30-day error budget for a ${doc.slo}% SLO.` : ""),
    "",
    "## Response metrics",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Time to detect | ${fmtMinutes(m.timeToDetect)} |`,
    `| Time to acknowledge | ${fmtMinutes(m.timeToAck)} |`,
    `| Time to mitigate | ${fmtMinutes(m.timeToMitigate)} |`,
    `| Time to resolve | ${fmtMinutes(m.timeToResolve)} |`,
    "",
    "## Timeline",
    "",
    "| Time (UTC) | Offset | Event |",
    "|---|---|---|",
    ...events.map((e) => `| ${clock(e.at)} | ${offset(e.at)} | ${e.tag !== "note" ? `**${TAG_LABELS[e.tag]}:** ` : ""}${esc(e.text)} |`),
    "",
    "## What went well",
    "",
    "- ",
    "",
    "## What went wrong",
    "",
    "- ",
    "",
    "## Where we got lucky",
    "",
    "- ",
    "",
    "## Action items",
    "",
  ];
  const actions = parseActions(doc.actions || "");
  if (actions.length) {
    lines.push("| Action | Owner | Priority |", "|---|---|---|", ...actions.map((a) => `| ${esc(a.what)} | ${esc(a.owner)} | ${esc(a.priority)} |`));
  } else lines.push("- ");
  return lines.join("\n") + "\n";
}

export function encodeDoc(doc) {
  const json = JSON.stringify(doc);
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeDoc(hash) {
  try {
    const b64 = String(hash).replace(/^#/, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!b64) return null;
    const d = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (typeof d.timeline !== "string") return null;
    return {
      title: String(d.title ?? ""),
      service: String(d.service ?? ""),
      usersAffected: Math.min(1, Math.max(0, Number(d.usersAffected) || 0)),
      slo: Number(d.slo) > 0 && Number(d.slo) < 100 ? Number(d.slo) : 99.9,
      timeline: d.timeline,
      actions: String(d.actions ?? ""),
    };
  } catch {
    return null;
  }
}
