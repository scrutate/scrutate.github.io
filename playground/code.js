// Syntax colours from lezer (CodeMirror's parsers) and a read-only code view that renders only
// the lines on screen, so a 20,000-line file opens as fast as a short one.
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";

export const LH = 20;
const MAX_HIGHLIGHT = 1.5e6;
const LONG = 3000;

const hl = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self, t.tagName], class: "k" },
  { tag: [t.string, t.special(t.string), t.character, t.regexp, t.escape, t.attributeValue, t.url, t.link], class: "s" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "c" },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit, t.color, t.constant(t.variableName)], class: "n" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName), t.labelName], class: "t" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: "f" },
  { tag: [t.propertyName, t.attributeName], class: "p" },
  { tag: [t.meta, t.annotation, t.processingInstruction, t.documentMeta], class: "m" },
  { tag: [t.heading, t.strong], class: "h" },
  { tag: t.emphasis, class: "em" },
]);

const GRAMMAR = {
  rs: ["rust"], py: ["python"], pyi: ["python"], pyw: ["python"],
  js: ["javascript"], mjs: ["javascript"], cjs: ["javascript"], jsx: ["javascript", "jsx"],
  ts: ["javascript", "ts"], mts: ["javascript", "ts"], cts: ["javascript", "ts"], tsx: ["javascript", "ts jsx"],
  go: ["go"], java: ["java"],
  c: ["cpp"], h: ["cpp"], cc: ["cpp"], cpp: ["cpp"], cxx: ["cpp"], hpp: ["cpp"], hh: ["cpp"], hxx: ["cpp"], cu: ["cpp"], ino: ["cpp"],
  json: ["json"], css: ["css"], html: ["html"], htm: ["html"], vue: ["html"], svelte: ["html"],
  md: ["markdown"], markdown: ["markdown"], yaml: ["yaml"], yml: ["yaml"], php: ["php"],
  xml: ["xml"], svg: ["xml"], xsd: ["xml"], plist: ["xml"], csproj: ["xml"], xaml: ["xml"],
};
const NAMES = { rust: "Rust", python: "Python", javascript: "JavaScript", go: "Go", java: "Java", cpp: "C or C++", json: "JSON", css: "CSS", html: "HTML", markdown: "Markdown", yaml: "YAML", php: "PHP", xml: "XML" };
const HASH = new Set("sh bash zsh fish toml ini cfg conf rb pl pm r nix ps1 tf hcl mk cmake gd jl ex exs nim cr coffee graphql properties dockerfile makefile gitignore editorconfig env".split(" "));
const SLASH = new Set("cs kt kts swift scala dart zig sol groovy gradle gleam v odin glsl hlsl proto d fs fsx m mm ts2 qml bicep prisma jsonnet".split(" "));
const DASH = new Set("lua sql hs elm adb ads vhd vhdl".split(" "));
const SEMI = new Set("lisp el scm rkt clj cljs edn s asm ll".split(" "));
const KW = new Set(("if else elif elsif unless for foreach while loop do done return fn func function def defn fun class struct enum impl trait interface type let var val const static pub public private protected use import from export module mod package namespace as in of is not and or new match case when switch break continue then fi esac end begin local self this super true false null nil none None True False void yield async await try catch except finally throw raise where with").split(" "));
const loaded = new Map();

function extOf(path) {
  const base = path.split("/").pop().toLowerCase();
  if (base === "dockerfile" || base === "makefile" || base === ".gitignore" || base === ".env") return base.replace(/^\./, "");
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1) : "";
}

export function language(path) {
  const ext = extOf(path);
  const g = GRAMMAR[ext];
  if (g) return NAMES[g[0]];
  return "";
}

async function parserFor(path) {
  const g = GRAMMAR[extOf(path)];
  if (!g) return null;
  const key = g.join(" ");
  if (!loaded.has(key)) {
    loaded.set(key, import(`./vendor/lezer/${g[0]}/index.js`).then((m) => {
      if (g[0] === "markdown") return m.parser.configure(m.GFM);
      return g[1] ? m.parser.configure({ dialect: g[1] }) : m.parser;
    }));
  }
  return loaded.get(key);
}

function lineStarts(text) {
  const s = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) s.push(i + 1);
  return s;
}

async function parse(parser, text) {
  const p = parser.startParse(text);
  let t0 = performance.now();
  for (;;) {
    const tree = p.advance();
    if (tree) return tree;
    if (performance.now() - t0 > 10) {
      await new Promise((r) => setTimeout(r));
      t0 = performance.now();
    }
  }
}

// Per line, a flat list of [from, to, class] in columns.
export async function tokens(path, text) {
  if (text.length > MAX_HIGHLIGHT) return null;
  const ext = extOf(path);
  const parser = await parserFor(path).catch(() => null);
  if (!parser) {
    const style = HASH.has(ext) ? "#" : SLASH.has(ext) ? "//" : DASH.has(ext) ? "--" : SEMI.has(ext) ? ";" : null;
    return style ? simple(text, style) : null;
  }
  const tree = await parse(parser, text);
  const starts = lineStarts(text);
  const out = new Array(starts.length);
  let li = 0;
  highlightTree(tree, hl, (from, to, cls) => {
    while (li + 1 < starts.length && starts[li + 1] <= from) li++;
    for (let l = li, f = from; f < to && l < starts.length; l++, f = starts[l]) {
      const end = l + 1 < starts.length ? starts[l + 1] - 1 : text.length;
      const e = Math.min(to, end);
      if (e > f) (out[l] ||= []).push(f - starts[l], e - starts[l], cls);
    }
  });
  return out;
}

// Comments, strings, numbers and common keywords for languages with no lezer grammar here.
function simple(text, comment) {
  const c = comment.replace(/[/]/g, "\\/");
  const re = new RegExp(`(${c}.*)|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')|\\b(\\d[\\w.]*)|\\b([A-Za-z_]\\w*)\\b`, "g");
  return text.split("\n").map((line) => {
    if (line.length > LONG) return null;
    const out = [];
    for (const m of line.matchAll(re)) {
      const cls = m[1] ? "c" : m[2] ? "s" : m[3] ? "n" : KW.has(m[4]) ? "k" : "";
      if (cls) out.push(m.index, m.index + m[0].length, cls);
    }
    return out.length ? out : null;
  });
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const esc = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);

// One line of HTML: syntax spans split at the marks, each mark a <mark> around them.
export function lineHTML(text, toks, marks) {
  if (!toks && !marks) return esc(text);
  const cuts = new Set([0, text.length]);
  if (toks) for (let i = 0; i < toks.length; i += 3) cuts.add(Math.min(toks[i], text.length)).add(Math.min(toks[i + 1], text.length));
  if (marks) for (let i = 0; i < marks.length; i += 2) cuts.add(Math.min(marks[i], text.length)).add(Math.min(marks[i + 1], text.length));
  const pts = [...cuts].sort((a, b) => a - b);
  let h = "";
  let ti = 0;
  let mi = 0;
  let open = false;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    if (marks) {
      while (mi < marks.length && marks[mi + 1] <= a) mi += 2;
      const inside = mi < marks.length && marks[mi] <= a && a < marks[mi + 1];
      if (inside && !open) h += "<mark>";
      if (!inside && open) h += "</mark>";
      open = inside;
    }
    let cls = "";
    if (toks) {
      while (ti < toks.length && toks[ti + 1] <= a) ti += 3;
      if (ti < toks.length && toks[ti] <= a) cls = toks[ti + 2];
    }
    const s = esc(text.slice(a, b));
    h += cls ? `<span class="${cls}">${s}</span>` : s;
  }
  return open ? `${h}</mark>` : h;
}

export class CodeView {
  constructor(root) {
    this.root = root;
    root.innerHTML = '<div class="cv-size"><div class="cv-win"></div></div>';
    this.size = root.firstChild;
    this.win = this.size.firstChild;
    this.doc = null;
    this.span = [0, 0];
    this.raf = 0;
    root.addEventListener("scroll", () => this.schedule(), { passive: true });
    this.h = 0;
    new ResizeObserver(() => {
      // A hidden pane cannot scroll, so centre again once it has a height.
      if (!this.h && root.clientHeight && this.doc) this.center(this.doc.line || 1);
      this.h = root.clientHeight;
      this.schedule();
    }).observe(root);
  }

  // doc: { path, text, line, range: [start, end] or null, marks: Map(line -> [from, to, ...]) }
  show(doc) {
    const lines = doc.text.split("\n");
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    if (doc.text.includes("\r")) for (let i = 0; i < lines.length; i++) if (lines[i].endsWith("\r")) lines[i] = lines[i].slice(0, -1);
    let max = 0;
    for (const l of lines) {
      const n = l.length + (l.includes("\t") ? l.split("\t").length * 3 : 0);
      if (n > max) max = n;
    }
    this.doc = { ...doc, lines, toks: null, max: Math.min(max, LONG + 2) };
    this.root.style.setProperty("--gw", `${String(lines.length).length + 2}ch`);
    this.size.style.height = `${lines.length * LH + 24}px`;
    this.size.style.width = `calc(var(--gw) + ${this.doc.max}ch + 40px)`;
    this.span = [0, 0];
    this.center(doc.line || 1);
    this.paint(true);
    const mine = this.doc;
    tokens(doc.path, doc.text).then((toks) => {
      if (toks && this.doc === mine) {
        mine.toks = toks;
        this.paint(true);
      }
    });
  }

  center(line) {
    const r = this.root;
    r.scrollTop = Math.max(0, (line - 1) * LH - r.clientHeight / 2 + LH / 2 + 12);
    const d = this.doc;
    const m = d && d.marks && d.marks.get(line);
    const cw = this.charWidth();
    // Shift only as far as the mark needs, so the starts of the other lines stay in view.
    const visible = (r.clientWidth - 24) / cw - (String(d ? d.lines.length : 1).length + 2);
    r.scrollLeft = m && m[1] > visible ? Math.min(m[0] - 2, m[1] - visible + 4) * cw : 0;
  }

  charWidth() {
    if (!this.cw) {
      const probe = document.createElement("span");
      probe.className = "cv-probe";
      probe.textContent = "0".repeat(100);
      this.root.append(probe);
      this.cw = probe.getBoundingClientRect().width / 100 || 7.8;
      probe.remove();
    }
    return this.cw;
  }

  clear(html) {
    this.doc = null;
    this.size.style.height = "0px";
    this.win.style.transform = "";
    this.win.innerHTML = "";
    if (html != null) this.win.innerHTML = html;
  }

  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint(false);
    });
  }

  paint(force) {
    const d = this.doc;
    if (!d) return;
    const top = Math.max(0, this.root.scrollTop - 12);
    const first = Math.floor(top / LH);
    const count = Math.ceil(this.root.clientHeight / LH) + 1;
    if (!force && first >= this.span[0] && first + count <= this.span[1]) return;
    const a = Math.max(0, first - 40);
    const b = Math.min(d.lines.length, first + count + 40);
    this.span = [a, b];
    const [rs, re] = d.range || [0, -1];
    let h = "";
    for (let i = a; i < b; i++) {
      const n = i + 1;
      let text = d.lines[i];
      let tail = "";
      if (text.length > LONG) {
        text = text.slice(0, LONG);
        tail = '<span class="c"> ...</span>';
      }
      const marks = d.marks && d.marks.get(n);
      const cls = (n === d.line ? " at" : "") + (marks ? " hit" : "") + (n >= rs && n <= re ? " in" : "");
      h += `<div class="cl${cls}"><span class="cn">${n}</span><span class="cx">${lineHTML(text, d.toks && d.toks[i], marks)}${tail}</span></div>`;
    }
    this.win.style.transform = `translateY(${a * LH + 12}px)`;
    this.win.innerHTML = h;
  }
}
