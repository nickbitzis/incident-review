import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SAMPLE, budgetUsed, decodeDoc, encodeDoc, fmtMinutes, metrics, parseActions, parseTimeline, phases,
  suggestSeverity, toMarkdown,
} from "../src/incident.js";

test("the sample parses cleanly with every milestone", () => {
  const { events, problems } = parseTimeline(SAMPLE.timeline);
  assert.deepEqual(problems, []);
  assert.equal(events.length, 9);
  assert.deepEqual(events.filter((e) => e.tag !== "note").map((e) => e.tag), ["start", "detect", "ack", "mitigate", "resolve"]);
  assert.equal(events[1].text, "Error rate on POST /checkout climbs from 0.1% to 34%");
});

test("metrics match the sample by hand", () => {
  const m = metrics(parseTimeline(SAMPLE.timeline).events);
  assert.deepEqual(m.problems, []);
  assert.equal(m.timeToDetect, 7);
  assert.equal(m.timeToAck, 7);
  assert.equal(m.timeToMitigate, 29);
  assert.equal(m.timeToResolve, 63);
  assert.equal(m.impactMinutes, 29);
});

test("times roll over midnight and dates carry forward", () => {
  const { events } = parseTimeline("2026-03-01 23:50 [start] a\n23:58 [detect] b\n00:10 [mitigate] c\n2026-03-05 08:00 later");
  assert.equal(new Date(events[2].at).toISOString(), "2026-03-02T00:10:00.000Z");
  assert.equal(metrics(events).timeToMitigate, 20);
  assert.equal(new Date(events[3].at).toISOString(), "2026-03-05T08:00:00.000Z");
});

test("bad lines are reported with their line numbers", () => {
  const { events, problems } = parseTimeline("09:00 no date yet\n2026-01-01 25:00 bad\nnot a time\n2026-01-01 10:00 [oops] x");
  assert.equal(events.length, 1);
  assert.equal(events[0].tag, "note");
  assert.match(problems[0], /^Line 1: the first event needs a date/);
  assert.match(problems[1], /^Line 2: 25:00 is not a valid time/);
  assert.match(problems[2], /^Line 3: start with a time/);
  assert.match(problems[3], /^Line 4: unknown tag \[oops\]/);
});

test("missing and out-of-order milestones are flagged", () => {
  const m = metrics(parseTimeline("2026-01-01 10:00 [detect] d\n10:05 [start] s\n10:20 [resolve] r").events);
  assert.ok(m.problems.some((p) => p.includes("No [ack]")));
  assert.ok(m.problems.some((p) => p.includes("[detect] comes before [start]")));
  assert.equal(m.timeToAck, null);
  assert.equal(m.impactMinutes, 15); // falls back to resolve when there is no mitigate
});

test("error budget used is weighted by reach", () => {
  // 99.9% over 30 days allows 43.2 minutes.
  assert.ok(Math.abs(budgetUsed(43.2, 1, 99.9) - 1) < 1e-9);
  assert.ok(Math.abs(budgetUsed(29, 0.35, 99.9) - (29 * 0.35) / 43.2) < 1e-9);
  assert.equal(budgetUsed(null, 1, 99.9), null);
});

test("severity rubric", () => {
  assert.equal(suggestSeverity(29, 0.35).level, 1);
  assert.equal(suggestSeverity(20, 0.1).level, 2);
  assert.equal(suggestSeverity(40, 0.01).level, 3);
  assert.equal(suggestSeverity(5, 0.01).level, 4);
  assert.equal(suggestSeverity(null, 1).level, null);
});

test("phases run from one milestone to the next", () => {
  const p = phases(metrics(parseTimeline(SAMPLE.timeline).events));
  assert.deepEqual(p.map((x) => x.key), ["undetected", "unacked", "mitigating", "recovering"]);
  assert.equal((p[0].to - p[0].from) / 60000, 7);
});

test("action items split on pipes", () => {
  assert.deepEqual(parseActions("Fix it | ops | P1\n\nJust a thing"), [
    { what: "Fix it", owner: "ops", priority: "P1" },
    { what: "Just a thing", owner: "", priority: "" },
  ]);
});

test("minute formatting", () => {
  assert.equal(fmtMinutes(7), "7 min");
  assert.equal(fmtMinutes(63), "1 h 3 min");
  assert.equal(fmtMinutes(120), "2 h");
  assert.equal(fmtMinutes(null), "n/a");
});

test("postmortem draft has the facts and blank judgment sections", () => {
  const md = toMarkdown(SAMPLE);
  assert.match(md, /^# Postmortem: Checkout errors after a payment config deploy\n/);
  assert.match(md, /\*\*Suggested severity:\*\* SEV1/);
  assert.match(md, /affected for 29 min\. That used 23% of the 30-day error budget/);
  assert.match(md, /\| Time to resolve \| 1 h 3 min \|/);
  assert.match(md, /\| 09:31 \| T\+29m \| \*\*Mitigated:\*\* Deploy 4812 rolled back/);
  assert.match(md, /## Where we got lucky\n\n- \n/);
  assert.match(md, /\| Page on checkout error rate after 2 minutes instead of 5 \| on-call lead \| P1 \|/);
});

test("pipes in event text do not break the Markdown table", () => {
  const md = toMarkdown({ ...SAMPLE, timeline: "2026-01-01 10:00 [start] a | b" });
  assert.match(md, /a \\\| b/);
});

test("documents round-trip through the URL and junk is rejected", () => {
  const doc = { ...SAMPLE, title: "Ünïcode ✓ outage" };
  assert.deepEqual(decodeDoc(`#${encodeDoc(doc)}`), doc);
  assert.equal(decodeDoc("#%%%"), null);
  assert.equal(decodeDoc(""), null);
});
