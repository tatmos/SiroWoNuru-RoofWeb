// 右手の扇メニュー（ゲームの player_avatar_place_guide.gd の bracelet fan をデスクトップの画面に移したもの）。
// 右クリックで出す／閉じる。ホイールで選び、左クリックで持つ（扇は閉じる）。
// 弧の上に板を並べ、選んでいる板は大きく明るく、両わきは小さく暗く。左右 3 枚ずつまで見せる。
const STEP_DEG = 22.0; // 板どうしの角度
const GAP_DEG = 9.0; // 選んでいる板のとなりは少し離す
const SIDE_COUNT = 3;
const OPEN_SEC = 0.22;
const CLOSE_SEC = 0.15;
const RADIUS_PX = 210;
const LIFT_PX = 120; // 右手から真ん中の板までの高さ
const CUR_SCALE = 1.0;
const SIDE_SCALE = 0.72;
const SIDE_DIM = 0.62;

export class FanMenu {
  // o: {page(name) -> {entries: [{label, art?, sym?, swatch?, count?, held?, empty?, run() -> 次のページ名 | null}], cursor},
  //     anchor() -> {x, y}（右手の画面位置）}
  // 項目を選ぶと run() する。ページ名が返れば、扇は開いたままそのページへ（入れ物の 2 階層目。ゲームと同じ）
  constructor(o) {
    this.o = o;
    this.open = false;
    this.cursor = 0;
    this.t = 0; // 開き具合 0..1
    this.page = 'main';
    this.entries = [];
    this.slots = [];
    this.el = document.createElement('div');
    this.el.id = 'fan';
    document.body.appendChild(this.el);
    this.hint = document.createElement('div');
    this.hint.className = 'fan-hint';
    this.hint.textContent = 'ホイールで選ぶ ／ 左クリックで決める ／ 右クリックで閉じる';
    this.el.appendChild(this.hint);
  }

  _setPage(name) {
    this.page = name;
    const pg = this.o.page(name);
    this.entries = pg.entries;
    this.cursor = Math.max(0, Math.min(this.entries.length - 1, pg.cursor | 0));
    for (const d of this.slots) d.remove();
    this.slots = this.entries.map((e) => {
      const d = document.createElement('div');
      d.className = 'fan-slot';
      const art = e.art
        ? `<span class="art" style="background-image:url('${e.art}')"></span>`
        : (e.swatch ? `<span class="art swatch" style="background:${e.swatch}"></span>` : `<span class="art sym">${e.sym || ''}</span>`);
      d.innerHTML = `${art}<span class="lab">${e.label}</span><span class="n"></span>`;
      this.el.insertBefore(d, this.hint);
      return d;
    });
  }

  toggle() { if (this.open) this.close(); else this.show(); }

  show(page = 'main') {
    this.open = true;
    this._setPage(page);
    this.el.classList.add('on');
  }

  close() { this.open = false; }

  step(dir) {
    if (!this.open || !this.entries.length) return;
    this.cursor = (this.cursor + dir + this.entries.length) % this.entries.length;
  }

  // 左クリック: カーソルの項目を決める
  confirm() {
    if (!this.open) return;
    const e = this.entries[this.cursor];
    const next = e && e.run ? e.run() : null;
    if (!next) { this.close(); return; }
    // 同じページのまま（取り消しなど）は、カーソルをその項目に残す
    const keep = next === this.page ? this.cursor : -1;
    this._setPage(next);
    if (keep >= 0) this.cursor = Math.min(keep, this.entries.length - 1);
  }

  // クリックした板があればそれを決める
  clickAt(x, y) {
    for (let i = 0; i < this.slots.length; i++) {
      const r = this.slots[i].getBoundingClientRect();
      if (this.slots[i].style.visibility !== 'hidden' && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        this.cursor = i;
        this.confirm();
        return true;
      }
    }
    return false;
  }

  update(dt) {
    this.t = this.open ? Math.min(1, this.t + dt / OPEN_SEC) : Math.max(0, this.t - dt / CLOSE_SEC);
    if (this.t <= 0) { this.el.classList.remove('on'); return; }
    this.el.classList.add('on');
    const e = 1 - Math.pow(1 - this.t, 3); // ease out
    const a0 = this.o.anchor();
    const n = this.entries.length;
    this.slots.forEach((slot, i) => {
      // カーソルからの番号の差（輪になっているので近いほうで）
      let d = i - this.cursor;
      if (d > n / 2) d -= n;
      if (d < -n / 2) d += n;
      const ad = Math.abs(d);
      if (ad > SIDE_COUNT + 0.5) { slot.style.visibility = 'hidden'; return; }
      slot.style.visibility = 'visible';
      const deg = d * STEP_DEG + Math.sign(d) * Math.min(ad, 1) * GAP_DEG;
      const a = (deg * Math.PI / 180) * e;
      const x = a0.x + Math.sin(a) * RADIUS_PX;
      // 弧は真ん中の板がいちばん上で、両わきへ下がる（右手の少し上が真ん中）
      const y = a0.y - LIFT_PX + (1 - Math.cos(a)) * RADIUS_PX;
      const near = Math.min(1, Math.max(0, 1 - ad));
      let sc = SIDE_SCALE * (1 + (0.72 - 1) * Math.min(1, Math.max(0, (ad - 1) / 2)));
      sc = sc + (CUR_SCALE - sc) * near;
      sc *= 0.35 + 0.65 * e;
      const dim = SIDE_DIM + (1 - SIDE_DIM) * near;
      slot.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${sc})`;
      slot.style.opacity = String(Math.min(1, e * 1.6));
      slot.style.filter = `brightness(${dim})`;
      slot.classList.toggle('cur', ad < 0.5);
      const ent = this.entries[i];
      slot.classList.toggle('held', !!(ent.held && ent.held()));
      const num = slot.querySelector('.n');
      const cnt = ent.count ? String(ent.count()) : '';
      if (num.textContent !== cnt) num.textContent = cnt;
      slot.classList.toggle('empty', !!(ent.empty && ent.empty()));
      slot.style.zIndex = String(10 - Math.round(ad));
    });
    this.hint.style.transform = `translate(${a0.x}px, ${a0.y + 40}px) translate(-50%, 0)`;
    this.hint.style.opacity = String(e);
  }
}
