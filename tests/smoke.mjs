// End-to-end smoke test of the site in headless Chrome: the home page, and the playground's two
// engines and its tour at a desktop and a phone size, with every console error, exception and
// failed request of the page counted as a failure. The workers report through the page.
//
//   node tests/smoke.mjs --dir _site                      a built site, served here
//   node tests/smoke.mjs --url https://scrutate.github.io  the live site
//
// CHROME_BIN names the browser (default google-chrome); SMOKE_NO_SANDBOX=1 adds --no-sandbox.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { launch, page } from "./cdp.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm",
  ".txt": "text/plain", ".xml": "application/xml",
};

function serve(root) {
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      return res.writeHead(400).end();
    }
    let file = path.join(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Content-Length": fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const VIEWS = [
  { name: "desktop", width: 1280, height: 800, mobile: false },
  { name: "phone", width: 390, height: 844, mobile: true },
];
// The index is built in the browser before Engine B answers; a slow runner needs the margin.
const ENGINE_MS = 180000;
const STATS = "document.querySelector('#stats')";

async function checks(b, base, view, ok, fail) {
  const run = async (name, fn) => {
    let again = "";
    for (let tries = 1; ; tries++) {
      const p = await page(b, view);
      const bad = () => p.problems.concat(p.responses.filter((r) => r.status >= 400).map((r) => `HTTP ${r.status} ${r.url}`));
      let busy = null;
      try {
        const note = await fn(p);
        if (bad().length) throw new Error(bad().join("\n  "));
        return ok(`${view.name}: ${name}${note ? ` (${note})` : ""}${again}`);
      } catch (e) {
        busy = p.responses.find((r) => r.status >= 500);
        // A page error is usually why a wait timed out, so it goes in the report too.
        if (!busy || tries > 1) return fail([`${view.name}: ${name}: ${e.message}`, ...bad().filter((x) => !e.message.includes(x))].join("\n  "));
      } finally {
        await p.close().catch(() => {});
      }
      // A 5xx is the host asking to try again, and a static site cannot cause one: GitHub Pages
      // answers 503 now and then just after a deploy. One more try, in a fresh page.
      again = `, after HTTP ${busy.status} on the first try`;
      await new Promise((r) => setTimeout(r, 15000));
    }
  };
  const statsText = (p) => p.eval(`${STATS}.textContent`);
  // Wait for the stats line to report a result, and fail at once with its text if it reports an error.
  const settle = async (p, re) => {
    await p.until(`new RegExp(${JSON.stringify(re.source)}).test(${STATS}.textContent) || ${STATS}.classList.contains('err') || /^Nothing found/.test(${STATS}.textContent)`, ENGINE_MS);
    const text = (await statsText(p)).trim();
    if (!re.test(text)) throw new Error(`the page says: ${text}`);
    return text;
  };
  const noSideScroll = async (p) => {
    const over = await p.eval("document.documentElement.scrollWidth - document.documentElement.clientWidth");
    if (over > 1) throw new Error(`the page scrolls sideways by ${over} px`);
  };

  await run("home page links to the playground", async (p) => {
    await p.go(`${base}/`);
    if (!(await p.eval(`!!document.querySelector('a[href*="playground"]')`))) throw new Error("no link to the playground");
    await noSideScroll(p);
  });

  await run("grep finds every casing of a name", async (p) => {
    await p.go(`${base}/playground/?q=indexDir&m=ident`);
    const found = await settle(p, /\d+ match(es)? in \d+ of/);
    const head = await p.eval(`fetch('scrutate.wasm', { method: 'HEAD' }).then((r) => ({ status: r.status, type: r.headers.get('content-type'),
      encoding: r.headers.get('content-encoding'), length: Number(r.headers.get('content-length')) }))`);
    if (head.status !== 200 || head.type !== "application/wasm") throw new Error(`scrutate.wasm answers ${head.status} ${head.type}; streaming compile needs 200 application/wasm`);
    const meta = await p.eval("fetch('engine.json').then((r) => (r.ok ? r.json() : null))");
    if (!meta || !(meta.bytes > 0) || !/^[0-9a-f]{40}$/.test(meta.scrutate) || !/^[0-9a-f]{40}$/.test(meta.site) || !/^(v\d\S*|main)$/.test(meta.ref || "")) {
      throw new Error(`engine.json is missing or malformed: ${JSON.stringify(meta)}`);
    }
    if (!head.encoding && head.length && head.length !== meta.bytes) throw new Error(`engine.json says ${meta.bytes} bytes, scrutate.wasm is ${head.length}`);
    await noSideScroll(p);
    return found;
  });

  await run("search ranks definitions by meaning", async (p) => {
    await p.go(`${base}/playground/?c=search&q=${encodeURIComponent("walk the directory tree in parallel")}`);
    return settle(p, /\d+ results? in/);
  });

  await run("callers follow the call graph", async (p) => {
    await p.go(`${base}/playground/?c=callers&q=Index.open`);
    const found = await settle(p, /\d+ callers? in/);
    // A card's c, r and s keys work only in the result list; in the search box they type.
    const hint = (focus) => p.eval(`(document.querySelector('${focus}').focus(), getComputedStyle(document.querySelector('#res .acts kbd')).display)`);
    if ((await hint("#q")) !== "none") throw new Error("the key hints show while the search box has focus, where those keys type");
    if ((await hint("#res")) === "none") throw new Error("the key hints are hidden while the result list has focus");
    return found;
  });

  // Each command reads its own JSON fields, so each one is run once.
  await run("symbol, refs, callees and similar answer", async (p) => {
    await p.go(`${base}/playground/?c=symbol&q=Index.open`);
    const notes = [await settle(p, /\d+ definitions? in/)];
    // In the same page, so the index is built once; the query is set before the tab runs it.
    for (const [c, q, re] of [["refs", "query_words", /\d+ uses? of \d+ definitions?/], ["callees", "Index.open", /\d+ in the repository/], ["similar", "FuzzyMatcher.new", /\d+ similar definitions? in/]]) {
      await p.eval(`(() => { const q = document.querySelector('#q'); q.value = ${JSON.stringify(q)}; q.dispatchEvent(new Event('input')); document.querySelector('.tab[data-cmd="${c}"]').click(); })()`);
      notes.push(await settle(p, re));
    }
    return notes.join("; ");
  });

  await run("a search with no matches empties the file view", async (p) => {
    await p.go(`${base}/playground/?q=indexDir&m=ident`);
    await settle(p, /\d+ match(es)? in \d+ of/);
    await p.until("document.querySelector('#fpath').textContent !== 'No file open'", ENGINE_MS);
    await p.eval("(() => { const q = document.querySelector('#q'); q.value = 'zzqx_not_in_this_code'; q.dispatchEvent(new Event('input')); })()");
    const text = await settle(p, /No matches/);
    // the file and the marks of the previous search would read as this search's answer
    const open = await p.eval("document.querySelector('#fpath').textContent");
    if (open !== "No file open") throw new Error(`the file view still shows ${open}`);
    return text;
  });

  // The card and its spotlight have stopped moving: the same place on two looks 200 ms apart.
  const still = (p) => p.until(`(() => {
    const card = document.querySelector('#tour-card');
    const r = document.querySelector('#tour rect');
    const now = ['x', 'y', 'width', 'height'].map((a) => r.getAttribute(a)).join() + card.style.transform + scrollY;
    const same = now === window.__tourLook && !card.classList.contains('move');
    window.__tourLook = now;
    return same;
  })()`, 5000);

  // Every other check opens a link with a search in it, which never starts the tour.
  await run("the tour starts on a first visit, steps, skips and stays away", async (p) => {
    const shown = "!document.querySelector('#tour').hidden";
    const step = () => p.eval("document.querySelector('#tour-n').textContent");
    const press = (key) => p.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`);
    const click = (sel) => p.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    // Waits for the step's own answer, then checks the card leaves the control it points at in view.
    const answered = async () => {
      await p.until("!/^(Running|Waiting|Loading)/.test(document.querySelector('#tour-got').textContent)", ENGINE_MS);
      await still(p);
      const covered = await p.eval(`(() => {
        const c = document.querySelector('#tour-card').getBoundingClientRect();
        const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((a) => +document.querySelector('#tour rect').getAttribute(a));
        return c.left < x + w && x < c.right && c.top < y + h && y < c.bottom;
      })()`);
      if (covered) throw new Error(`on step ${await step()} the card covers the control it points at`);
    };
    await p.go(`${base}/playground/`);
    await p.until(shown, ENGINE_MS);
    await p.until("document.querySelector('#tour-got mark')", ENGINE_MS);
    await answered();
    if (!(await p.eval("document.activeElement.dataset.tour === 'next'"))) throw new Error("focus did not move to the card's Next button");
    await noSideScroll(p);
    const total = Number((await step()).split(" of ")[1]);
    // A made-up Enter does not press a button, so the arrow key stands in for it here.
    await press("ArrowRight");
    await p.until("document.querySelector('#tour-n').textContent.startsWith('2 of')", 5000);
    await answered();
    await click("[data-tour='back']");
    await p.until("document.querySelector('#tour-n').textContent.startsWith('1 of')", 5000);
    await press("Escape");
    await p.until("document.querySelector('#tour').hidden", 5000);
    if ((await p.eval("localStorage.getItem('scrutate-tour')")) !== "skipped") throw new Error("Esc did not remember the skip");

    await p.go(`${base}/playground/`);
    await settle(p, /\d+ match(es)? in \d+ of/);
    await new Promise((r) => setTimeout(r, 1500));
    if (await p.eval(shown)) throw new Error("the tour started again after it was skipped");

    await click("#tour-btn");
    await p.until(shown, 5000);
    await click("#tour path");
    await p.until("document.querySelector('#tour').hidden", 5000);
    await click("#tour-btn");
    await p.until(shown, 5000);
    for (let k = 1; k <= total; k++) {
      await p.until(`document.querySelector('#tour-n').textContent.startsWith('${k} of')`, 5000);
      await answered();
      await click("[data-tour='next']");
    }
    await p.until("document.querySelector('#tour').hidden", 5000);
    if ((await p.eval("localStorage.getItem('scrutate-tour')")) !== "done") throw new Error("finishing the tour was not remembered");
    if ((await p.eval("document.activeElement.id")) !== "q") throw new Error("finishing the tour did not put focus in the search box");
    return `${total} steps`;
  });

  await run("a tour from the button gives back the search it replaced", async (p) => {
    const search = "?c=callers&q=Index.open";
    await p.go(`${base}/playground/${search}`);
    await settle(p, /\d+ callers? in/);
    const click = (sel) => p.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await click("#tour-btn");
    await p.until("document.querySelector('#tour-got mark')", ENGINE_MS);
    await p.eval("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await p.until("document.querySelector('#tour').hidden", 5000);
    const back = await p.eval("[location.search, document.querySelector('#q').value]");
    if (back[0] !== search || back[1] !== "Index.open") throw new Error(`Skip left ${back[0]} with ${back[1]} in the search box, not the search the tour replaced`);
    await settle(p, /\d+ callers? in/);
    // A click into the page ends the tour and keeps the focus where the click put it.
    await click("#tour-btn");
    await p.until("document.querySelector('#tour-got mark')", ENGINE_MS);
    await p.eval("(() => { const q = document.querySelector('#q'); q.focus(); q.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()");
    await p.until("document.querySelector('#tour').hidden", 5000);
    const focus = await p.eval("document.activeElement.id");
    if (focus !== "q") throw new Error(`a click in the search box ended the tour but focus went to ${focus || "the page"}`);
  });

  await run("a repo link that names no repository says so", async (p) => {
    await p.go(`${base}/playground/?repo=${encodeURIComponent("not a repo")}&q=indexDir&m=ident`);
    await settle(p, /\d+ match(es)? in \d+ of/);
    const note = await p.eval("document.querySelector('#src-note').textContent");
    if (!/not a GitHub repository/.test(note)) throw new Error(`the page shows the sample with no word about the link: "${note}"`);
    return note;
  });

  await run("a bad regex shows the engine's message", async (p) => {
    await p.go(`${base}/playground/?q=${encodeURIComponent("(")}&m=regex`);
    await p.until(`${STATS}.classList.contains('err')`, ENGINE_MS);
    const text = (await statsText(p)).trim();
    // "The engine did not load" is an error too; only the engine's own parse error passes.
    if (!/unclosed|regex|pattern/i.test(text)) throw new Error(`the page says: ${text}`);
    return text.slice(0, 60);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const at = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  let base = at("--url");
  let server = null;
  if (at("--dir")) ({ server, base } = await serve(path.resolve(at("--dir"))));
  if (!base) throw new Error("give --dir DIR or --url URL");
  base = base.replace(/\/$/, "");
  const b = await launch(process.env.CHROME_BIN || "google-chrome", { noSandbox: process.env.SMOKE_NO_SANDBOX === "1" });
  const passed = [];
  const failed = [];
  try {
    for (const view of VIEWS) await checks(b, base, view, (m) => passed.push(m), (m) => failed.push(m));
  } catch (e) {
    failed.push(`the run stopped: ${e.message}`);
  } finally {
    await b.quit();
    if (server) server.close();
  }
  for (const m of passed) console.log(`PASS ${m}`);
  for (const m of failed) console.log(`FAIL ${m}`);
  console.log(`${passed.length} passed, ${failed.length} failed, against ${base}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
