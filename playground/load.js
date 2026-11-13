// Gets code into the page: the bundled sample, a public GitHub repository, or a local folder.
// Every loader returns { files: [[path, bytes or text]], bytes, left } (a folder adds its name,
// the sample its name and commit), or null when the person picked nothing, and reads nothing it
// skips.
export const CAP = { files: 4000, bytes: 60e6, file: 1e6 };
// The folder the engine sees the files in.
export const ROOT = "/w";
const LIST_CAP = 50000;
const SKIP_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "bower_components", ".scrutate", "target", "dist", "build", ".next", ".nuxt", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".gradle", ".idea", ".vscode", "Pods", "DerivedData", ".terraform", "coverage", ".cache"]);
const BINARY = /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|ico|icns|psd|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|jar|war|ear|class|so|dylib|dll|exe|o|a|lib|obj|wasm|woff2?|ttf|otf|eot|mp[34]|m4a|mov|avi|mkv|webm|ogg|wav|flac|sqlite3?|db|bin|dat|pyc|pyo|npy|npz|pkl|onnx|pt|safetensors|lockb|DS_Store)$/i;
const LANES = 16;

const seg = (p) => p.split("/").map(encodeURIComponent).join("/");
const skipPath = (parts) => parts.slice(0, -1).some((p) => SKIP_DIRS.has(p));
const isText = (b) => !new Uint8Array(b, 0, Math.min(b.byteLength, 8000)).includes(0);

class Budget {
  constructor() {
    this.n = 0;
    this.bytes = 0;
    this.left = { big: 0, binary: 0, cap: 0 };
  }
  take(path, size) {
    if (BINARY.test(path)) return this.left.binary++, false;
    if (size > CAP.file) return this.left.big++, false;
    if (this.n >= CAP.files || this.bytes + size > CAP.bytes) return this.left.cap++, false;
    this.n++;
    this.bytes += size;
    return true;
  }
}

function loaded(files, left) {
  files.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { files, bytes: files.reduce((n, [, b]) => n + b.byteLength, 0), left };
}

async function lanes(items, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(LANES, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

export async function sample(url, progress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the sample did not load (HTTP ${res.status})`);
  progress?.("Reading the sample");
  const s = await res.json();
  const enc = new TextEncoder();
  const bytes = s.files.reduce((n, [, t]) => n + enc.encode(t).byteLength, 0);
  return { name: s.name, commit: s.commit, files: s.files, bytes, left: null };
}

// A folder path as a person writes it, without empty segments: "/a//b/" is "a/b".
export function cleanPath(p) {
  return p.split("/").filter(Boolean).join("/");
}

// owner/name, a github.com URL (with /tree/REF/PATH), or git@github.com:owner/name.git.
export function parseRepo(text) {
  const tidy = (t) => t.replace(/\.git$/, "").replace(/\/+$/, "");
  const s = text.trim();
  // Only a URL has a query or a fragment to drop; in owner/name@ref a # can be part of the ref.
  let m = tidy(s.replace(/[?#].*$/, "")).match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.+))?)?$/i);
  if (m) {
    const sub = decode(m[5] || "");
    m = [m[0], m[1], m[2], decode(m[4] || ""), m[3]?.toLowerCase() === "blob" ? sub.replace(/\/?[^/]*$/, "") : sub];
  }
  if (!m) m = tidy(s).match(/^git@github\.com:([\w.-]+)\/([\w.-]+)$/i);
  if (!m) m = tidy(s).match(/^([\w.-]+)\/([\w.-]+)(?:@([^/\s]+))?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3] === "HEAD" ? "" : m[3] || "", sub: cleanPath(m[4] || "") };
}

// A link's path segments are percent-encoded; one that is not valid encoding is kept as written.
function decode(t) {
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

export async function github({ owner, repo, ref, sub }, progress, signal) {
  // fetch would resolve these, and the page would read another repository under this name
  if (sub && sub.split("/").some((p) => !p || p === "." || p === "..")) throw new Error(`${sub} is not a folder path.`);
  const at = ref || "HEAD";
  // REF:PATH lists one folder, so a folder of a repository too big to list whole still loads.
  const api = `https://api.github.com/repos/${owner}/${repo}/git/trees/${seg(at)}${sub ? `:${seg(sub)}` : ""}?recursive=1`;
  let res;
  try {
    res = await fetch(api, { headers: { Accept: "application/vnd.github+json" }, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error("GitHub did not answer. Check the connection and try again.");
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = new Date(Number(res.headers.get("x-ratelimit-reset")) * 1000);
    throw new Error(`GitHub allows 60 requests an hour without signing in, and this network has used them. Try again after ${reset.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`);
  }
  if (res.status === 404 || res.status === 422) {
    const at = ref ? ` with a branch, tag or commit named ${ref}` : "";
    throw new Error(sub ? `GitHub has no folder ${sub} in a public repository ${owner}/${repo}${at}.` : `GitHub has no public repository named ${owner}/${repo}${at}.`);
  }
  if (res.status === 409) throw new Error(`${owner}/${repo} is empty.`);
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${owner}/${repo}.`);
  const t = await res.json();
  const prefix = sub ? `${sub}/` : "";
  const budget = new Budget();
  const want = [];
  for (const e of t.tree) {
    if (e.type !== "blob" || skipPath(e.path.split("/"))) continue;
    if (budget.take(e.path, e.size)) want.push([prefix + e.path, e.path]);
  }
  if (!want.length && t.truncated) throw new Error(`GitHub listed only part of ${owner}/${repo}${sub ? `/${sub}` : ""}. Try a folder further down.`);
  if (!want.length) throw new Error(sub ? `${owner}/${repo} has no text files under ${sub}.` : `${owner}/${repo} has no text files the playground can read.`);
  const files = [];
  let done = 0;
  let failed = 0;
  const raw = (p) => `https://raw.githubusercontent.com/${owner}/${repo}/${seg(at)}/${seg(p)}`;
  progress?.(`Fetching 0 of ${want.length.toLocaleString()} files from GitHub`, 0);
  await lanes(want, async ([path, rel]) => {
    let body = null;
    for (let tries = 0; tries < 2 && !body; tries++) {
      try {
        const r = await fetch(raw(path), { signal });
        if (r.ok) body = await r.arrayBuffer();
      } catch (e) {
        if (signal?.aborted) throw e;
      }
    }
    if (!body) failed++;
    else if (isText(body)) files.push([rel, body]);
    else budget.left.binary++;
    done++;
    progress?.(`Fetching ${done.toLocaleString()} of ${want.length.toLocaleString()} files from GitHub`, done / want.length);
  });
  if (signal?.aborted) throw new DOMException("stopped", "AbortError");
  return loaded(files, { ...budget.left, failed, truncated: !!t.truncated });
}

async function readAll(list, progress) {
  const budget = new Budget();
  const keep = list.filter(([path, size]) => budget.take(path, size));
  const files = [];
  let done = 0;
  await lanes(keep, async ([path, , get]) => {
    const body = await (await get()).arrayBuffer();
    if (isText(body)) files.push([path, body]);
    else budget.left.binary++;
    if (++done % 50 === 0 || done === keep.length) progress?.(`Reading ${done.toLocaleString()} of ${keep.length.toLocaleString()} files`, done / keep.length);
  });
  return loaded(files, budget.left);
}

// The folder picker in Chromium, else <input webkitdirectory>.
export async function pickFolder(progress) {
  if (window.showDirectoryPicker) {
    const dir = await window.showDirectoryPicker({ id: "scrutate-playground", mode: "read" });
    const list = [];
    async function walk(handle, prefix) {
      for await (const [name, h] of handle.entries()) {
        if (h.kind === "directory") {
          if (!SKIP_DIRS.has(name)) await walk(h, `${prefix}${name}/`);
        } else {
          const file = await h.getFile();
          list.push([`${prefix}${name}`, file.size, async () => file]);
        }
        if (list.length > LIST_CAP) return;
      }
    }
    progress?.(`Listing ${dir.name}`);
    await walk(dir, "");
    return { name: dir.name, ...(await readAll(list, progress)) };
  }
  return null;
}

export async function fromInput(fileList, progress) {
  const all = [...fileList];
  if (!all.length) return null;
  const name = all[0].webkitRelativePath.split("/")[0] || "your folder";
  // The other readers skip these folders as they walk; this list arrives whole.
  const list = all.map((f) => [f.webkitRelativePath.split("/").slice(1).join("/") || f.name, f.size, async () => f]).filter(([p]) => !skipPath(p.split("/")));
  return { name, ...(await readAll(list, progress)) };
}

// A drop from the desktop: folders are read with webkitGetAsEntry, which every browser has.
export async function fromDrop(dt, progress) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return null;
  const list = [];
  const one = entries.length === 1 && entries[0].isDirectory;
  const fileOf = (e) => new Promise((ok, bad) => e.file(ok, bad));
  async function walk(e, prefix) {
    if (e.isFile) {
      const f = await fileOf(e);
      list.push([`${prefix}${e.name}`, f.size, async () => f]);
    } else if (e.isDirectory && !(prefix && SKIP_DIRS.has(e.name))) {
      const reader = e.createReader();
      const kids = [];
      for (;;) {
        const batch = await new Promise((ok, bad) => reader.readEntries(ok, bad));
        if (!batch.length) break;
        kids.push(...batch);
      }
      for (const k of kids) {
        if (list.length > LIST_CAP) return;
        await walk(k, `${prefix}${e.name}/`);
      }
    }
  }
  progress?.("Listing the dropped files");
  for (const e of entries) await walk(e, "");
  const strip = one ? `${entries[0].name}/` : "";
  const named = list.map(([p, s, g]) => [p.startsWith(strip) ? p.slice(strip.length) : p, s, g]);
  return { name: one ? entries[0].name : `${entries.length} dropped items`, ...(await readAll(named, progress)) };
}
