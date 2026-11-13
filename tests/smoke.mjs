// End-to-end smoke test of the site in headless Chrome: the home page, and the playground's two
// engines at a desktop and a phone size, with every console error, exception and failed request
// of the page counted as a failure. The workers report through the page.
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
    const p = await page(b, view);
    const bad = () => p.problems.concat(p.responses.filter((r) => r.status >= 400).map((r) => `HTTP ${r.status} ${r.url}`));
    try {
      const note = await fn(p);
      if (bad().length) throw new Error(bad().join("\n  "));
      ok(`${view.name}: ${name}${note ? ` (${note})` : ""}`);
    } catch (e) {
      // A page error is usually why a wait timed out, so it goes in the report too.
      fail([`${view.name}: ${name}: ${e.message}`, ...bad().filter((x) => !e.message.includes(x))].join("\n  "));
    } finally {
      await p.close().catch(() => {});
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
    return settle(p, /\d+ callers? in/);
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
