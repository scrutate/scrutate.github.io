// A small Chrome DevTools Protocol client over Node's built-in WebSocket: no npm dependency.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function launch(bin, { noSandbox = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-chrome-"));
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu"];
  if (noSandbox) args.push("--no-sandbox");
  const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise((ok, bad) => {
    let err = "";
    const t = setTimeout(() => bad(new Error(`Chrome did not start: ${err.slice(-400)}`)), 30000);
    proc.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(t);
        ok(m[1]);
      }
    });
    proc.on("exit", (code) => bad(new Error(`Chrome exited (${code}): ${err.slice(-400)}`)));
  });
  const b = await connect(url);
  // Chrome keeps writing its profile until it has exited, so remove the folder only after that.
  b.quit = async () => {
    b.close();
    const gone = proc.exitCode !== null ? null : new Promise((ok) => proc.once("exit", ok));
    proc.kill();
    if (gone) await Promise.race([gone, new Promise((ok) => setTimeout(ok, 10000))]);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return b;
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error(`${wsUrl} did not open in 30 s`)), 30000);
    ws.onopen = () => {
      clearTimeout(t);
      ok();
    };
    ws.onerror = () => {
      clearTimeout(t);
      bad(new Error(`cannot open ${wsUrl}`));
    };
  });
  let seq = 0;
  const wait = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) {
      const p = wait.get(m.id);
      wait.delete(m.id);
      m.error ? p.bad(new Error(`${p.method}: ${m.error.message}`)) : p.ok(m.result);
    } else if (m.method) for (const l of listeners) l(m);
  };
  // A browser that crashes fails every pending call at once instead of hanging the run.
  ws.onclose = () => {
    for (const p of wait.values()) p.bad(new Error(`${p.method}: the browser closed the connection`));
    wait.clear();
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, bad) => {
      if (ws.readyState !== WebSocket.OPEN) return bad(new Error(`${method}: the browser connection is closed`));
      const id = ++seq;
      wait.set(id, { ok, bad, method });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { send, on: (f) => listeners.push(f), close: () => ws.close(), closed: () => ws.readyState !== WebSocket.OPEN };
}

// A fresh browser context per page, so no cache or storage carries over between checks.
export async function page(b, { width, height, mobile }) {
  const { browserContextId } = await b.send("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await b.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  const problems = [];
  const responses = [];
  b.on((m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params;
    if (m.method === "Runtime.exceptionThrown") problems.push(`exception: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`);
    if (m.method === "Runtime.consoleAPICalled" && p.type === "error") problems.push(`console error: ${p.args.map((a) => a.value ?? a.description).join(" ")}`);
    if (m.method === "Log.entryAdded" && p.entry.level === "error") problems.push(`log error: ${p.entry.text} ${p.entry.url || ""}`.trim());
    if (m.method === "Network.responseReceived") responses.push({ url: p.response.url, status: p.response.status });
    if (m.method === "Network.loadingFailed" && !p.canceled) problems.push(`network failed: ${p.errorText} (${p.type})`);
  });
  for (const d of ["Page", "Runtime", "Log", "Network"]) await s(`${d}.enable`);
  await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
  await s("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  const p = {
    problems,
    responses,
    async go(url) {
      await s("Page.navigate", { url });
      await p.until("document.readyState === 'complete'", 30000);
    },
    async eval(expr) {
      const r = await s("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    },
    async until(expr, ms) {
      const t0 = Date.now();
      for (;;) {
        const yes = await p.eval(`!!(${expr})`).catch((e) => {
          if (b.closed()) throw e;
          return false;
        });
        if (yes) return Date.now() - t0;
        if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for: ${expr}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    },
    close: () => b.send("Target.disposeBrowserContext", { browserContextId }),
  };
  return p;
}
