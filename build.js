#!/usr/bin/env node
// Zero-dependency generator: parses the scoping-pack markdown docs and emits data.js.
// Usage: node build.js [--src <docs-folder>]
"use strict";

const fs = require("fs");
const path = require("path");

// Single place to touch when the source docs legitimately regenerate.
const EXPECTED = {
  doc12Stories: 106,
  doc13Stories: 53,
  doc12Epics: 14,
  doc13Epics: 16,
  doc17Epics: 16,
  crossCutting: 13,
  optionA: 106, // doc12 A+B + A only
  optionB: 158, // doc12 A+B + doc13 B only
};

const argv = process.argv.slice(2);
const srcIdx = argv.indexOf("--src");
const SRC = path.resolve(
  srcIdx >= 0 ? argv[srcIdx + 1] : path.join(__dirname, "..", "Streaming", "docs")
);

const FILES = {
  12: path.join(SRC, "12-option-a-scope-and-stories.md"),
  13: path.join(SRC, "13-option-b-scope-and-stories.md"),
  17: path.join(SRC, "17-assumptions-and-opens.md"),
};

const errors = [];
const warnings = [];
const err = (file, line, msg) => errors.push(`${path.basename(file)}:${line}: ${msg}`);
const warn = (file, line, msg) => warnings.push(`${path.basename(file)}:${line}: ${msg}`);

const RE = {
  epic: /^## Epic ([A-Z]+(?:-[A-Z]+)*): (.+)$/,
  story: /^### ([A-Z]+(?:-[A-Z]+)*-\d{2}) - (.+)$/,
  field: /^- \*\*(.+?):\*\*\s*(.*)$/,
  fieldish: /^- \*\*/,
  gkOpen: /^(\s*)```gherkin\s*$/,
  gkClose: /^\s*```\s*$/,
  idToken: /[A-Z]+(?:-[A-Z]+)*-\d{2}/g,
  idRange: /([A-Z]+(?:-[A-Z]+)*-)(\d{2}) (?:through|to) \1(\d{2})/g,
  scenario: /^\s*Scenario(?: Outline)?:/,
  heading: /^#{1,3} /,
};

function readLines(p) {
  return fs.readFileSync(p, "utf8").split(/\r?\n/);
}

function parseStoryDoc(docNum) {
  const file = FILES[docNum];
  const lines = readLines(file);
  const epics = []; // {id, title, summary, sharedRef, storyIds}
  const stories = [];
  let epic = null;
  let story = null;
  let field = null; // current field object {label, value}
  let inGherkin = false;
  let gkIndent = 0;
  let gkLines = [];
  let intro = null;
  let introMode = 0; // 1 = waiting for paragraph after "## 1. What Option ... is"
  let paraBuf = []; // paragraph accumulator for epic prose (summary / sharedRef)

  const flushPara = (lineNo) => {
    if (!epic || story || paraBuf.length === 0) { paraBuf = []; return; }
    const text = paraBuf.join(" ").trim();
    paraBuf = [];
    if (!text || text.startsWith("|")) return;
    RE.idToken.lastIndex = 0;
    const hasOwnId = (text.match(RE.idToken) || []).some((t) => t.startsWith(epic.id + "-"));
    const isShared =
      /see doc 12/i.test(text) ||
      (hasOwnId && /appl/i.test(text) && /Option A|doc 12/i.test(text));
    if (isShared) {
      const ids = new Set();
      // expand "X-01 through X-08" ranges first
      let m;
      RE.idRange.lastIndex = 0;
      while ((m = RE.idRange.exec(text))) {
        const [, prefix, a, b] = m;
        for (let n = parseInt(a, 10); n <= parseInt(b, 10); n++) {
          ids.add(prefix + String(n).padStart(2, "0"));
        }
      }
      RE.idToken.lastIndex = 0;
      while ((m = RE.idToken.exec(text))) ids.add(m[0]);
      if (epic.sharedRef) {
        epic.sharedRef.text += " " + text;
        [...ids].forEach((i) => epic.sharedRef.resolvedIds.push(i));
        epic.sharedRef.resolvedIds = [...new Set(epic.sharedRef.resolvedIds)];
      } else {
        epic.sharedRef = { text, resolvedIds: [...ids].sort() };
      }
    } else if (!epic.summary) {
      epic.summary = text;
    }
  };

  const closeStory = () => {
    field = null;
    story = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const no = i + 1;

    if (inGherkin) {
      if (RE.gkClose.test(line)) {
        inGherkin = false;
        if (field) field.gherkinDone = true;
        const dedented = gkLines.map((l) => (l.startsWith(" ".repeat(gkIndent)) ? l.slice(gkIndent) : l.trimStart()));
        story.gherkin = dedented.join("\n").trimEnd();
        story.scenarioCount = dedented.filter((l) => RE.scenario.test(l)).length;
        gkLines = [];
      } else {
        gkLines.push(line);
      }
      continue;
    }

    let m;
    if ((m = line.match(RE.epic))) {
      flushPara(no);
      closeStory();
      let title = m[2].replace(/\s*\(Option B additions\)\s*$/, "").trim();
      epic = { id: m[1], title, summary: null, sharedRef: null, storyIds: [] };
      epics.push(epic);
      continue;
    }
    if ((m = line.match(RE.story))) {
      flushPara(no);
      closeStory();
      if (!epic) { err(file, no, `story ${m[1]} appears before any epic header`); continue; }
      const prefix = m[1].replace(/-\d{2}$/, "");
      if (prefix !== epic.id) err(file, no, `story ${m[1]} sits under epic ${epic.id} (prefix mismatch)`);
      story = {
        id: m[1], epicId: epic.id, doc: docNum, title: m[2].trim(),
        options: null, fields: [], gherkin: "", scenarioCount: 0,
        assumptionFlagged: false, sourceTypes: [], line: no,
      };
      stories.push(story);
      epic.storyIds.push(story.id);
      continue;
    }
    if (introMode === 0 && /^## 1\. What Option [AB] is$/.test(line)) { introMode = 1; continue; }
    if (introMode === 1) {
      if (line.trim()) { intro = (intro ? intro + " " : "") + line.trim(); }
      else if (intro) introMode = 2;
      continue;
    }
    if ((m = line.match(RE.gkOpen))) {
      if (!story) { err(file, no, "gherkin fence outside a story"); continue; }
      inGherkin = true;
      gkIndent = m[1].length;
      gkLines = [];
      continue;
    }
    if (story) {
      if ((m = line.match(RE.field))) {
        field = { label: m[1].trim(), value: m[2].trim() };
        story.fields.push(field);
        continue;
      }
      if (RE.fieldish.test(line)) { err(file, no, `malformed field bullet in ${story.id}: ${line.slice(0, 60)}`); continue; }
      if (RE.heading.test(line)) { closeStory(); i--; continue; } // reprocess as structural line
      if (line.trim() === "") { field = null; continue; }
      if (field) { field.value += (field.value ? "\n" : "") + line.trim(); continue; }
      // free prose / tables inside a story: keep as an ordered unlabeled block
      field = { label: "", value: line.trim() };
      story.fields.push(field);
      continue;
    }
    // outside stories: accumulate epic prose paragraphs
    if (epic && !RE.heading.test(line)) {
      if (line.trim() === "") flushPara(no);
      else paraBuf.push(line.trim());
    }
  }
  flushPara(lines.length);

  // per-story derivations + checks
  for (const s of stories) {
    const get = (label) => s.fields.find((f) => f.label === label);
    const opt = get("Options");
    s.options = opt ? opt.value.trim() : null;
    if (!["A+B", "A only", "B only"].includes(s.options || "")) {
      err(file, s.line, `${s.id}: bad or missing Options tag: "${s.options}"`);
    }
    for (const req of ["Story", "Source", "T-shirt size"]) {
      if (!get(req)) err(file, s.line, `${s.id}: missing required field "${req}"`);
    }
    if (s.scenarioCount < 1) err(file, s.line, `${s.id}: no Gherkin scenarios captured`);
    const raw = s.fields.map((f) => f.label + " " + f.value).join("\n") + "\n" + s.gherkin;
    s.assumptionFlagged = /client to confirm/i.test(raw);
    const src = get("Source") ? get("Source").value : "";
    const types = [];
    if (/\b(call|Jun|Jul)\b/i.test(src)) types.push("call");
    if (/allion/i.test(src)) types.push("allion");
    if (/assumption/i.test(src)) types.push("assumption");
    if (/decision register|register decision|register item|register #/i.test(src)) types.push("decision");
    s.sourceTypes = types;
    s.fields.forEach((f) => delete f.gherkinDone);
    delete s.line;
  }
  return { epics, stories, intro };
}

function parseAssumptions() {
  const file = FILES[17];
  const lines = readLines(file);
  const crossCutting = [];
  const perEpic = [];
  let section = 0; // 1 = cross-cutting, 2 = per-epic
  let cur = null;
  let mode = null; // 'a' | 'q'
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const no = i + 1;
    if (/^## 1\./.test(line)) { section = 1; continue; }
    if (/^## 2\./.test(line)) { section = 2; continue; }
    if (section === 1 && /^\| \d+ \|/.test(line)) {
      const cells = line.split("|").map((c) => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
      if (cells.length !== 3) { err(file, no, `cross-cutting row does not have 3 cells: ${line.slice(0, 50)}`); continue; }
      crossCutting.push({ n: parseInt(cells[0], 10), assumption: cells[1], impact: cells[2] });
      continue;
    }
    if (section === 2) {
      const m = line.match(/^### ([A-Z]+(?:-[A-Z]+)*)$/);
      if (m) { cur = { epicId: m[1], assumptions: [], openQuestions: [] }; perEpic.push(cur); mode = null; continue; }
      if (/^Assumptions:/.test(line)) { mode = "a"; continue; }
      if (/^Open questions:/.test(line)) { mode = "q"; continue; }
      if (cur && mode && /^- /.test(line)) {
        (mode === "a" ? cur.assumptions : cur.openQuestions).push(line.slice(2).trim());
      }
    }
  }
  return { crossCutting, perEpic };
}

// ---- parse ----
const d12 = parseStoryDoc(12);
const d13 = parseStoryDoc(13);
const d17 = parseAssumptions();

// ---- merge epics ----
const epicMap = new Map();
for (const e of d12.epics) {
  epicMap.set(e.id, { id: e.id, title: e.title, summaryA: e.summary, summaryB: null, sharedRef: null, inA: true, inB: true, storyIds: [...e.storyIds] });
}
for (const e of d13.epics) {
  if (epicMap.has(e.id)) {
    const t = epicMap.get(e.id);
    t.summaryB = e.summary;
    t.sharedRef = e.sharedRef;
    t.storyIds.push(...e.storyIds);
  } else {
    epicMap.set(e.id, { id: e.id, title: e.title, summaryA: null, summaryB: e.summary, sharedRef: e.sharedRef, inA: false, inB: true, storyIds: [...e.storyIds] });
  }
}
const epics = [...epicMap.values()];
const stories = [...d12.stories, ...d13.stories];
const byId = new Map(stories.map((s) => [s.id, s]));

// ---- validation ----
const f12 = FILES[12], f13 = FILES[13], f17 = FILES[17];
if (d12.stories.length !== EXPECTED.doc12Stories) err(f12, 0, `expected ${EXPECTED.doc12Stories} stories, found ${d12.stories.length}`);
if (d13.stories.length !== EXPECTED.doc13Stories) err(f13, 0, `expected ${EXPECTED.doc13Stories} stories, found ${d13.stories.length}`);
if (d12.epics.length !== EXPECTED.doc12Epics) err(f12, 0, `expected ${EXPECTED.doc12Epics} epics, found ${d12.epics.length}`);
if (d13.epics.length !== EXPECTED.doc13Epics) err(f13, 0, `expected ${EXPECTED.doc13Epics} epics, found ${d13.epics.length}`);
if (d17.perEpic.length !== EXPECTED.doc17Epics) err(f17, 0, `expected ${EXPECTED.doc17Epics} per-epic sections, found ${d17.perEpic.length}`);
if (d17.crossCutting.length !== EXPECTED.crossCutting) err(f17, 0, `expected ${EXPECTED.crossCutting} cross-cutting rows, found ${d17.crossCutting.length}`);

const seen = new Set();
for (const s of stories) {
  if (seen.has(s.id)) err(s.doc === 12 ? f12 : f13, 0, `duplicate story id ${s.id}`);
  seen.add(s.id);
  if (s.doc === 12 && s.options === "B only") err(f12, 0, `${s.id}: doc 12 story tagged B only`);
  if (s.doc === 13 && s.options !== "B only") err(f13, 0, `${s.id}: doc 13 story tagged "${s.options}" (must be B only)`);
}
for (const e of epics) {
  if (e.sharedRef) {
    for (const id of e.sharedRef.resolvedIds) {
      if (!byId.has(id)) err(f13, 0, `${e.id}: shared reference to unknown story ${id}`);
    }
    // chips list = only real shared (A+B) stories; contextual mentions of A-only/B-only stories stay in the text
    e.sharedRef.resolvedIds = e.sharedRef.resolvedIds.filter(
      (id) => byId.has(id) && byId.get(id).options === "A+B"
    );
    const abInEpic = stories.filter((s) => s.epicId === e.id && s.options === "A+B").map((s) => s.id);
    const missing = abInEpic.filter((id) => !e.sharedRef.resolvedIds.includes(id));
    if (missing.length) warn(f13, 0, `${e.id}: shared line omits A+B stories: ${missing.join(", ")}`);
  } else if (e.inA && e.inB && stories.some((s) => s.epicId === e.id && s.doc === 13)) {
    warn(f13, 0, `${e.id}: no shared-reference line detected for a shared epic`);
  }
}
const epicIds = new Set(epics.map((e) => e.id));
for (const pe of d17.perEpic) {
  if (!epicIds.has(pe.epicId)) err(f17, 0, `register epic ${pe.epicId} not found in docs 12/13`);
  if (pe.assumptions.length === 0) err(f17, 0, `${pe.epicId}: no assumptions captured`);
  if (pe.openQuestions.length === 0) err(f17, 0, `${pe.epicId}: no open questions captured`);
}
for (const id of epicIds) {
  if (!d17.perEpic.some((pe) => pe.epicId === id)) err(f17, 0, `epic ${id} has no register section`);
}
const optionA = stories.filter((s) => s.options === "A+B" || s.options === "A only").length;
const optionB = stories.filter((s) => s.options === "A+B" || s.options === "B only").length;
if (optionA !== EXPECTED.optionA) err(f12, 0, `Option A story count ${optionA}, expected ${EXPECTED.optionA}`);
if (optionB !== EXPECTED.optionB) err(f13, 0, `Option B story count ${optionB}, expected ${EXPECTED.optionB}`);

if (warnings.length) {
  console.warn(`\nWARNINGS (${warnings.length}):`);
  warnings.forEach((w) => console.warn("  " + w));
}
if (errors.length) {
  console.error(`\nVALIDATION FAILED (${errors.length} errors):`);
  errors.forEach((e) => console.error("  " + e));
  process.exit(1);
}

// ---- emit ----
const data = {
  generatedAt: new Date().toISOString(),
  counts: { optionA, optionB, doc12: d12.stories.length, doc13: d13.stories.length },
  meta: { intro: { A: d12.intro, B: d13.intro } },
  epics,
  stories,
  assumptions: d17,
};
const out = "window.SCOPE_DATA = " + JSON.stringify(data) + ";\n";
const outPath = path.join(__dirname, "data.js");
fs.writeFileSync(outPath, out, "utf8");

console.log("OK: data.js written", `(${(out.length / 1024).toFixed(0)} KB)`);
console.log(`  Option A: ${optionA} stories | Option B: ${optionB} stories`);
console.log(`  doc12: ${d12.stories.length} stories / ${d12.epics.length} epics; doc13: ${d13.stories.length} / ${d13.epics.length}`);
console.log(`  assumption-flagged stories: ${stories.filter((s) => s.assumptionFlagged).length}`);
console.log(`  register: ${d17.crossCutting.length} cross-cutting, ${d17.perEpic.length} epic sections`);
console.log("  per-epic: " + epics.map((e) => `${e.id}=${e.storyIds.length}`).join(" "));

// ---- wireframe validation (runs only when wireframes.js exists) ----
const wfPath = path.join(__dirname, "wireframes.js");
if (fs.existsSync(wfPath)) {
  const werr = [];
  const we = (msg) => werr.push(msg);
  global.window = global.window || {};
  require(wfPath);
  const W = global.window.SCOPE_WIREFRAMES;
  if (!W || !Array.isArray(W.screens)) {
    console.error("wireframes.js present but window.SCOPE_WIREFRAMES.screens missing");
    process.exit(1);
  }
  const VB = { tv: "0 0 640 360", wide: "0 0 640 360", phone: "0 0 260 540", web: "0 0 640 400" };
  const seenScreens = new Set();
  const coveredEpics = new Set();
  const scenarioNames = (story) =>
    (story.gherkin.match(/^\s*Scenario(?: Outline)?: .*$/gm) || []).map((x) =>
      x.replace(/^\s*Scenario(?: Outline)?: /, "").trim()
    );
  for (const sc of W.screens) {
    const tag = `screen ${sc.id}`;
    if (seenScreens.has(sc.id)) we(`${tag}: duplicate id`);
    seenScreens.add(sc.id);
    if (!["screen", "flow"].includes(sc.kind)) we(`${tag}: bad kind ${sc.kind}`);
    sc.epicIds.forEach((eid) => {
      if (!epicMap.has(eid)) we(`${tag}: unknown epic ${eid}`);
      coveredEpics.add(eid);
    });
    sc.storyIds.forEach((sid) => {
      const st = byId.get(sid);
      if (!st) return we(`${tag}: unknown story ${sid}`);
      if (!sc.epicIds.includes(st.epicId)) we(`${tag}: story ${sid} belongs to ${st.epicId}, not in epicIds`);
    });
    if (!sc.variants.length) we(`${tag}: no variants`);
    sc.variants.forEach((v, i) => {
      const s = v.svg.trim();
      const vtag = `${tag} variant ${i} (${v.device})`;
      if (!s.startsWith("<svg")) we(`${vtag}: does not start with <svg`);
      if (!VB[v.device]) we(`${vtag}: unknown device`);
      else if (s.indexOf(`viewBox="${VB[v.device]}"`) < 0) we(`${vtag}: viewBox is not "${VB[v.device]}"`);
      if (/<script/i.test(s)) we(`${vtag}: contains <script`);
      if (/\son[a-z]+\s*=/i.test(s)) we(`${vtag}: contains event handler attribute`);
      if (/<image|<foreignObject/i.test(s)) we(`${vtag}: contains image/foreignObject`);
      if (/url\s*\(/i.test(s)) we(`${vtag}: contains url() reference`);
      if (/https?:\/\//.test(s.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, ""))) we(`${vtag}: contains external URL`);
    });
    const nSeen = new Set();
    const primary = sc.variants[0] ? sc.variants[0].svg : "";
    sc.callouts.forEach((c) => {
      const ctag = `${tag} callout ${c.n}`;
      if (nSeen.has(c.n)) we(`${ctag}: duplicate n`);
      nSeen.add(c.n);
      if (!sc.storyIds.includes(c.storyId)) we(`${ctag}: storyId ${c.storyId} not in screen storyIds`);
      const st = byId.get(c.storyId);
      if (st && scenarioNames(st).indexOf(c.scenario) < 0)
        we(`${ctag}: scenario "${c.scenario}" not found in ${c.storyId}`);
      const badge = (primary.match(new RegExp(`data-n="${c.n}"`, "g")) || []).length;
      if (badge !== 1) we(`${ctag}: primary variant has ${badge} badges with data-n="${c.n}" (need exactly 1)`);
    });
    const emDash = JSON.stringify(sc).indexOf("—") >= 0;
    if (emDash) we(`${tag}: contains an em-dash character`);
  }
  const uncovered = [...epicMap.keys()].filter((id) => !coveredEpics.has(id));
  if (uncovered.length) we(`epics with no screen or flow coverage: ${uncovered.join(", ")}`);
  if (werr.length) {
    console.error(`\nWIREFRAME VALIDATION FAILED (${werr.length} errors):`);
    werr.forEach((x) => console.error("  " + x));
    process.exit(1);
  }
  const totCallouts = W.screens.reduce((n, s) => n + s.callouts.length, 0);
  const totVariants = W.screens.reduce((n, s) => n + s.variants.length, 0);
  console.log(`OK: wireframes validated: ${W.screens.length} screens/flows, ${totVariants} variants, ${totCallouts} callouts, all epics covered`);
}
