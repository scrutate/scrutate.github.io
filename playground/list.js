// A list that renders only the rows on screen. Each row has a fixed height (row.h), rows with
// row.pick can be selected, and a row's group header (row.head) stays pinned at the top.
export class VList {
  constructor(root, render) {
    this.root = root;
    this.render = render;
    root.innerHTML = '<div class="vl-pin" aria-hidden="true"></div><div class="vl-size"></div>';
    this.pin = root.firstChild;
    this.size = root.lastChild;
    this.rows = [];
    this.tops = [0];
    this.picks = [];
    this.sel = -1;
    this.gen = 0;
    this.span = [0, 0];
    this.raf = 0;
    root.addEventListener("scroll", () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(root);
  }

  set(rows, keep) {
    this.rows = rows;
    this.gen++;
    this.tops = new Array(rows.length + 1);
    this.tops[0] = 0;
    this.picks = [];
    let head = -1;
    for (let i = 0; i < rows.length; i++) {
      this.tops[i + 1] = this.tops[i] + rows[i].h;
      if (rows[i].group) head = i;
      else rows[i].head ??= head;
      if (rows[i].pick) this.picks.push(i);
    }
    this.size.style.height = `${this.tops[rows.length]}px`;
    this.sel = -1;
    if (!keep) this.root.scrollTop = 0;
    this.root.removeAttribute("aria-activedescendant");
    this.paint(true);
  }

  id(i) {
    return `r${this.gen}-${i}`;
  }

  at(y) {
    let lo = 0;
    let hi = this.rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // Selects row i (a pickable row index) and keeps it in view.
  select(i, scroll = true) {
    if (i < 0 || !this.rows[i] || !this.rows[i].pick) return;
    this.sel = i;
    if (scroll) this.reveal(i);
    this.root.setAttribute("aria-activedescendant", this.id(i));
    this.paint(true);
  }

  reveal(i) {
    const r = this.root;
    const pinH = this.rows[i].head >= 0 ? this.rows[this.rows[i].head].h : 0;
    const top = this.tops[i];
    const bottom = this.tops[i + 1];
    if (top - pinH < r.scrollTop) r.scrollTop = top - pinH;
    else if (bottom > r.scrollTop + r.clientHeight) r.scrollTop = bottom - r.clientHeight;
  }

  // Moves the selection by n pickable rows, or to the first (n = -Infinity) or last.
  move(n) {
    if (!this.picks.length) return -1;
    let k = this.picks.indexOf(this.sel);
    if (n === -Infinity) k = 0;
    else if (n === Infinity) k = this.picks.length - 1;
    else k = k < 0 ? (n > 0 ? 0 : this.picks.length - 1) : Math.max(0, Math.min(this.picks.length - 1, k + n));
    this.select(this.picks[k]);
    return this.picks[k];
  }

  pageSize() {
    return Math.max(1, Math.floor(this.root.clientHeight / 24) - 2);
  }

  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint(false);
    });
  }

  paint(force) {
    const r = this.root;
    const n = this.rows.length;
    if (!n) {
      this.size.innerHTML = "";
      this.pin.hidden = true;
      return;
    }
    const top = r.scrollTop;
    const first = this.at(top);
    const last = this.at(top + r.clientHeight);
    if (!force && first >= this.span[0] && last < this.span[1]) return this.pinHead(first, top);
    const a = Math.max(0, first - 30);
    const b = Math.min(n, last + 31);
    this.span = [a, b];
    let h = "";
    for (let i = a; i < b; i++) {
      const row = this.rows[i];
      const sel = i === this.sel;
      const attrs = row.pick
        ? ` id="${this.id(i)}" role="option" aria-selected="${sel}" data-i="${i}"${row.label ? ` aria-label="${row.label}"` : ""}`
        : ' role="presentation"';
      h += `<div class="vr ${row.cls || ""}${sel ? " on" : ""}"${attrs} style="top:${this.tops[i]}px;height:${row.h}px">${this.render(row, i)}</div>`;
    }
    this.size.innerHTML = h;
    this.pinHead(first, top);
  }

  pinHead(first, top) {
    const row = this.rows[first];
    const head = row.group ? first : row.head;
    if (head == null || head < 0 || (row.group && this.tops[first] === top)) {
      this.pin.hidden = true;
      return;
    }
    const hrow = this.rows[head];
    let next = first + 1;
    while (next < this.rows.length && !this.rows[next].group) next++;
    const push = next < this.rows.length ? Math.min(0, this.tops[next] - top - hrow.h) : 0;
    if (this.pin.dataset.head !== `${this.gen}-${head}`) {
      this.pin.dataset.head = `${this.gen}-${head}`;
      this.pin.className = `vl-pin vr ${hrow.cls || ""}`;
      this.pin.style.height = `${hrow.h}px`;
      this.pin.style.marginBottom = `${-hrow.h}px`;
      this.pin.innerHTML = this.render(hrow, head);
    }
    this.pin.style.transform = `translateY(${push}px)`;
    this.pin.hidden = false;
  }
}
