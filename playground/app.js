import { VList } from "./list.js";
import { CodeView, esc, lineHTML, language } from "./code.js";
import { CAP, ROOT, sample, parseRepo, cleanPath, github, pickFolder, fromInput, fromDrop } from "./load.js";
import { initTour } from "./tour.js";

const $ = (s) => document.querySelector(s);
const SAMPLE = "samples/scrutate-src.json";
const ENGINE = "scrutate.wasm";
const GREP_CAP = 5000;
const PREWARM = 20e6;
const enc = new TextEncoder();
const dec = new TextDecoder();
const num = (n) => Number(n).toLocaleString("en-US");
const mb = (n) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
const ms = (n) => (n < 1000 ? `${n < 10 ? n.toFixed(1) : Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const narrow = matchMedia("(max-width: 760px)");

const CMDS = {
  grep: { eng: "A", about: "Reads every file as it is. No index.", hint: "a pattern, like fn \\w+_dir" },
  search: { eng: "B", about: "Ranks definitions by meaning, name and words.", hint: "plain words, like read a gitignore file" },
  symbol: { eng: "B", about: "Where a name is defined.", hint: "a name or Class.method" },
  callers: { eng: "B", about: "The functions that call this one.", hint: "a function, like tokenize2" },
  callees: { eng: "B", about: "The functions this one calls.", hint: "a function, like Index.open" },
  refs: { eng: "B", about: "Every use of a name, tied to its definition.", hint: "a name, like query_words" },
  similar: { eng: "B", about: "Definitions that look like this one.", hint: "a name, like FuzzyMatcher.new" },
};
const LIMIT = { symbol: ["--limit", 20], callers: ["--limit", 30], callees: ["--limit", 40], refs: ["--max-results", 200] };
const MAX_N = 2000;
const EXAMPLES = {
  sample: {
    grep: [
      { q: "indexDir", m: "ident", t: "any casing" },
      { q: "dirctory", m: "fuzzy", f: 1, t: "1 edit away" },
      { q: "fn \\w+_dir\\(", m: "regex", t: "regex" },
      { q: ".unwrap()", m: "literal", g: "*.rs", t: "literal, Rust files" },
      { q: "TODO|FIXME", m: "regex" },
    ],
    search: ["walk the directory tree in parallel", "read a gitignore file", "where is the index file opened", "detect binary files"].map((q) => ({ q })),
    symbol: ["Index.open", "FuzzyMatcher", "tokenize"].map((q) => ({ q })),
    callers: ["tokenize2", "Index.open", "query_words"].map((q) => ({ q })),
    callees: ["Index.open", "build_rows"].map((q) => ({ q })),
    refs: ["query_words", "tokenize"].map((q) => ({ q })),
    similar: ["FuzzyMatcher.new", "tokenize2"].map((q) => ({ q })),
  },
  other: {
    grep: [{ q: "TODO|FIXME", m: "regex" }, { q: "readFile", m: "ident", t: "any casing" }, { q: "eror", m: "fuzzy", f: 1, t: "1 edit away" }],
    search: ["where are errors handled", "read the configuration", "parse the command line"].map((q) => ({ q })),
    symbol: [{ q: "main" }],
  },
};
const REPOS = ["BurntSushi/walkdir", "pallets/click", "expressjs/express", "gorilla/mux"];

const K_DEFAULT = 8;
const S = { c: "grep", q: "", m: "regex", f: 1, i: false, w: false, g: "", k: K_DEFAULT, n: 0, open: "" };
let src = { kind: "sample" };
let badRepo = "";
{
  const p = new URLSearchParams(location.search);
  if (![...p.keys()].length) Object.assign(S, { q: "indexDir", m: "ident" });
  if (CMDS[p.get("c")]) S.c = p.get("c");
  S.q = p.get("q") ?? S.q;
  if (["regex", "literal", "ident", "fuzzy"].includes(p.get("m"))) S.m = p.get("m");
  if (["1", "2", "3"].includes(p.get("f"))) S.f = Number(p.get("f"));
  S.i = p.get("i") === "1";
  S.w = p.get("w") === "1";
  S.g = p.get("g") ?? "";
  if (["8", "20", "50"].includes(p.get("k"))) S.k = Number(p.get("k"));
  if (/^\d{1,4}$/.test(p.get("n") || "")) S.n = Number(p.get("n"));
  S.open = p.get("open") || "";
  const r = p.get("repo") && parseRepo(p.get("repo"));
  if (r) src = { kind: "github", ...r, ref: p.get("ref") || r.ref, sub: cleanPath(p.get("path") || "") || r.sub };
  else if (p.get("repo")) badRepo = p.get("repo").slice(0, 100);
}

function writeUrl() {
  const p = new URLSearchParams();
  if (S.c !== "grep") p.set("c", S.c);
  if (S.q) p.set("q", S.q);
  if (S.c === "grep") {
    if (S.m !== "regex") p.set("m", S.m);
    if (S.m === "fuzzy" && S.f !== 1) p.set("f", S.f);
    if (S.i) p.set("i", "1");
    if (S.w) p.set("w", "1");
    if (S.g) p.set("g", S.g);
  }
  if (S.c === "search" && S.k !== K_DEFAULT) p.set("k", S.k);
  if (S.n && LIMIT[S.c]) p.set("n", S.n);
  if (src.kind === "github") {
    p.set("repo", `${src.owner}/${src.repo}`);
    if (src.ref) p.set("ref", src.ref);
    if (src.sub) p.set("path", src.sub);
  }
  if (S.open) p.set("open", S.open);
  const s = p.toString();
  history.replaceState(null, "", `${location.pathname}${s ? `?${s}` : ""}`);
}

let module = null;
let engineMeta = null;
let version = "";
let ready = false;

class Engine {
  constructor() {
    this.seq = 0;
    this.wait = new Map();
    this.start();
  }
  start() {
    if (this.w) this.w.terminate();
    for (const p of this.wait.values()) p.reject(new Error("stopped"));
    this.wait.clear();
    this.dead = "";
    this.w = new Worker("worker.js", { type: "module" });
    this.w.onmessage = ({ data: m }) => this.got(m);
    this.w.onerror = (e) => {
      e.preventDefault();
      this.fail(e.message || "the engine worker stopped");
    };
    if (module) this.give();
  }
  give() {
    try {
      this.w.postMessage({ type: "engine", module });
    } catch {
      this.w.postMessage({ type: "engine", url: ENGINE });
    }
  }
  got(m) {
    if (m.type === "stderr") return this.wait.get(m.id)?.err?.(m.text);
    if (m.type === "fatal" && m.id == null) return engineFailed(new Error(m.message));
    const p = this.wait.get(m.id);
    if (!p) return;
    this.wait.delete(m.id);
    if (m.type === "fatal") p.reject(new Error(m.message));
    else p.resolve(m);
  }
  fail(message) {
    this.dead = message;
    for (const p of this.wait.values()) p.reject(new Error(message));
    this.wait.clear();
  }
  call(msg, err) {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.wait.set(id, { resolve, reject, err });
      this.w.postMessage({ ...msg, id });
    });
  }
  send(msg, transfer) {
    this.w.postMessage(msg, transfer || []);
  }
  get idle() {
    return !this.dead && this.wait.size === 0;
  }
}
const A = new Engine();
const B = new Engine();
// File reads and snippets go to the grep worker unless it is busy and the index one is not.
const fileWorker = () => (!A.dead && (A.idle || !B.idle) ? A : B);

async function fetchEngine() {
  try {
    // engine.json, written by the deploy next to the wasm, holds its real size: a compressed
    // response's content-length is not, and the stream counts uncompressed bytes.
    const [res, meta] = await Promise.all([fetch(ENGINE), fetch("engine.json").then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
    engineMeta = meta;
    if (!res.ok) throw new Error(`${ENGINE} answered HTTP ${res.status}`);
    const total = (meta && meta.bytes) || (!res.headers.get("content-encoding") && Number(res.headers.get("content-length"))) || 0;
    let compiling;
    if (WebAssembly.compileStreaming && res.body) {
      const [a, b] = res.body.tee();
      compiling = WebAssembly.compileStreaming(new Response(a, { headers: { "Content-Type": "application/wasm" } }));
      const reader = b.getReader();
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
        engineProgress(got, total);
      }
      engineProgress(got, got, true);
    } else {
      compiling = res.arrayBuffer().then((buf) => WebAssembly.compile(buf));
    }
    module = await compiling;
  } catch (e) {
    return engineFailed(e);
  }
  A.give();
  B.give();
  try {
    const v = await A.call({ type: "run", args: ["--version"] });
    version = v.stdout.trim();
  } catch (e) {
    return engineFailed(e);
  }
  ready = true;
  $("#ver").innerHTML = `<b>${esc(version || "scrutate")}</b> wasm32-wasip1`;
  const from = engineMeta && engineMeta.scrutate ? `Built from scrutate ${engineMeta.ref || "commit"} at ${engineMeta.scrutate.slice(0, 7)}. ` : "";
  $("#ver").title = `${from}The scrutate binary compiled to wasm32-wasip1, one thread, run in Web Workers`;
  if (files.bytes <= PREWARM || CMDS[S.c].eng === "B") ensureIndex();
  go();
}

const boot = { got: 0, total: 0, done: false, error: "" };
let bootRaf = 0;
function engineProgress(got, total, done) {
  Object.assign(boot, { got, total, done: !!done });
  // A frame callback can come late in a background tab, after the results; never paint over them.
  if (!bootRaf) bootRaf = requestAnimationFrame(() => {
    bootRaf = 0;
    if (!ready) paintBoot();
  });
}

function engineFailed(e) {
  boot.error = e.message || String(e);
  ready = false;
  $("#ver").textContent = "engine failed";
  paintBoot();
}

let gen = 0;
// Counts the file trees sent to the workers; gen counts loads, which start before the tree changes.
let tree = 0;
let files = { name: "", paths: [], bytes: 0, commit: "", left: null };
const texts = new Map();
let loading = null;
let lastError = "";

function srcLabel() {
  if (src.kind === "sample") return ["scrutate's own source", files.commit ? `at ${files.commit}` : ""];
  if (src.kind === "github") return [`${src.owner}/${src.repo}${src.sub ? `/${src.sub}` : ""}`, src.ref ? `at ${src.ref}` : "on GitHub"];
  return [files.name, "on this computer"];
}

function paintSource(note) {
  const [name, where] = srcLabel();
  $("#src-name").textContent = name || "No code";
  $("#src-meta").textContent = files.paths.length ? `${where}, ${plural(files.paths.length, "file")}, ${mb(files.bytes)}` : where;
  const l = files.left;
  const out = l ? (l.cap || 0) : 0;
  $("#src-note").textContent = note ?? (l && l.truncated ? `GitHub listed only part of this ${src.sub ? "folder" : "repository"}: load a folder inside it with a .../tree/BRANCH/FOLDER link` : out ? `${plural(out, "file")} left out: the playground holds up to ${num(CAP.files)} files and ${mb(CAP.bytes)}` : l && l.failed ? `${plural(l.failed, "file")} did not download` : "");
}

async function useSource(next, job) {
  if (loading) loading.abort();
  const ctl = new AbortController();
  loading = ctl;
  const mine = ++gen;
  // Updated in place, so the Stop button stays the same element while files arrive.
  const status = (text, frac) => {
    if (gen !== mine) return;
    const d = $("#dstat");
    const n = $("#src-note");
    if (!d.querySelector(".t")) d.innerHTML = '<span class="t"></span> <button class="btn" type="button" data-do="stop">Stop</button><div class="meter"><i></i></div>';
    if (!n.querySelector(".t")) n.innerHTML = '<span class="t"></span> <span class="bar"><i></i></span>';
    for (const el of [d, n]) {
      el.querySelector(".t").textContent = text;
      el.lastElementChild.hidden = frac == null;
      el.lastElementChild.firstElementChild.style.width = `${Math.round((frac || 0) * 100)}%`;
    }
  };
  $("#derr").textContent = "";
  let data;
  try {
    data = await job(status, ctl.signal);
  } catch (e) {
    if (gen !== mine) return false;
    loading = null;
    $("#dstat").textContent = "";
    paintSource();
    if (e.name === "AbortError") return false;
    lastError = e.message;
    $("#derr").textContent = e.message;
    if (!$("#dlg").open) toast(e.message);
    return false;
  }
  if (gen !== mine) return false;
  // Stop throws away a load whose reader did not take the signal.
  if (ctl.signal.aborted) data = null;
  if (!data) {
    loading = null;
    $("#dstat").textContent = "";
    paintSource();
    return false;
  }
  loading = null;
  src = next;
  files = { name: data.name || "", commit: data.commit || "", paths: data.files.map((f) => f[0]), bytes: data.bytes, left: data.left };
  texts.clear();
  tree++;
  previewSeq++;
  if (mine > 1) B.start();
  const transfer = data.files.map((f) => f[1]).filter((b) => b instanceof ArrayBuffer);
  // B gets a copy first: the transfer to A detaches the buffers.
  B.send({ type: "files", files: data.files });
  A.send({ type: "files", files: data.files }, transfer);
  clearInterval(ixTimer);
  Object.assign(IX, { state: "none", error: "", stats: null });
  paintIndexState();
  $("#dstat").textContent = "";
  if ($("#dlg").open) $("#dlg").close();
  paintSource();
  if (mine > 1) S.open = "";
  last = null;
  // The old rows name files of the old tree; the new results replace them.
  list.set([]);
  code.clear();
  paintFileHead(null);
  paintExamples();
  writeUrl();
  if (ready && (files.bytes <= PREWARM || CMDS[S.c].eng === "B")) ensureIndex();
  if (!ready) paintBoot();
  go();
  return true;
}

const loadSample = () => useSource({ kind: "sample" }, (status) => sample(SAMPLE, status));
const loadRepo = (r) => useSource({ kind: "github", ...r }, (status, signal) => github(r, status, signal));

const IX = { state: "none", t0: 0, ms: 0, done: 0, total: 0, phase: "", stats: null, error: "", summary: "" };
let ixTimer = 0;

async function ensureIndex() {
  if (IX.state !== "none" || !module || !files.paths.length) return;
  const mine = tree;
  Object.assign(IX, { state: "building", t0: performance.now(), done: 0, total: files.paths.length, phase: "files", error: "" });
  clearInterval(ixTimer);
  ixTimer = setInterval(paintIndexState, 100);
  paintIndexState();
  let tail = "";
  try {
    const r = await B.call({ type: "run", args: ["index", "--root", ROOT], live: true }, (text) => {
      tail = (tail + text).slice(-600);
      const a = [...tail.matchAll(/indexing (\d+)\/(\d+)/g)].at(-1);
      const t = [...tail.matchAll(/text index: (\d+)\/(\d+)/g)].at(-1);
      if (t) Object.assign(IX, { phase: "text", done: +t[1], total: +t[2] });
      else if (a) Object.assign(IX, { phase: "files", done: +a[1], total: +a[2] });
    });
    if (tree !== mine) return;
    if (r.code !== 0) throw new Error(r.stderr.replace(/\r/g, "\n").split("\n").filter((l) => l.trim() && !l.startsWith("[scrutate]")).join("\n") || `exit code ${r.code}`);
    IX.ms = r.ms;
    IX.summary = r.stdout.trim();
    const s = await B.call({ type: "run", args: ["stats", "--root", ROOT] });
    if (tree !== mine) return;
    try {
      IX.stats = JSON.parse(s.stdout);
    } catch {
      IX.stats = null;
    }
    IX.state = "ready";
  } catch (e) {
    if (tree !== mine) return;
    IX.state = "failed";
    IX.error = e.message;
  } finally {
    if (tree === mine) clearInterval(ixTimer);
  }
  paintIndexState();
  if (CMDS[S.c].eng === "B") go();
}

function paintIndexState() {
  const el = $("#ix-state");
  el.classList.toggle("busy", IX.state === "building");
  el.textContent = IX.state === "building" ? `indexing ${ms(performance.now() - IX.t0)}` : IX.state === "ready" ? `index built in ${ms(IX.ms)}` : IX.state === "failed" ? "index failed" : "index";
  if (CMDS[S.c].eng === "B" && IX.state !== "ready" && view.kind !== "boot") paintIndexPanel();
}

function paintIndexPanel() {
  if (IX.state === "failed") {
    // A worker that died (out of memory, most often) has lost its copy of the files.
    const again = B.dead ? "<p>The index worker stopped. Load the code again, or reload the page, to try again.</p>" : "";
    showMsg("bad", "The index did not build", `<pre>${esc(IX.error)}</pre><p>Engine A still works on this code.</p>${again}<div class="row"><button class="btn" type="button" data-cmd="grep">Use grep</button>${B.dead ? "" : '<button class="btn" type="button" data-do="reindex">Try again</button>'}</div>`);
    document.dispatchEvent(new Event("scrutate:failed"));
    return;
  }
  if (IX.state === "none") {
    return showMsg("", "The index is not built yet", `<p>Engine B answers from an index of this code. Building it reads every file once, in this tab, and takes a few seconds for a small repository.</p><div class="row"><button class="btn main" type="button" data-do="reindex">Build the index</button></div>`);
  }
  const t = (performance.now() - IX.t0) / 1000;
  const text = IX.phase === "text";
  const frac = IX.total ? IX.done / IX.total : 0;
  const steps = [
    ["Parse every file with tree-sitter, embed each definition, store symbols and call edges", text ? "done" : "now"],
    ["Write the trigram text index", text ? "now" : ""],
  ];
  const known = IX.done ? `${num(IX.done)} of ${num(IX.total)} files` : `${plural(IX.total, "file")}`;
  showMsg("", `Building the index: ${t.toFixed(1)} s`, `<p>scrutate index runs in this tab, on ${known}. Your search runs as soon as it is done.</p><div class="meter${IX.done ? "" : " wait"}"><i style="width:${IX.done ? Math.round(frac * 100) : 30}%"></i></div><ul class="steps">${steps.map(([s, k]) => `<li class="${k}">${esc(s)}</li>`).join("")}</ul><p class="dim">Grep keeps working while it builds: it runs in its own worker.</p>`);
  $("#stats").textContent = "Waiting for the index";
}

function quote(s) {
  return /^[\w./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function grepFlags() {
  const a = [];
  if (S.m === "literal") a.push("-F");
  if (S.m === "ident") a.push("--ident");
  if (S.m === "fuzzy") a.push(`--fuzzy=${S.f}`);
  if (S.i) a.push("-i");
  if (S.w) a.push("-w");
  for (const g of S.g.split(/\s+/).filter(Boolean)) a.push("-g", g);
  return a;
}

function indexFlags(c) {
  const a = [];
  if (c === "search" && S.k !== K_DEFAULT) a.push("-k", String(S.k));
  if (S.n && LIMIT[c]) a.push(LIMIT[c][0], String(S.n));
  return a;
}

function spec(flagsOnly) {
  const q = S.c === "grep" ? S.q : S.q.trim();
  const c = S.c;
  if (flagsOnly) {
    const extra = c === "grep" ? grepFlags() : indexFlags(c);
    return { cli: ["scrutate", c, ...extra] };
  }
  if (!q) return { c, eng: CMDS[c].eng, empty: true, cli: ["scrutate", c] };
  if (c === "grep") {
    const flags = grepFlags();
    const pat = q.startsWith("-") ? ["-e", q] : [q];
    return { c, eng: "A", args: ["grep", "--json", "--max-results", String(GREP_CAP), ...flags, ...pat, ROOT], parse: "grep", cli: ["scrutate", "grep", ...flags, ...pat] };
  }
  const extra = indexFlags(c);
  const tail = q.startsWith("-") ? ["--", q] : [q];
  return { c, eng: "B", q, args: [c, "--root", ROOT, "--json", ...extra, ...tail], parse: "doc", cli: ["scrutate", c, ...extra, ...tail] };
}

function cliText(sp) {
  return sp.cli.map((x, k) => (k < 2 ? x : quote(x))).join(" ");
}

// The prompt shows the flags in front of the box, so prompt and box read as the command line.
function paintCli(sp) {
  const flags = sp.empty ? spec(true).cli : sp.cli;
  const tail = S.c === "grep" ? (S.q.startsWith("-") ? 2 : 1) : S.q.trim().startsWith("-") ? 2 : 1;
  $("#qflags").textContent = flags.slice(2, sp.empty ? flags.length : flags.length - tail).map(quote).join(" ");
  $("#copy-cli").title = `Copy: ${cliText(sp)}`;
}

const jobs = { A: { busy: false, again: false }, B: { busy: false, again: false } };
let timer = 0;

function schedule(now) {
  const sp = spec();
  paintCli(sp);
  writeUrl();
  clearTimeout(timer);
  timer = setTimeout(go, now ? 0 : 50);
}

function busyDot() {
  $("#run").classList.toggle("on", jobs.A.busy || jobs.B.busy);
}

async function go() {
  const sp = spec();
  paintCli(sp);
  if (!files.paths.length || !ready) return paintBoot();
  if (sp.empty) return paintEmpty(sp);
  if (sp.eng === "B" && IX.state !== "ready") {
    if (IX.state === "none" && module) ensureIndex();
    return paintIndexPanel();
  }
  const lane = jobs[sp.eng];
  if (lane.busy) {
    lane.again = true;
    return;
  }
  lane.busy = true;
  busyDot();
  const key = JSON.stringify(sp.args) + tree;
  const mine = tree;
  try {
    const r = await (sp.eng === "A" ? A : B).call({ type: "run", args: sp.args, parse: sp.parse });
    if (mine === tree && JSON.stringify(spec().args) + tree === key) {
      await show(sp, r);
      document.dispatchEvent(new Event("scrutate:shown"));
    }
  } catch (e) {
    if (mine === tree && e.message !== "stopped") {
      showMsg("bad", "The engine stopped", `<pre>${esc(e.message)}</pre><p>${sp.eng === "B" ? "Load the code again, or reload the page" : "Reload the page"} to start it again.</p>`);
      document.dispatchEvent(new Event("scrutate:failed"));
    }
  } finally {
    lane.busy = false;
    busyDot();
    if (lane.again) {
      lane.again = false;
      go();
    }
  }
}

const list = new VList($("#res"), renderRow);
const code = new CodeView($("#code"));
let view = { kind: "none" };
let last = null;

function showMsg(kind, title, body, keepList) {
  const m = $("#msg");
  m.className = `msg${kind ? ` ${kind}` : ""}${keepList ? "" : " full"}`;
  m.innerHTML = `<h2>${esc(title)}</h2>${body}`;
  m.hidden = false;
  $("#res").hidden = !keepList;
  if (!keepList) {
    view = { kind: "msg" };
    list.set([]);
  }
}

function hideMsg() {
  $("#msg").hidden = true;
  $("#res").hidden = false;
  $("#res").classList.remove("stale");
}

function stats(html, err) {
  const s = $("#stats");
  s.className = `stats${err ? " err" : ""}`;
  s.innerHTML = html;
  clearTimeout(stats.t);
  stats.t = setTimeout(() => ($("#live").textContent = s.textContent), 700);
}

function pathHTML(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? `<b>${esc(p)}</b>` : `<span class="d">${esc(p.slice(0, i + 1))}</span>${esc(p.slice(i + 1))}`;
}

function paintBoot() {
  view = view.kind === "boot" ? view : { kind: "boot" };
  if (boot.error) {
    stats("The engine did not load", true);
    return showMsg("bad", "The engine did not load", `<pre>${esc(boot.error)}</pre><p>The playground needs scrutate.wasm next to this page. Reload to try again.</p>`);
  }
  if (!files.paths.length) {
    stats("Loading the code");
    return showMsg("", "Loading the code", `<div class="meter wait"><i></i></div>`);
  }
  const frac = boot.done ? 1 : boot.total ? Math.min(0.99, boot.got / boot.total) : 0;
  const amount = boot.done ? `${mb(boot.got)}, starting` : boot.total ? `${mb(boot.got)} of ${mb(boot.total)}` : mb(boot.got);
  const meter = boot.total || boot.done ? `<div class="meter"><i style="width:${(frac * 100).toFixed(1)}%"></i></div>` : `<div class="meter wait"><i></i></div>`;
  stats(`Loading the engine: ${amount}`);
  showMsg("", "Loading the engine", `${meter}<p class="mono">${esc(amount)}</p><p>The whole scrutate binary, compiled to WebAssembly, with both engines and the models it ranks with. It downloads once, then your browser keeps it.</p><p>Your search runs the moment it is ready. Meanwhile, here are the ${plural(files.paths.length, "file")} it will search.</p>`, true);
  if (list.rows.length !== files.paths.length || list.rows[0]?.t !== "file") {
    list.set(files.paths.map((p) => ({ t: "file", h: 24, pick: true, cls: "fl", path: p, label: esc(p) })));
  }
}

function paintEmpty(sp) {
  view = { kind: "empty" };
  list.set([]);
  if (sp.eng === "A") {
    stats(`Ready: ${plural(files.paths.length, "file")} to search`);
    return showMsg("", "Type a pattern", `<p>Results appear as you type. A regex by default, or pick Literal, Any casing or Fuzzy.</p>`);
  }
  if (IX.state !== "ready") return paintIndexPanel();
  stats("Ready: the index is built");
  const s = IX.stats || {};
  const kv = [["files", s.files], ["chunks", s.chunks], ["symbols", s.symbols], ["call edges", s.call_edges], ["imports", s.imports]].filter(([, v]) => v != null);
  showMsg("", "The index is ready", `<div class="kv">${kv.map(([k, v]) => `<span><b>${num(v)}</b> ${k}</span>`).join("")}<span>built in <b>${ms(IX.ms)}</b> in this tab</span></div><p>${esc(CMDS[sp.c].about)} Pick an example above, or type.</p>`);
}

async function show(sp, r) {
  if (r.error && !(sp.eng === "B" && /no symbol or location matches|names no definition/i.test(r.error))) return showError(sp, r);
  if (sp.c === "grep") return showGrep(sp, r);
  return showIndex(sp, r);
}

function showError(sp, r) {
  const regex = sp.c === "grep" && /regex parse error|invalid pattern/i.test(r.error);
  stats(esc(regex ? "Not a valid regex" : r.error.split("\n")[0]), true);
  let actions = "";
  if (regex) actions = `<div class="row"><button class="btn" type="button" data-mode="literal">Search it as literal text <code>-F</code></button></div>`;
  else if (/glob/i.test(r.error)) actions = `<div class="row"><button class="btn" type="button" data-do="noglob">Clear the file filter</button></div>`;
  // Half-typed patterns are often invalid for a moment: keep the last results under the message.
  const keep = view.kind === "list";
  showMsg("bad", regex ? "Not a valid regex" : "The command failed", `<pre>${esc(r.error)}</pre>${actions}`, keep);
  $("#res").classList.toggle("stale", keep);
}

function suggestions(sp) {
  const b = [];
  const word = /^[\w$.:-]+$/.test(sp.cli.at(-1));
  if (sp.c === "grep") {
    if (S.m !== "ident" && word) b.push(`<button class="btn" type="button" data-mode="ident">Try any casing <code>--ident</code></button>`);
    if (S.m !== "fuzzy") b.push(`<button class="btn" type="button" data-mode="fuzzy">Try within 1 edit <code>--fuzzy=1</code></button>`);
    else if (S.f < 3) b.push(`<button class="btn" type="button" data-do="fuzzier">Try within ${S.f + 1} edits</button>`);
    if (S.g) b.push(`<button class="btn" type="button" data-do="noglob">Search every file</button>`);
    if (S.w) b.push(`<button class="btn" type="button" data-do="nowords">Allow part words</button>`);
  } else if (sp.c !== "search") {
    b.push(`<button class="btn" type="button" data-cmd="search">Search by meaning instead</button>`);
    b.push(`<button class="btn" type="button" data-cmd="grep">Grep for it</button>`);
  }
  return b.length ? `<div class="row">${b.join("")}</div>` : "";
}

function showGrep(sp, r) {
  const n = r.summary ? r.summary.matches : r.files.reduce((k, f) => k + f.hits.length, 0);
  const sum = r.summary || { matches: n, files_matched: r.files.length, files_searched: files.paths.length, bytes_searched: files.bytes, elapsed_ms: r.ms, cancelled: false };
  const warn = r.warnings.length ? ` <span class="dim">(${plural(r.warnings.length, "warning")})</span>` : "";
  if (!n) {
    stats(`No matches in ${plural(sum.files_searched, "file")}, ${ms(sum.elapsed_ms)}${warn}`);
    view = { kind: "none" };
    closeFile();
    return showMsg("", "No matches", `<p>Nothing matches <code>${esc(sp.cli.at(-1))}</code> with these options.</p>${suggestions(sp)}`);
  }
  const cut = sum && sum.cancelled;
  const head = cut ? `First <b>${num(n)}</b> matches, in ${plural(sum.files_matched, "file")} (the page stops at ${num(GREP_CAP)})` : `<b>${num(n)}</b> ${n === 1 ? "match" : "matches"} in <b>${num(sum.files_matched)}</b> of ${plural(sum.files_searched, "file")} (${mb(sum.bytes_searched)})`;
  stats(`${head} in <b>${ms(sum.elapsed_ms)}</b>${warn}`);
  $("#stats").title = `${ms(sum.elapsed_ms)} is the engine's own count. The whole run, from start to exit in the worker, took ${ms(r.ms)}.`;
  const rows = [];
  for (const f of r.files) {
    rows.push({ t: "f", group: true, h: 30, cls: "fh", path: f.path, n: f.hits.length });
    for (const h of f.hits) rows.push({ t: "m", pick: true, h: 22, cls: "mr", path: f.path, line: h.line, text: h.text, sp: h.sp, label: esc(`${f.path} line ${h.line}: ${h.text.trim().slice(0, 120)}`) });
  }
  last = { kind: "grep", byPath: new Map(r.files.map((f) => [f.path, new Map(f.hits.map((h) => [h.line, h.sp]))])) };
  present(rows);
}

const OWNER_SEP = /::|\.|#|->/;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function lastSeg(name) {
  return name.split(OWNER_SEP).filter(Boolean).at(-1) || name;
}

function wordAt(text, word, from = 0) {
  const re = new RegExp(`(?<![\\w$])${reEsc(word)}(?![\\w$])`, "g");
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : -1;
}

// Where some lines call the function a callers query names: as Owner::name (or . # ->) when the
// query has an owner and any line spells it so, else as the bare word. Columns per line.
function sites(lines, q) {
  const parts = q.trim().split(OWNER_SEP).filter(Boolean);
  const name = parts.at(-1) || q.trim();
  const e = reEsc;
  const scan = (re) => lines.map((l) => [...(l || "").matchAll(re)].map((m) => m.index + m[0].length - name.length));
  let at = parts.length > 1 ? scan(new RegExp(`(?<![\\w$])${e(parts.at(-2))}\\s*(?:::|\\.|#|->)\\s*${e(name)}(?![\\w$])`, "g")) : null;
  if (!at || !at.some((a) => a.length)) at = scan(new RegExp(`(?<![\\w$])${e(name)}(?![\\w$])`, "g"));
  return { name, at };
}

function callSites(row, lines) {
  const s = sites(lines, S.q);
  row.sites = s;
  let k = s.at.findIndex((a, i) => i > 0 && a.length);
  if (k < 0 && s.at[0] && s.at[0].length) k = 0;
  row.call = k >= 0 ? row.item.start + k : 0;
}

function card(item, c, rank) {
  const span = Math.max(1, item.end - item.start + 1);
  const lines = c === "callers" ? Math.min(3, span) : Math.min(4, span);
  const why = item.why && Object.keys(item.why).length;
  return { t: "card", pick: true, cls: "card", h: 48 + (why ? 20 : 0) + lines * 18 + 12, item, c, rank, lines, snip: null, path: item.path, line: item.start, label: esc(`${item.name || item.qualname}, ${item.kind}, ${item.path} line ${item.start}`) };
}

function showIndex(sp, r) {
  const d = r.data && typeof r.data === "object" ? r.data.result : null;
  const took = ` in <b>${ms(r.ms)}</b>`;
  const rows = [];
  let head = "";
  let none = !d || (Array.isArray(d) && !d.length);
  const stopped = r.data && r.data.stopped_at;
  if (sp.c === "refs" && d) {
    const uses = d.definitions.reduce((k, x) => k + x.references.length, 0);
    none = !uses && !d.unresolved.length && !d.definitions.length;
    head = `<b>${num(uses)}</b> ${uses === 1 ? "use" : "uses"} of ${plural(d.definitions.length, "definition")}${d.unresolved.length ? `, ${num(d.unresolved.length)} unresolved` : ""}`;
    const name = lastSeg(d.name || sp.q);
    for (const def of d.definitions) {
      rows.push({ t: "rg", group: true, h: 32, cls: "rg", title: def.qualname, kind: def.kind, path: def.path, line: def.start, n: def.references.length });
      for (const u of def.references) rows.push(refRow(u, name, u.via, def));
    }
    if (d.unresolved.length) {
      rows.push({ t: "rg", group: true, h: 32, cls: "rg", title: "Unresolved", sub: "uses the resolver could not tie to one definition", n: d.unresolved.length });
      for (const u of d.unresolved) rows.push(refRow(u, name, u.reason, null));
    }
    const cap = S.n || LIMIT.refs[1];
    if (d.truncated) rows.push(noteRow(`Stopped at ${num(cap)} uses.`, cap < MAX_N ? "more" : ""));
  } else if (sp.c === "callees" && d) {
    none = !d.resolved.length && !d.external.length;
    head = `<b>${num(d.resolved.length)}</b> in the repository, ${num(d.external.length)} from outside it`;
    d.resolved.forEach((x, k) => rows.push(card(x, "callees", k + 1)));
    if (d.external.length) rows.push(noteRow(`Outside the repository: <span class="x">${d.external.map(esc).join(", ")}</span>`, "", d.external.join(", ").length));
    if (stopped) rows.push(noteRow(`Stopped at ${num(stopped)} callees.`, "more"));
  } else if (Array.isArray(d)) {
    const word = { search: "result", symbol: "definition", callers: "caller", similar: "similar definition" }[sp.c];
    head = `<b>${num(d.length)}</b> ${d.length === 1 ? word : `${word}s`}`;
    d.forEach((x, k) => rows.push(card({ ...x, name: x.name || x.qualname }, sp.c, k + 1)));
    if (stopped) rows.push(noteRow(`Stopped at ${num(stopped)} ${word}s.`, "more"));
  }
  if (none) {
    stats(`Nothing found${took}`);
    view = { kind: "none" };
    closeFile();
    const what = sp.c === "search" ? `Nothing in the index matches <code>${esc(sp.q)}</code>.` : r.error ? esc(r.error) : `No definition named <code>${esc(sp.q)}</code> is in the index.`;
    return showMsg("", "Nothing found", `<p>${what}</p>${suggestions(sp)}`);
  }
  stats(`${head}${took}`);
  $("#stats").title = `${ms(r.ms)}: the command's run in the index worker, from start to exit.`;
  last = { kind: sp.c, rows };
  present(rows);
  snippets(rows);
}

function refRow(u, name, via, def) {
  let col = Math.max(0, (u.column || 1) - 1);
  if (/[^\x00-\x7f]/.test(u.text)) col = dec.decode(enc.encode(u.text).subarray(0, col)).length;
  if (u.text.substr(col, name.length) !== name) {
    const k = wordAt(u.text, name);
    col = k >= 0 ? k : -1;
  }
  return { t: "r", pick: true, h: 46, cls: "rr", path: u.path, line: u.line, text: u.text, via, col, len: name.length, def, label: esc(`${u.path} line ${u.line}: ${u.text.trim().slice(0, 120)}`) };
}

function noteRow(html, act, chars) {
  const width = Math.max(200, $("#res").clientWidth - 32);
  const lines = chars ? Math.ceil((chars * 7.9 + 160) / width) : 1;
  return { t: "note", h: 22 + lines * 20 + (act ? 30 : 0), cls: "note", html, act };
}

async function snippets(rows) {
  const cards = rows.filter((r) => r.t === "card");
  if (!cards.length) return;
  const eng = fileWorker();
  const mine = view;
  try {
    const r = await eng.call({ type: "snip", want: cards.map((c) => [c.item.path, c.item.start, c.item.end]) });
    if (view !== mine) return;
    cards.forEach((c, k) => {
      c.snip = r.lines[k] || [];
      if (c.c === "callers") callSites(c, c.snip);
    });
    list.paint(true);
    const sel = list.rows[list.sel];
    if (sel && sel.t === "card" && cards.includes(sel)) preview(sel, false);
  } catch {}
}

function present(rows) {
  const w = $("#pane-res").clientWidth;
  if (w) fit = Math.max(24, Math.floor((w - 100) / code.charWidth()));
  hideMsg();
  view = { kind: "list", rows };
  list.set(rows);
  let pick = -1;
  if (S.open) {
    const [p, l] = splitOpen(S.open);
    pick = rows.findIndex((x) => x.pick && x.path === p && (!l || x.line === l || (x.item && l >= x.item.start && l <= x.item.end)));
  }
  if (pick < 0) pick = rows.findIndex((x) => x.pick);
  if (pick >= 0) {
    list.select(pick);
    preview(rows[pick], false);
  }
}

function splitOpen(s) {
  const m = s.match(/^(.*?)(?::(\d+))?$/);
  return [m[1], m[2] ? Number(m[2]) : 0];
}

let fit = 60;

// Shifts a long line so its first mark shows in a row as wide as the list.
function matchHTML(text, sp) {
  const lead = text.match(/^\s*/)[0].length;
  let start = sp.length ? Math.min(lead, sp[0]) : lead;
  if (sp.length && sp[0] - start > fit - 14) start = sp[0] - Math.min(24, Math.floor(fit / 4));
  const marks = sp.map((x) => x - start);
  return (start > lead ? '<span class="dim">...</span>' : "") + lineHTML(text.slice(start), null, marks.length ? marks : null);
}

function snipHTML(row) {
  const it = row.item;
  const name = lastSeg(row.c === "callers" ? S.q.trim() : it.name);
  const lines = row.snip;
  const out = [];
  if (!lines) {
    for (let k = 0; k < row.lines; k++) out.push(`<div class="sl"><span class="ln">${it.start + k}</span><span class="tx"></span></div>`);
    return out.join("");
  }
  let picks = [];
  if (row.c === "callers") {
    const call = row.call ? row.call - it.start : -1;
    picks = call <= 2 ? [0, 1, 2].slice(0, row.lines) : [0, -1, call];
  } else picks = Array.from({ length: row.lines }, (_, k) => k);
  const shown = picks.filter((k) => k >= 0 && lines[k] != null).map((k) => lines[k]);
  const indent = Math.min(...shown.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length), 99);
  for (const k of picks) {
    if (k < 0) {
      out.push(`<div class="sl gap"><span class="ln"></span><span class="tx">...</span></div>`);
      continue;
    }
    const raw = lines[k] ?? "";
    const cut = Math.min(indent, raw.match(/^\s*/)[0].length);
    const text = raw.slice(cut);
    let marks = null;
    if (row.c === "callers") {
      const cols = row.sites && row.sites.at[k];
      if (cols && cols.length) marks = cols.flatMap((c) => [c - cut, c - cut + name.length]);
    } else if (k === 0) {
      const at = wordAt(text, name);
      if (at >= 0) marks = [at, at + name.length];
    }
    out.push(`<div class="sl"><span class="ln">${it.start + k}</span><span class="tx">${lineHTML(text, null, marks)}</span></div>`);
  }
  return out.join("");
}

function nameHTML(name) {
  const seg = lastSeg(name);
  const i = name.lastIndexOf(seg);
  return i > 0 ? `<span class="q">${esc(name.slice(0, i))}</span>${esc(seg)}` : esc(name);
}

const CALLABLE = /^(function|method|constructor|macro)$/;
const NO_NAME = /^(section|window|module|constant|impl)$/;

function actsFor(row) {
  const k = row.item.kind || "";
  if (NO_NAME.test(k)) return k === "impl" ? ["refs", "similar"] : k === "constant" ? ["refs"] : [];
  return [...(CALLABLE.test(k) ? ["callers"] : []), "refs", "similar"];
}

const WHY = { semantic: "meaning", "name keywords": "name", "body keywords": "body", "docs keywords": "docs", "signature keywords": "signature" };

function renderRow(row) {
  switch (row.t) {
    case "f":
      return `<span class="fp">${pathHTML(row.path)}</span><span class="cnt">${num(row.n)}</span>`;
    case "m":
      return `<span class="ln">${row.line}</span><span class="tx">${row.html ??= matchHTML(row.text, row.sp)}</span>`;
    case "file":
      return `<span class="fp">${pathHTML(row.path)}</span>`;
    case "card": {
      const it = row.item;
      const score = row.c === "search" ? `<span class="sc" title="ranker score">${it.score.toFixed(2)}</span>` : row.c === "similar" ? `<span class="sc" title="cosine of the vectors, and the Jaccard index of the tokens">cos ${it.cosine.toFixed(2)} jac ${it.jaccard.toFixed(2)}</span>` : "";
      const why = it.why && Object.keys(it.why).length ? `<div class="why">${Object.entries(it.why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span>${esc(WHY[k] || k)} <b>${v.toFixed(2)}</b></span>`).join("")}</div>` : "";
      const acts = `<span class="acts">${actsFor(row).map((a) => `<button type="button" tabindex="-1" data-act="${a}">${a}<kbd>${a[0]}</kbd></button>`).join("")}</span>`;
      return `<div class="ch"><span class="rk">${row.rank}</span><span class="nm">${nameHTML(it.name)}</span><span class="kd">${esc(it.kind)}</span><span class="grow"></span>${score}${acts}</div><div class="cloc">${pathHTML(it.path)}:${it.start}${it.end > it.start ? `-${it.end}` : ""}</div>${why}<div class="sn">${snipHTML(row)}</div>`;
    }
    case "rg":
      return `<span class="t">${esc(row.title)} ${row.sub ? `<span>${esc(row.sub)}</span>` : `<span>${esc(row.kind)}, ${esc(row.path)}:${row.line}</span>`}</span><span class="cnt">${num(row.n)}</span>`;
    case "r": {
      const text = row.text.replace(/\s+$/, "");
      return `<div class="top2"><span class="loc">${pathHTML(row.path)}:${row.line}</span><span class="via">${esc(row.via || "")}</span></div><div class="code"><span class="tx">${row.html ??= matchHTML(text, row.col >= 0 ? [row.col, row.col + row.len] : [])}</span></div>`;
    }
    case "note":
      return `${row.html}${row.act ? `<br><button class="btn" type="button" data-act="${row.act}" tabindex="-1">Show more</button>` : ""}`;
  }
  return "";
}

async function fileText(path) {
  if (texts.has(path)) return texts.get(path);
  const eng = fileWorker();
  const mine = tree;
  const r = await eng.call({ type: "file", path });
  if (r.text != null && mine === tree) {
    if (texts.size > 24) texts.delete(texts.keys().next().value);
    texts.set(path, r.text);
  }
  return r.text;
}

// The previous search's file and marks would read as this search's answer.
function closeFile() {
  previewSeq++;
  S.open = "";
  paintFileHead(null);
}

function paintFileHead(row, lines) {
  if (!row) {
    code.clear('<p class="empty">Pick a result to read its file here, with the match marked.</p>');
    $("#fpath").textContent = "No file open";
    $("#flang").textContent = "";
    $("#fgh").hidden = true;
    return;
  }
  $("#fpath").innerHTML = pathHTML(row.path);
  $("#fpath").title = row.path;
  const at = row.target || row.line;
  $("#flang").textContent = [at ? `line ${num(at)}${lines ? ` of ${num(lines)}` : ""}` : "", language(row.path)].filter(Boolean).join(" · ");
  if (src.kind === "github") {
    const ref = src.ref || "HEAD";
    const full = `${src.sub ? `${src.sub}/` : ""}${row.path}`;
    const range = row.t === "card" ? `#L${row.item.start}-L${row.item.end}` : at ? `#L${at}` : "";
    $("#fgh").href = `https://github.com/${src.owner}/${src.repo}/blob/${ref.split("/").map(encodeURIComponent).join("/")}/${full.split("/").map(encodeURIComponent).join("/")}${range}`;
    $("#fgh").hidden = false;
  } else $("#fgh").hidden = true;
}

let previewSeq = 0;
async function preview(row, focus) {
  const mine = ++previewSeq;
  const text = await fileText(row.path).catch(() => null);
  if (mine !== previewSeq) return;
  if (text == null) {
    paintFileHead(row);
    code.clear('<p class="empty">That file is not loaded.</p>');
    return;
  }
  let line = row.line || 1;
  let range = null;
  const marks = new Map();
  if (row.t === "m" && last && last.byPath) {
    for (const [l, sp] of last.byPath.get(row.path) || []) if (sp.length) marks.set(l, sp);
  } else if (row.t === "card") {
    range = [row.item.start, row.item.end];
    const name = lastSeg(row.c === "callers" ? S.q.trim() : row.item.name);
    const lines = text.split("\n", row.item.end);
    if (row.c === "callers") {
      if (!row.sites) callSites(row, lines.slice(row.item.start - 1));
      row.sites.at.forEach((cols, k) => cols.length && marks.set(row.item.start + k, cols.flatMap((c) => [c, c + name.length])));
    } else {
      const k = wordAt(lines[row.item.start - 1] || "", name);
      if (k >= 0) marks.set(row.item.start, [k, k + name.length]);
    }
    line = row.c === "callers" && row.call ? row.call : row.item.start;
  } else if (row.t === "r" && last && last.rows) {
    for (const x of last.rows) {
      if (x.t === "r" && x.path === row.path && x.col >= 0) marks.set(x.line, [x.col, x.col + x.len]);
    }
  }
  row.target = line;
  if (focus && narrow.matches) {
    $("#split").dataset.view = "file";
    $("#split").scrollIntoView({ block: "start" });
  }
  code.show({ path: row.path, text, line, range, marks });
  paintFileHead(row, code.doc.lines.length);
  if (focus) $("#code").focus({ preventScroll: true });
}

function pickRow(i, focus) {
  const row = list.rows[i];
  if (!row || !row.pick) return;
  list.select(i);
  S.open = row.t === "file" ? row.path : `${row.path}:${row.t === "card" && row.c === "callers" && row.call ? row.call : row.line}`;
  writeUrl();
  preview(row, focus);
}

function paintControls() {
  $("#q").value = S.q;
  $("#q").placeholder = CMDS[S.c].hint;
  $("#qcmd").textContent = S.c;
  $("#about").textContent = CMDS[S.c].about;
  for (const t of document.querySelectorAll(".tab")) {
    const on = t.dataset.cmd === S.c;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
  }
  $("#opts-grep").hidden = S.c !== "grep";
  $("#opts-k").hidden = S.c !== "search";
  for (const b of document.querySelectorAll("[data-mode]")) if (b.closest(".seg")) b.setAttribute("aria-pressed", String(b.dataset.mode === S.m));
  for (const b of document.querySelectorAll("[data-k]")) b.setAttribute("aria-pressed", String(Number(b.dataset.k) === S.k));
  $("#fz").hidden = S.m !== "fuzzy";
  $("#f").value = String(S.f);
  $("#i").checked = S.i;
  $("#w").checked = S.w;
  $("#g").value = S.g;
  paintExamples();
  paintCli(spec());
}

function examples(c = S.c) {
  return (src.kind === "sample" ? EXAMPLES.sample : EXAMPLES.other)[c] || [];
}

function useExample(ex) {
  Object.assign(S, { q: ex.q, open: "", n: 0 });
  if (S.c === "grep") Object.assign(S, { m: ex.m || "regex", f: ex.f || 1, i: false, w: false, g: ex.g || "" });
  paintControls();
  schedule(true);
}

function paintExamples() {
  const set = examples();
  $("#ex").innerHTML = set.length ? `<span>Try</span> ${set.map((e, k) => `<button type="button" data-ex="${k}">${esc(e.q)}${e.t ? ` <span>${esc(e.t)}</span>` : ""}</button>`).join("")}` : `<span>Pick a name from a search result, or press c, r, s or d on a selected result.</span>`;
}

function setCmd(c, q) {
  if (!CMDS[c]) return;
  S.c = c;
  if (q != null) S.q = q;
  S.n = 0;
  S.open = "";
  paintControls();
  schedule(true);
}

$("#q").addEventListener("input", (e) => {
  S.q = e.target.value;
  S.open = "";
  schedule();
});
$("#q").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const i = list.move(e.key === "ArrowDown" ? 1 : -1);
    if (i < 0) return;
    $("#q").setAttribute("aria-activedescendant", list.id(i));
    pickRow(i, false);
  } else if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(timer);
    go();
    if (view.kind === "list") $("#res").focus();
  }
});
$("#q").addEventListener("blur", () => $("#q").removeAttribute("aria-activedescendant"));

const tabs = [...document.querySelectorAll(".tab")];
for (const t of tabs) {
  t.addEventListener("click", () => setCmd(t.dataset.cmd));
  t.addEventListener("keydown", (e) => {
    const k = tabs.indexOf(t);
    const to = e.key === "ArrowRight" ? k + 1 : e.key === "ArrowLeft" ? k - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -2;
    if (to === -2) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    next.focus();
    setCmd(next.dataset.cmd);
  });
}
document.querySelector(".seg[aria-label='Pattern kind']").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (!b) return;
  S.m = b.dataset.mode;
  paintControls();
  schedule(true);
});
$("#opts-k").addEventListener("click", (e) => {
  const b = e.target.closest("[data-k]");
  if (!b) return;
  S.k = Number(b.dataset.k);
  paintControls();
  schedule(true);
});
$("#f").addEventListener("change", (e) => {
  S.f = Number(e.target.value);
  schedule(true);
});
for (const k of ["i", "w"]) $(`#${k}`).addEventListener("change", (e) => {
  S[k] = e.target.checked;
  schedule(true);
});
$("#g").addEventListener("input", (e) => {
  S.g = e.target.value.trim();
  schedule();
});
$("#ex").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ex]");
  if (!b) return;
  useExample(examples()[Number(b.dataset.ex)]);
});

// Buttons inside the message panel and the result rows.
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-do], #msg [data-mode], #msg [data-cmd]");
  if (!b) return;
  if (b.dataset.mode) {
    S.m = b.dataset.mode;
    if (S.m === "fuzzy") S.f = 1;
    paintControls();
    schedule(true);
  } else if (b.dataset.cmd) setCmd(b.dataset.cmd);
  else act(b.dataset.do);
});

function act(what) {
  if (what === "sample") loadSample();
  else if (what === "stop") loading?.abort();
  else if (what === "source") openSource();
  else if (what === "reindex") {
    IX.state = "none";
    ensureIndex();
  } else if (what === "noglob") {
    S.g = "";
    paintControls();
    schedule(true);
  } else if (what === "nowords") {
    S.w = false;
    paintControls();
    schedule(true);
  } else if (what === "fuzzier") {
    S.f = Math.min(3, S.f + 1);
    paintControls();
    schedule(true);
  }
}

function rowAction(what, row) {
  if (what === "more") {
    const base = LIMIT[S.c] ? LIMIT[S.c][1] : 30;
    S.n = Math.min(MAX_N, Math.max(base, S.n || base) * 5);
    return schedule(true);
  }
  if (!row || row.t !== "card") return;
  const name = row.item.name;
  setCmd(what, name);
}

$("#res").addEventListener("click", (e) => {
  const actBtn = e.target.closest("[data-act]");
  const el = e.target.closest("[data-i]");
  if (actBtn) {
    e.stopPropagation();
    return rowAction(actBtn.dataset.act, el && list.rows[Number(el.dataset.i)]);
  }
  if (el) pickRow(Number(el.dataset.i), narrow.matches);
});
const KEYS = { c: "callers", r: "refs", s: "similar", d: "symbol" };
$("#res").addEventListener("keydown", (e) => {
  const page = list.pageSize();
  const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -Infinity, End: Infinity };
  if (e.key in moves) {
    e.preventDefault();
    pickRow(list.move(moves[e.key]), false);
  } else if (e.key === "Enter" && list.sel >= 0) {
    e.preventDefault();
    pickRow(list.sel, true);
  } else if (e.key === "Escape") {
    e.preventDefault();
    $("#q").focus();
  } else if (!e.metaKey && !e.ctrlKey && !e.altKey && KEYS[e.key]) {
    const row = list.rows[list.sel];
    const what = KEYS[e.key];
    if (row && row.t === "card" && (what === "symbol" || actsFor(row).includes(what))) {
      e.preventDefault();
      rowAction(what, row);
    }
  }
});
$("#code").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    backToList();
  }
});
$("#back").addEventListener("click", backToList);
function backToList() {
  delete $("#split").dataset.view;
  if (narrow.matches) $("#split").scrollIntoView({ block: "start" });
  $("#res").focus({ preventScroll: true });
}

document.addEventListener("keydown", (e) => {
  const t = e.target;
  const typing = t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
  if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    $("#q").focus();
    $("#q").select();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    copyLink();
  }
});

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copyLink() {
  writeUrl();
  const ok = await copy(location.href);
  if (!ok) return toast("Copy the address bar: the clipboard is blocked here");
  toast(src.kind === "local" ? "Link copied. It opens the sample: your folder stays on your computer." : "Link copied: it opens this search, these options and this code");
}

$("#share").addEventListener("click", copyLink);
$("#copy-cli").addEventListener("click", async () => {
  toast((await copy(cliText(spec()))) ? "Command copied" : "The clipboard is blocked here");
});

const root = document.documentElement;
function theme() {
  return root.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}
function paintTheme() {
  const light = theme() === "light";
  $("#theme").classList.toggle("light", light);
  $("#theme").setAttribute("aria-label", light ? "Switch to the dark theme" : "Switch to the light theme");
  document.querySelector('meta[name="theme-color"]').content = light ? "#f2eee3" : "#0c0c0e";
}
$("#theme").addEventListener("click", () => {
  root.dataset.theme = theme() === "light" ? "dark" : "light";
  try {
    localStorage.setItem("scrutate-theme", root.dataset.theme);
  } catch {}
  paintTheme();
});
matchMedia("(prefers-color-scheme: light)").addEventListener("change", paintTheme);

{
  const g = $("#gutter");
  const split = $("#split");
  let pct = 46;
  try {
    pct = Number(localStorage.getItem("scrutate-split")) || 46;
  } catch {}
  const set = (p) => {
    pct = Math.max(20, Math.min(80, p));
    split.style.setProperty("--split", `${pct}%`);
    g.setAttribute("aria-valuenow", String(Math.round(pct)));
  };
  const save = () => {
    try {
      localStorage.setItem("scrutate-split", String(Math.round(pct)));
    } catch {}
  };
  set(pct);
  g.addEventListener("pointerdown", (e) => {
    g.setPointerCapture(e.pointerId);
    g.classList.add("drag");
    const box = split.getBoundingClientRect();
    const move = (ev) => set(((ev.clientX - box.left) / box.width) * 100);
    const up = () => {
      g.classList.remove("drag");
      g.removeEventListener("pointermove", move);
      save();
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", up, { once: true });
    g.addEventListener("pointercancel", up, { once: true });
  });
  g.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, Home: -100, End: 100 }[e.key];
    if (step == null) return;
    e.preventDefault();
    set(pct + step);
    save();
  });
}

function openSource() {
  $("#derr").textContent = "";
  if (!$("#dlg").open) $("#dlg").showModal();
  // On a phone this would pop up the keyboard over the other two choices.
  if (!narrow.matches) $("#gh").focus();
}
$("#src").addEventListener("click", openSource);
$("#use-sample").addEventListener("click", loadSample);
$("#gh-cap").textContent = `up to ${num(CAP.files)} files and ${num(CAP.bytes / 1e6)} MB, ${num(CAP.file / 1e6)} MB a file`;
$("#gh-ex").insertAdjacentHTML("beforeend", REPOS.map((r) => `<button class="chip" type="button" data-repo="${r}">${r}</button>`).join(""));
$("#gh-ex").addEventListener("click", (e) => {
  const b = e.target.closest("[data-repo]");
  if (!b) return;
  $("#gh").value = b.dataset.repo;
  $("#gh-form").requestSubmit();
});
$("#gh-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const r = parseRepo($("#gh").value);
  if (!r) {
    $("#derr").textContent = "Write it as owner/name, like BurntSushi/walkdir, or paste a github.com link.";
    return $("#gh").focus();
  }
  loadRepo(r);
});
$("#pick").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) return $("#dir").click();
  useSource({ kind: "local" }, async (status) => {
    try {
      return await pickFolder(status);
    } catch (e) {
      if (e.name === "AbortError") return null;
      throw e;
    }
  });
});
$("#dir").addEventListener("change", (e) => {
  const picked = e.target.files;
  if (picked && picked.length) useSource({ kind: "local" }, (status) => fromInput(picked, status));
  e.target.value = "";
});
{
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    $("#drop").hidden = false;
  });
  addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  addEventListener("dragleave", () => {
    if (--depth <= 0) {
      depth = 0;
      $("#drop").hidden = true;
    }
  });
  addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $("#drop").hidden = true;
    const dt = e.dataTransfer;
    useSource({ kind: "local" }, (status) => fromDrop(dt, status));
  });
}

paintTheme();
paintControls();
paintSource("Loading the code");
initTour({
  examples,
  run(c, ex) {
    S.c = c;
    useExample(ex);
  },
  save: () => ({ ...S }),
  restore(s) {
    Object.assign(S, s);
    paintControls();
    schedule(true);
  },
});
paintBoot();
if (src.kind === "github") {
  $("#gh").value = src.sub ? `https://github.com/${src.owner}/${src.repo}/tree/${src.ref || "HEAD"}/${src.sub}` : `${src.owner}/${src.repo}${src.ref ? `@${src.ref}` : ""}`;
  loadRepo({ owner: src.owner, repo: src.repo, ref: src.ref, sub: src.sub }).then(async (ok) => {
    // gen above 1: the person started another load, which the sample must not replace
    if (ok || files.paths.length || gen > 1) return;
    const why = lastError;
    src = { kind: "sample" };
    if (await loadSample()) paintSource(`${why ? `${why} ` : ""}Showing the sample instead.`);
  });
} else {
  loadSample().then((ok) => {
    if (ok && badRepo) paintSource(`The link's repo, "${badRepo}", is not a GitHub repository. Showing the sample instead.`);
  });
}
fetchEngine();
