// Runs scrutate's wasm on a file tree held in memory. The page starts two of these: one for
// grep and file reads, one for the index, so a long index build never blocks a search.
import { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory, Directory, OpenDirectory, wasi } from "./vendor/browser_wasi_shim/index.js";

// The shim has no readlink, and std's canonicalize calls it on each part of a path (the index
// does). Nothing in this tree is a link, so an existing path answers EINVAL, as POSIX does.
OpenDirectory.prototype.path_readlink = function (path) {
  const { ret } = this.path_filestat_get(0, path);
  return { ret: ret === 0 ? wasi.ERRNO_INVAL : ret, data: null };
};

const ROOT = "/w";
const LINE_CAP = 2000;
const enc = new TextEncoder();
const dec = new TextDecoder();
let engine = null;
let tree = new Map();
let flat = new Map();
const cache = new Map();
const waiting = [];

async function compile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return WebAssembly.compileStreaming ? WebAssembly.compileStreaming(res) : WebAssembly.compile(await res.arrayBuffer());
}

function load(entries) {
  flat = new Map();
  cache.clear();
  const top = new Map();
  let bytes = 0;
  for (const [path, data] of entries) {
    const body = typeof data === "string" ? enc.encode(data) : new Uint8Array(data);
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) continue;
    flat.set(parts.join("/"), body);
    bytes += body.byteLength;
    let dir = top;
    for (const p of parts.slice(0, -1)) {
      if (!(dir.get(p) instanceof Map)) dir.set(p, new Map());
      dir = dir.get(p);
    }
    dir.set(parts.at(-1), new File(body, { readonly: true }));
  }
  // Directory sets each child's parent when it is built, so build from the leaves up
  const build = (m) => new Map([...m].map(([k, v]) => [k, v instanceof Map ? new Directory(build(v)) : v]));
  tree = build(top);
  return { files: flat.size, bytes };
}

function entry(path) {
  let e = cache.get(path);
  if (!e) {
    const body = flat.get(path);
    if (!body) return null;
    e = { text: dec.decode(body), lines: null };
    if (cache.size > 48) cache.delete(cache.keys().next().value);
  } else cache.delete(path);
  cache.set(path, e);
  return e;
}

function linesOf(path) {
  const e = entry(path);
  if (!e) return null;
  e.lines ??= e.text.split("\n");
  return e.lines;
}

function concat(parts) {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return dec.decode(all);
}

function exec(id, args, live) {
  const out = [];
  const err = [];
  const stream = new TextDecoder();
  const fds = [
    new OpenFile(new File([])),
    new ConsoleStdout((d) => out.push(d)),
    new ConsoleStdout((d) => {
      err.push(d);
      if (live) postMessage({ type: "stderr", id, text: stream.decode(d, { stream: true }) });
    }),
    new PreopenDirectory(ROOT, tree),
  ];
  // debug must be false: the shim logs every syscall to the console when it is left out
  const w = new WASI(["scrutate", ...args], ["NO_COLOR=1"], fds, { debug: false });
  const inst = new WebAssembly.Instance(engine, { wasi_snapshot_preview1: w.wasiImport });
  const t0 = performance.now();
  let code;
  try {
    code = w.start(inst);
  } catch (e) {
    code = -1;
    err.push(enc.encode(`the engine stopped: ${e && e.message ? e.message : e}`));
  }
  return { code, ms: performance.now() - t0, stdout: concat(out), stderr: concat(err) };
}

// Byte offsets into a line, as grep reports them, to offsets into the JS string.
function chars(text, spans) {
  if (!/[^\x00-\x7f]/.test(text)) return spans;
  const b = enc.encode(text);
  return spans.map((n) => dec.decode(b.subarray(0, n)).length);
}

function problem(stderr) {
  let message = "";
  const warnings = [];
  for (const line of stderr.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("{")) {
      try {
        const r = JSON.parse(t);
        if (r.type === "error" || r.type === "internal_error") message ||= r.message;
        else if (r.type === "warning") warnings.push(r.message);
        continue;
      } catch {}
    }
    if (!message && /^(scrutate: )?error: /.test(t)) message = t.replace(/^(scrutate: )?error: /, "");
  }
  return { message: message || stderr.trim().split("\n")[0] || "", warnings };
}

function grep(r) {
  const files = [];
  const byPath = new Map();
  let summary = null;
  const warnings = [];
  let error = "";
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === "match") {
      const path = m.path.startsWith(`${ROOT}/`) ? m.path.slice(ROOT.length + 1) : m.path;
      let f = byPath.get(path);
      if (!f) {
        f = { path, hits: [] };
        byPath.set(path, f);
        files.push(f);
      }
      let text = m.text.replace(/\r?\n$/, "");
      const flatSpans = chars(m.text, m.spans.flatMap((s) => [s.start, s.end]));
      const sp = [];
      for (let i = 0; i < flatSpans.length; i += 2) if (flatSpans[i] < LINE_CAP) sp.push(flatSpans[i], Math.min(flatSpans[i + 1], LINE_CAP));
      if (text.length > LINE_CAP) text = text.slice(0, LINE_CAP);
      f.hits.push({ line: m.line, text, sp });
    } else if (m.type === "summary") summary = m;
    else if (m.type === "warning") warnings.push(m.message);
    else if (m.type === "error") error ||= m.message;
  }
  const p = problem(r.stderr);
  return { files, summary, warnings: warnings.concat(p.warnings), error: error || (r.code > 1 || r.code < 0 ? p.message : "") };
}

function doc(r) {
  const p = problem(r.stderr);
  let data = null;
  if (r.code === 0 || r.code === 1) {
    try {
      data = JSON.parse(r.stdout);
    } catch {
      data = r.stdout;
    }
  }
  return { data, error: r.code > 1 || r.code < 0 ? p.message || `exit code ${r.code}` : "", warnings: p.warnings };
}

async function handle(m) {
  if (m.type === "engine") {
    engine = m.module || (await compile(m.url));
    postMessage({ type: "engine" });
    for (const w of waiting.splice(0)) dispatch(w);
  } else if (m.type === "files") {
    postMessage({ type: "files", gen: m.gen, ...load(m.files) });
  } else if (m.type === "run") {
    if (!engine) return waiting.push(m);
    const r = exec(m.id, m.args, m.live);
    const body = m.parse === "grep" ? grep(r) : m.parse === "doc" ? doc(r) : { stdout: r.stdout, stderr: r.stderr };
    postMessage({ type: "result", id: m.id, code: r.code, ms: r.ms, ...body });
  } else if (m.type === "file") {
    const e = entry(m.path);
    postMessage({ type: "file", id: m.id, path: m.path, text: e ? e.text : null });
  } else if (m.type === "snip") {
    const out = m.want.map(([path, start, end]) => {
      const lines = linesOf(path);
      return lines ? lines.slice(start - 1, Math.min(end, start + 399)) : null;
    });
    postMessage({ type: "snip", id: m.id, lines: out });
  }
}

function dispatch(m) {
  handle(m).catch((e) => postMessage({ type: "fatal", for: m.type, id: m.id, message: String(e && e.message ? e.message : e) }));
}

onmessage = ({ data: m }) => dispatch(m);
