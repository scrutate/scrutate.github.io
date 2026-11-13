# scrutate.github.io

The website of [Scrutate](https://github.com/scrutate/scrutate), served by GitHub Pages at
https://scrutate.github.io from the root of `main`.

Plain HTML and CSS, no build step. To preview, open `index.html` or run
`python3 -m http.server` in this folder. The images in `assets/` are copies of
`docs/assets/` in the scrutate repository, where `tools/gen_assets.py` writes them; copy them
again when they change there.

## Playground

`playground/` runs scrutate in the browser: the CLI compiled to `wasm32-wasip1`, run in two Web
Workers (one for grep and file reads, one for the index) through
[`@bjorn3/browser_wasi_shim`](https://github.com/bjorn3/browser_wasi_shim), with the files in
memory. It needs `playground/scrutate.wasm`, which is not kept in this repository; put the build
next to `playground/index.html` before you serve the folder.

- `index.html`, `app.js`: the page; `worker.js`: the engine; `load.js`: the sample, GitHub
  repositories and local folders; `list.js`: the result list; `code.js`: the file view.
- `vendor/`: `browser_wasi_shim` and the [lezer](https://github.com/lezer-parser) parsers and
  highlighter, the npm packages' `dist/index.js` files unchanged, each with its licence.
  `SOURCE.txt` in each folder names the versions.
- `samples/scrutate-src.json`: scrutate's own source at one commit, written by
  `python3 tools/make_sample.py ../scrutate <commit>`.

Same licence as Scrutate: MIT OR Apache-2.0. The name and the logo are covered by its
[trademark policy](https://github.com/scrutate/scrutate/blob/main/TRADEMARKS.md).
