// A short guided tour: each step runs a real example in the page, then lights up the control and
// explains the answer the page shows. It starts once, on a first visit to the bare playground link.
import { esc } from "./code.js";

const $ = (s) => document.querySelector(s);
const KEY = "scrutate-tour";
const PAD = 6;
const MOVE_MS = 260;
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const keyboard = matchMedia("(pointer: fine)");
// Read before the page writes the search into its address.
const bare = !location.search;

const num = (n) => Number(n).toLocaleString("en-US");
const and = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const count = () => Number(($("#stats b")?.textContent || "").replace(/\D/g, ""));
const said = () => esc($("#stats").textContent);

function spellings(ex) {
  const found = [...new Set([...document.querySelectorAll("#res .mr mark")].map((m) => m.textContent))].slice(0, 4);
  if (!found.length) return said();
  const n = count();
  return `<code>${esc(ex.q)}</code> matched ${and(found.map((s) => `<mark>${esc(s)}</mark>`))}, ${n === 1 ? "once" : `${num(n)} times`}.`;
}

function top() {
  const nm = $("#res .card .nm");
  return nm ? `Top result: <mark>${esc(nm.textContent)}</mark>` : said();
}

function callers(ex) {
  const names = [...document.querySelectorAll("#res .card .nm")].slice(0, 2).map((e) => `<b>${esc(e.textContent)}</b>`);
  if (!names.length) return said();
  const more = count() - names.length;
  return `<code>${esc(ex.q)}</code> is called from ${and(more > 0 ? [...names, `${num(more)} more`] : names)}.`;
}

// c and pick choose the example a step runs; a step whose example this code lacks is left out.
// at is the control the card points to; show is where the answer appears.
const STEPS = [
  {
    c: "grep",
    pick: (e) => e.m === "ident",
    at: '.seg [data-mode="ident"]',
    show: [".qbox", "#pane-res"],
    title: "Every casing, one search",
    text: () => "<code>--ident</code> matches a name however it is written: snake_case, camelCase or SCREAMING_CASE. Plain grep needs a regex for each.",
    got: spellings,
  },
  {
    c: "grep",
    pick: (e) => e.m === "fuzzy",
    at: '.seg [data-mode="fuzzy"]',
    show: [".qbox", "#pane-res"],
    title: "Typos still find it",
    text: (ex) => `<code>--fuzzy=${ex.f}</code> also matches words up to ${ex.f === 1 ? "one edit" : `${ex.f} edits`} away, so a misspelled name still finds the code.`,
    got: spellings,
  },
  {
    c: "search",
    pick: () => true,
    at: '.tab[data-cmd="search"]',
    show: [".qbox", "#pane-res"],
    title: "Search by meaning",
    text: () => "Engine B indexes the code right here in the tab. Ask in plain words, and it ranks the definitions that do what you asked.",
    got: top,
  },
  {
    c: "callers",
    pick: () => true,
    at: '.tab[data-cmd="callers"]',
    show: [".qbox", "#pane-res"],
    title: "Follow the calls",
    text: () => "The index knows the call graph: callers, callees and every reference to a name. Open a result to read its file with the call marked.",
    got: callers,
  },
  {
    at: "#src",
    show: [],
    title: "Your own code",
    text: () => "Change loads a public GitHub repository or a folder of yours. A folder is read in this tab and never leaves your computer.",
    got: () => `Now searching ${esc($("#src-name").textContent)} ${esc($("#src-meta").textContent)}.`,
  },
  {
    at: "#share",
    show: [],
    title: "Share a search",
    text: () => `Copy link puts this search, its options and the code in one link.${keyboard.matches ? " Press <kbd>/</kbd> to search, the arrows to move and <kbd>Enter</kbd> to open a result." : ""}`,
    got: () => `<span class="tour-url">${esc(location.host + location.pathname + location.search)}</span>`,
  },
];

// Without storage the tour could not remember a skip, so it only starts from the button.
function seen() {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return true;
  }
}

function remember(how) {
  try {
    localStorage.setItem(KEY, how);
  } catch {}
}

function box(el) {
  const b = el && el.getBoundingClientRect();
  return b && b.width && b.height ? { x: b.left, y: b.top, w: b.width, h: b.height } : null;
}

const grow = (r, d = PAD) => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
const meets = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// Overlapping holes become one, since the even-odd fill would paint their overlap dark again.
function merge(rs) {
  const out = [];
  for (let r of rs) {
    for (let k = out.findIndex((o) => meets(o, r)); k >= 0; k = out.findIndex((o) => meets(o, r))) {
      const o = out.splice(k, 1)[0];
      const x = Math.min(o.x, r.x);
      const y = Math.min(o.y, r.y);
      r = { x, y, w: Math.max(o.x + o.w, r.x + r.w) - x, h: Math.max(o.y + o.h, r.y + r.h) - y };
    }
    out.push(r);
  }
  return out;
}

function rounded({ x, y, w, h }) {
  const r = Math.min(10, w / 2, h / 2);
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

const dot = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2, w: 0, h: 0 });
const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });

function mix(a, b, k) {
  const holes = [];
  for (let i = 0; i < Math.max(a.holes.length, b.holes.length); i++) {
    const x = a.holes[i] || dot(b.holes[i]);
    holes.push(lerp(x, b.holes[i] || dot(x), k));
  }
  return { holes, ring: a.ring && b.ring ? lerp(a.ring, b.ring, k) : b.ring };
}

export function initTour(app) {
  const root = $("#tour");
  const card = $("#tour-card");
  const path = root.querySelector("path");
  const ring = root.querySelector("rect");
  const got = $("#tour-got");
  const backBtn = card.querySelector('[data-tour="back"]');
  const nextBtn = card.querySelector('[data-tour="next"]');
  let steps = [];
  let at = 0;
  let open = false;
  let waiting = false;
  let seq = 0;
  let raf = 0;
  let drawn = null;
  let from = null;
  let t0 = 0;
  let spot = null;
  let gotHTML = "";
  let painted = "";
  let returnTo = null;
  let moving = 0;

  const setGot = (html) => {
    if (html !== gotHTML) got.innerHTML = gotHTML = html;
  };
  // While a step waits for its answer, the card says what the page says: the index building, or the engine loading.
  const watch = new MutationObserver(() => waiting && setGot(said()));

  function place(p, holes) {
    const vw = document.documentElement.clientWidth;
    const vh = innerHeight;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const m = 12;
    const gap = 14;
    // A card as wide as a phone docks at the bottom, in thumb reach, or at the top when the control is down there.
    if (vw - w < 2 * m + 24) {
      const low = { x: (vw - w) / 2, y: vh - h - m, w, h };
      return !p || !area(low, grow(p, gap - PAD)) ? low : { x: low.x, y: m };
    }
    const near = p || { x: vw / 2, y: vh / 2, w: 0, h: 0 };
    const view = { x: 0, y: 0, w: vw, h: vh };
    const spots = [];
    for (const r of [near, ...holes]) {
      for (const x of [r.x, r.x + r.w / 2 - w / 2, r.x + r.w - w]) spots.push([x, r.y + r.h + gap], [x, r.y - gap - h]);
      for (const y of [r.y, r.y + r.h / 2 - h / 2, r.y + r.h - h]) spots.push([r.x + r.w + gap, y], [r.x - gap - w, y]);
    }
    let best = null;
    for (let [x, y] of spots) {
      x = Math.max(m, Math.min(x, vw - w - m));
      y = Math.max(m, Math.min(y, vh - h - m));
      const c = { x, y, w, h };
      // Never over the control; then the smallest share of each lit area; then near the control.
      let score = (p ? area(c, grow(p, gap - PAD)) : 0) * 1e6 + Math.hypot(x + w / 2 - (near.x + near.w / 2), y + h / 2 - (near.y + near.h / 2));
      for (const r of holes) score += (3000 * area(c, r)) / Math.max(1, area(r, view));
      if (!best || score < best.score) best = { x, y, score };
    }
    return best;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const s = steps[at];
    const p = box($(s.at));
    const goal = { holes: merge([p, ...s.show.map((q) => box($(q)))].filter(Boolean).map((r) => grow(r))), ring: p && grow(p) };
    const k = from ? Math.min(1, (now - t0) / MOVE_MS) : 1;
    const cur = k < 1 ? mix(from, goal, 1 - (1 - k) ** 3) : goal;
    if (k >= 1) from = null;
    drawn = cur;
    const d = `M0 0H${document.documentElement.clientWidth}V${innerHeight}H0Z${cur.holes.filter((r) => r.w >= 1 && r.h >= 1).map(rounded).join("")}`;
    const rr = cur.ring ? [cur.ring.x, cur.ring.y, cur.ring.w, cur.ring.h].map((v) => v.toFixed(1)) : null;
    // Most frames change nothing; writing the same shape again would still repaint it.
    if (d + rr !== painted) {
      painted = d + rr;
      path.setAttribute("d", d);
      ring.style.display = rr ? "" : "none";
      if (rr) ["x", "y", "width", "height"].forEach((a, j) => ring.setAttribute(a, rr[j]));
    }
    const to = place(p, goal.holes);
    if (!spot || Math.abs(to.x - spot.x) > 0.5 || Math.abs(to.y - spot.y) > 0.5) {
      spot = to;
      card.style.transform = `translate(${Math.round(to.x)}px, ${Math.round(to.y)}px)`;
    }
  }

  async function go(i, first) {
    const mine = ++seq;
    at = i;
    const s = steps[i];
    const n = steps.length;
    $("#tour-n").textContent = `${i + 1} of ${n}`;
    $("#tour-dots").innerHTML = steps.map((_, k) => `<i class="${k < i ? "done" : k === i ? "on" : ""}"></i>`).join("");
    $("#tour-t").textContent = s.title;
    $("#tour-p").innerHTML = s.text(s.ex);
    backBtn.hidden = i === 0;
    nextBtn.textContent = i === n - 1 ? "Start searching" : "Next";
    if (!card.contains(document.activeElement) || document.activeElement.hidden) nextBtn.focus({ preventScroll: true });
    // The first step is read out as the dialog takes focus.
    $("#tour-live").textContent = first ? "" : `Step ${i + 1} of ${n}: ${s.title}. ${$("#tour-p").textContent}`;
    card.classList.remove("in");
    void card.offsetWidth;
    card.classList.add("in");
    if (drawn && !reduce.matches) {
      from = drawn;
      t0 = performance.now();
      card.classList.add("move");
      clearTimeout(moving);
      moving = setTimeout(() => card.classList.remove("move"), MOVE_MS);
    }
    // On a phone the page scrolls: bring the lit area to the top, so the answer shows above the card.
    const lit = [s.at, ...s.show].map((q) => box($(q))).filter(Boolean);
    if (lit.length) scrollTo({ top: Math.max(0, Math.min(...lit.map((r) => r.y)) + scrollY - 12), behavior: reduce.matches ? "auto" : "smooth" });
    waiting = !!s.c;
    if (s.c) {
      setGot('<span class="dim">Running</span>');
      const done = new Promise((ok) => document.addEventListener("scrutate:shown", ok, { once: true }));
      app.run(s.c, s.ex);
      await done;
      if (mine !== seq) return;
      waiting = false;
    }
    setGot(s.got(s.ex));
  }

  function onKey(e) {
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Escape") {
      stop();
      return end("skipped");
    }
    if (e.key === "Tab") {
      stop();
      const f = [...card.querySelectorAll("button:not([hidden])")];
      const i = f.indexOf(document.activeElement);
      f[i < 0 ? (e.shiftKey ? f.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      return;
    }
    if (!card.contains(e.target)) return;
    if (e.key === "ArrowRight" || (e.key === "Enter" && e.target === card)) {
      stop();
      next();
    } else if (e.key === "ArrowLeft") {
      stop();
      if (at > 0) go(at - 1);
    } else if (e.key === "/") e.stopPropagation();
  }

  // A click on the dim area only closes the tour; one in a lit area also reaches the page. A click,
  // not a press, so a finger can still scroll the page.
  function onClick(e) {
    if (!card.contains(e.target)) end("skipped");
  }

  function next() {
    if (at < steps.length - 1) go(at + 1);
    else end("done");
  }

  function start() {
    if (open) return;
    steps = STEPS.map((s) => ({ ...s, ex: s.c ? app.examples(s.c).find(s.pick) : null })).filter((s) => !s.c || s.ex);
    open = true;
    drawn = from = spot = null;
    returnTo = document.activeElement;
    root.hidden = false;
    card.classList.remove("move");
    addEventListener("keydown", onKey, true);
    addEventListener("click", onClick, true);
    watch.observe($("#stats"), { childList: true, characterData: true, subtree: true });
    go(0, true);
    raf = requestAnimationFrame((now) => {
      frame(now);
      root.classList.add("on");
    });
  }

  function end(how) {
    if (!open) return;
    open = false;
    waiting = false;
    seq++;
    cancelAnimationFrame(raf);
    removeEventListener("keydown", onKey, true);
    removeEventListener("click", onClick, true);
    watch.disconnect();
    remember(how);
    root.classList.remove("on");
    setTimeout(() => {
      if (!open) root.hidden = true;
    }, reduce.matches ? 0 : 200);
    if (how === "done") {
      $("#q").focus();
      $("#q").select();
    } else if (returnTo && returnTo !== document.body && returnTo.isConnected) returnTo.focus({ preventScroll: true });
  }

  card.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tour]");
    if (!b) return;
    if (b.dataset.tour === "skip") end("skipped");
    else if (b.dataset.tour === "back") go(Math.max(0, at - 1));
    else next();
  });
  $("#tour-btn").addEventListener("click", start);

  if (bare && !seen()) {
    // Someone who already typed or clicked is not interrupted; the tour waits for a later visit.
    let touched = false;
    const touch = (e) => {
      if (e.isTrusted) touched = true;
    };
    addEventListener("input", touch, true);
    addEventListener("click", touch, true);
    document.addEventListener("scrutate:shown", () => setTimeout(() => {
      removeEventListener("input", touch, true);
      removeEventListener("click", touch, true);
      if (!touched && !$("#dlg").open) start();
    }, 400), { once: true });
  }
}
