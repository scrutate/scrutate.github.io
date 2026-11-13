# scrutate.github.io

The website of [Scrutate](https://github.com/scrutate/scrutate), https://scrutate.github.io: a
home page and a playground that runs scrutate in the browser. Plain HTML, CSS and JavaScript
modules, no JavaScript build step and no npm dependencies.

## How it is published

`.github/workflows/pages.yml` publishes the site to GitHub Pages (the repository's Pages source is
"GitHub Actions"). On every push to `main`, on every hour, and when started by hand, it:

1. picks the scrutate to run (`tools/resolve_engine.sh`): the newest scrutate release, or, before
   the first release, the newest `main` commit whose `ci.yml` run passed;
2. builds that scrutate for `wasm32-wasip1` (about 85 MB) with a pinned, checksummed wasi-sdk;
3. assembles the site with the engine and `playground/engine.json` (`tools/build_site.sh`);
4. tests the assembled site in Chrome at a desktop and a phone size (`tests/smoke.mjs`), and
   publishes it only if every check passes;
5. tests the live site in Chrome after the deploy.

The hourly run builds and publishes only when the scrutate it picks, or this repository's `main`,
differs from what the site serves (`engine.json` names both), so a new scrutate release reaches
the playground within about an hour. The rest of the time it only checks that the live pages and
the engine answer, without Chrome, since each Chrome check downloads the 85 MB engine again. A pull
request runs steps 1 to 4 and publishes nothing.

The engine is never committed: an 85 MB binary would grow the history with every scrutate
version, and building it here ties each deploy to one scrutate commit, which `engine.json` names.

### By hand

- **Run a particular scrutate**, for a rollback or a test: Actions, "pages", "Run workflow" on
  `main`, and give a release tag such as `v0.1.0`, or `main`. The next hourly run returns to the newest
  release, so a rollback that must last is a new scrutate release.
- **The hourly run stopped**: GitHub turns off scheduled workflows in a public repository with no
  activity for 60 days and emails the owner. Turn it back on under Actions, "pages",
  "Enable workflow". Pushes to `main` publish either way.
- **A scrutate release fails the site's tests**: nothing is published, and every hourly run builds
  it again and fails the same way until a newer release, a run by hand that picks another
  scrutate, or a fix pushed here.
- **Action versions**: every `uses:` is pinned to a commit with its tag in a comment; update the
  hash and the tag together.

## Working on it locally

You need a scrutate build for `wasm32-wasip1`. In a scrutate checkout, with
[wasi-sdk](https://github.com/WebAssembly/wasi-sdk) unpacked at `$SDK` (the version
`pages.yml` names):

```sh
rustup target add wasm32-wasip1
CC_wasm32_wasip1=$SDK/bin/clang AR_wasm32_wasip1=$SDK/bin/llvm-ar \
CFLAGS_wasm32_wasip1="--sysroot=$SDK/share/wasi-sysroot" \
cargo build --release -p scrutate --bin scrutate --target wasm32-wasip1 --no-default-features --locked
```

Then, in this repository, assemble the site and test it (Node 22.4 or later, and Chrome):

```sh
sh tools/build_site.sh /tmp/site ../scrutate/target/wasm32-wasip1/release/scrutate.wasm \
  "$(git -C ../scrutate rev-parse HEAD)" main
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  node tests/smoke.mjs --dir /tmp/site
```

`node tests/smoke.mjs --url https://scrutate.github.io` tests the live site the same way. To look
at the site, serve the assembled folder with any static server, for example
`python3 -m http.server -d /tmp/site`.

## Playground

`playground/` runs scrutate in the browser: the CLI compiled to `wasm32-wasip1`, run in two Web
Workers (one for grep, one for the index, and file reads in whichever is free) through
[`@bjorn3/browser_wasi_shim`](https://github.com/bjorn3/browser_wasi_shim), with the files in
memory. `worker.js` adds the one call the shim lacks that scrutate needs (`path_readlink`, which
Rust's `canonicalize` uses).

- `index.html`, `app.js`: the page; `worker.js`: the engine; `load.js`: the sample, GitHub
  repositories and local folders; `list.js`: the result list; `code.js`: the file view.
- `vendor/`: `browser_wasi_shim` and the [lezer](https://github.com/lezer-parser) parsers and
  highlighter, the npm packages' `dist` files unchanged, each with its licence.
  `SOURCE.txt` in each folder names the versions.
- `samples/scrutate-src.json`: scrutate's own source at one commit, written by
  `python3 tools/make_sample.py ../scrutate <commit>`. It stays fixed while the engine follows
  new releases, so the examples on the page keep finding what they show; update it by hand and
  check that every example still answers.

The images in `assets/` are copies of `docs/assets/` in the scrutate repository, where
`tools/gen_assets.py` writes them; copy them again when they change there.

Same licence as Scrutate: MIT OR Apache-2.0. The name and the logo are covered by its
[trademark policy](https://github.com/scrutate/scrutate/blob/main/TRADEMARKS.md).
