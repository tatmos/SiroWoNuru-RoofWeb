// 画面の上のボタン・右手メニュー（建築の持ち物）・カード選び
export class Hud {
  constructor(o) {
    this.o = o;
    this.menu = document.getElementById('menu');
    this.toastEl = document.getElementById('toast');
    this.hintEl = document.getElementById('hint');
    this.cardsEl = document.getElementById('cards');
    this._buildMenu();
    this._buildTop();
  }

  _buildMenu() {
    this.slots = this.o.items.map((it, i) => {
      const b = document.createElement('button');
      b.className = 'slot';
      b.dataset.kind = it.kind;
      b.innerHTML = it.art
        ? `<span class="art" style="background-image:url('${it.art}')"></span><span class="lab">${it.label}</span><span class="n"></span><span class="key">${i + 1}</span>`
        : `<span class="art pick">⤺</span><span class="lab">${it.label}</span><span class="n"></span><span class="key">${i + 1}</span>`;
      b.addEventListener('click', (e) => { this.o.select(i); e.stopPropagation(); });
      b.addEventListener('touchstart', (e) => { this.o.select(i); e.preventDefault(); e.stopPropagation(); }, { passive: false });
      this.menu.appendChild(b);
      return b;
    });
  }

  _buildTop() {
    const $ = (id) => document.getElementById(id);
    $('btn-export-json').onclick = () => this.o.exportJson();
    const file = $('file-json');
    $('btn-import-json').onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      this.o.importJson(await f.text());
      file.value = '';
    };
    $('btn-export-3mf').onclick = () => this.o.export3mf($('chk-base').checked);
    $('btn-sample').onclick = () => { if (confirm('いまの屋上の建材を消して、見本の建物を読み込みますか？')) this.o.loadSample(); };
    $('btn-clear').onclick = () => { if (confirm('屋上の建材をすべて消しますか？（持ち物の数は戻りません）')) this.o.clearAll(); };
    $('btn-respawn').onclick = () => this.o.respawn();
    $('btn-help').onclick = () => document.body.classList.toggle('show-help');
    $('help').onclick = () => document.body.classList.remove('show-help');
    $('btn-menu').onclick = () => document.body.classList.toggle('show-tools');
  }

  setupXrButton(xr) {
    const b = document.getElementById('btn-vr');
    xr.checkSupport().then((ok) => {
      b.hidden = false;
      b.disabled = !ok;
      b.title = ok ? 'VR ゴーグルで遊ぶ（WebXR）' : 'このブラウザは WebXR の VR に対応していません';
      if (!ok) b.textContent = 'VR 非対応';
    });
    b.onclick = () => xr.start();
  }

  refresh() {
    const sel = this.o.getSelected();
    this.slots.forEach((b, i) => {
      const it = this.o.items[i];
      b.classList.toggle('sel', i === sel);
      const n = b.querySelector('.n');
      n.textContent = it.kind === 'pickup' ? '' : String(this.o.stock[it.kind] | 0);
      b.classList.toggle('empty', it.kind !== 'pickup' && (this.o.stock[it.kind] | 0) <= 0);
    });
  }

  setAimHint(aim, inXr) {
    let t = '';
    if (aim.pickMode) t = aim.pickPiece ? 'クリックで回収' : '';
    else if (aim.target) {
      if (!aim.target.ok) t = aim.reason || '';
      else if (aim.pressing && performance.now() - aim.pressAt >= 220) t = '放すと壁';
      else t = aim.target.horizontal ? (aim.target.snap === 'hex_slope' ? '坂' : '押す: 床　長押し: 壁') : '';
    }
    if (inXr) t = '';
    if (this._hint !== t) { this._hint = t; this.hintEl.textContent = t; this.hintEl.classList.toggle('on', !!t); }
  }

  toast(msg, ms = 2600) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('on');
    clearTimeout(this._tt);
    this._tt = setTimeout(() => this.toastEl.classList.remove('on'), ms);
  }

  // 宝箱のカード（3 枚から 1 枚）
  showCards(cards, pick) {
    const box = this.cardsEl;
    box.innerHTML = '<div class="title">宝箱！ カードを 1 枚えらぶ</div>';
    const row = document.createElement('div');
    row.className = 'row';
    for (const c of cards) {
      const b = document.createElement('button');
      b.className = 'card';
      b.innerHTML = `<span class="art" style="background-image:url('${c.art}')"></span><span class="name">${c.label}補給</span><span class="desc">${c.label}の建材を10個追加する</span>`;
      b.onclick = () => { box.classList.remove('on'); pick(c); };
      row.appendChild(b);
    }
    box.appendChild(row);
    box.classList.add('on');
  }

  hideCards() { this.cardsEl.classList.remove('on'); }
}
