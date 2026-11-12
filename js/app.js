import { buildSeries } from './dicom.js';
import { ImageStore } from './store.js';
import { Viewport, renderGray } from './viewport.js';

const CT_PRESETS = [
  { name: 'Beyin', wc: 40, ww: 80 },
  { name: 'Subdural', wc: 75, ww: 215 },
  { name: 'İnme', wc: 40, ww: 40 },
  { name: 'Kemik', wc: 400, ww: 1800 },
  { name: 'Akciğer', wc: -600, ww: 1500 },
  { name: 'Mediasten', wc: 50, ww: 350 },
  { name: 'Abdomen', wc: 50, ww: 400 },
  { name: 'Karaciğer', wc: 30, ww: 150 },
];

const $ = (s) => document.querySelector(s);

class App {
  constructor() {
    this.store = new ImageStore();
    this.series = [];
    this.tool = 'scroll';
    this.showInfo = true;
    this.sync = false;
    this.layout = 1;
    this.viewports = [];
    this.active = null;

    this.panels = $('#panels');
    for (let i = 0; i < 2; i++) this.viewports.push(new Viewport(this.panels, this, i));
    this.setLayout(1);
    this.setActive(this.viewports[0]);
    this.bindUI();
    this.updateEmpty();
  }

  // ---------- loading ----------

  async openFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    this.showLoading('Hazırlanıyor…');
    try {
      const sources = await this.store.expand(files, (t) => this.showLoading(t));
      const { images, skipped } = await this.store.scan(sources, (t) => this.showLoading(t));
      if (!images.length) {
        this.hideLoading();
        this.toast(skipped ? 'Bu dosyalarda görüntü bulunamadı.' : 'Dosya seçilmedi.');
        return;
      }
      const all = this.series.flatMap((s) => s.images).concat(images);
      const prevIds = new Set(this.series.map((s) => s.id));
      this.series = buildSeries(all);
      this.hideLoading();
      const fresh = this.series.filter((s) => !prevIds.has(s.id));
      if (skipped) this.toast(`${images.length} görüntü yüklendi. ${skipped} dosya atlandı.`);
      // Show the first new series in the active panel (and the second one in panel 2 if split).
      const target = fresh[0] || this.series[0];
      const vpA = this.active;
      if (!vpA.series || fresh.length) vpA.setSeries(target);
      if (this.layout === 2) {
        const other = this.viewports.find((v) => v !== vpA);
        if (!other.series) other.setSeries(fresh[1] || fresh[0] || this.series[0]);
      }
      this.renderSeriesList();
      this.updateEmpty();
      this.makeThumbnails();
    } catch (e) {
      console.error(e);
      this.hideLoading();
      this.toast(`Yükleme hatası: ${e.message || e}`);
    }
  }

  clearAll() {
    this.store.clear();
    this.series = [];
    for (const v of this.viewports) {
      v.series = null;
      v.shown = null;
      v.requestRender();
    }
    this.renderSeriesList();
    this.updateEmpty();
    this.closeDrawer();
  }

  // ---------- panels ----------

  setLayout(n) {
    this.layout = n;
    this.panels.dataset.layout = n;
    this.viewports[1].root.style.display = n === 2 ? '' : 'none';
    if (n === 1 && this.active === this.viewports[1]) this.setActive(this.viewports[0]);
    if (n === 2 && !this.viewports[1].series && this.series.length) {
      const cur = this.viewports[0].series;
      const next = this.series.find((s) => s !== cur) || cur;
      this.viewports[1].setSeries(next);
    }
    $('#btn-layout').classList.toggle('on', n === 2);
    $('#btn-sync').style.display = n === 2 ? '' : 'none';
    for (const v of this.viewports) v.resize();
    this.updateEmpty();
  }

  setActive(vp) {
    if (this.active === vp) return;
    this.active = vp;
    for (const v of this.viewports) v.root.classList.toggle('active', v === vp);
    this.renderSeriesList();
    this.updatePresetState();
  }

  onViewportChanged(vp) {
    if (vp === this.active) this.renderSeriesList();
    this.updatePresetState();
  }

  onSliceChanged(vp) {
    if (!this.sync || this.layout !== 2) return;
    for (const v of this.viewports) if (v !== vp && v.series) v.syncTo(vp);
  }

  // ---------- UI ----------

  bindUI() {
    const input = $('#file-input');
    const open = () => { input.value = ''; input.click(); };
    $('#btn-open').addEventListener('click', open);
    $('#empty-open').addEventListener('click', open);
    $('#drawer-open').addEventListener('click', open);
    input.addEventListener('change', () => this.openFiles(input.files));

    $('#btn-series').addEventListener('click', () => this.toggleDrawer());
    $('#drawer-close').addEventListener('click', () => this.closeDrawer());
    $('#scrim').addEventListener('click', () => { this.closeDrawer(); this.closePresets(); });
    $('#drawer-clear').addEventListener('click', () => this.clearAll());

    $('#btn-layout').addEventListener('click', () => this.setLayout(this.layout === 1 ? 2 : 1));
    $('#btn-sync').addEventListener('click', () => {
      this.sync = !this.sync;
      $('#btn-sync').classList.toggle('on', this.sync);
      if (this.sync) this.onSliceChanged(this.active);
      this.toast(this.sync ? 'Kesit eşleme açık' : 'Kesit eşleme kapalı');
    });
    $('#btn-info').addEventListener('click', () => {
      this.showInfo = !this.showInfo;
      $('#btn-info').classList.toggle('on', this.showInfo);
      for (const v of this.viewports) v.requestRender();
    });

    document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    $('#btn-presets').addEventListener('click', () => this.togglePresets());
    $('#btn-invert').addEventListener('click', () => this.active.invert());
    $('#btn-rotate').addEventListener('click', () => this.active.rotate());
    $('#btn-flip').addEventListener('click', () => this.active.flip());
    $('#btn-delete').addEventListener('click', () => this.active.deleteSelectedOrAll());
    $('#btn-reset').addEventListener('click', () => { this.active.resetAll(); this.updatePresetState(); });

    this.buildPresets();
    this.setTool('scroll');

    // Drag & drop (desktop testing).
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => { e.preventDefault(); this.openFiles(e.dataTransfer.files); });

    // Keyboard (desktop / external keyboard).
    window.addEventListener('keydown', (e) => {
      const v = this.active;
      if (!v || !v.series) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') v.setIndex(v.index + 1);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') v.setIndex(v.index - 1);
      else if (e.key === 'Delete' || e.key === 'Backspace') v.deleteSelectedOrAll();
      else return;
      e.preventDefault();
    });

    // Block Safari page zoom gestures; panels handle pinch themselves.
    for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault());
  }

  setTool(t) {
    this.tool = t;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  }

  // ---------- presets ----------

  buildPresets() {
    const box = $('#preset-grid');
    const add = (label, sub, fn) => {
      const b = document.createElement('button');
      b.className = 'preset';
      b.innerHTML = `<span>${label}</span><small>${sub}</small>`;
      b.addEventListener('click', () => { fn(); this.closePresets(); this.updatePresetState(); });
      box.appendChild(b);
      return b;
    };
    this.presetButtons = [];
    for (const p of CT_PRESETS) {
      const b = add(p.name, `${p.wc} / ${p.ww}`, () => this.active.setVOI(p.wc, p.ww));
      b.dataset.ct = '1';
      this.presetButtons.push(b);
    }
    add('Dosya', 'kayıtlı ayar', () => { this.active.voi = null; this.active.requestRender(); });
    add('Otomatik', 'görüntüye göre', () => {
      const v = this.active;
      if (!v.shown || v.shown.frame.kind !== 'gray') return;
      const voi = this.store.autoVOI(v.shown.img, v.shown.frame);
      v.setVOI(voi.wc, voi.ww);
    });
  }

  updatePresetState() {
    const v = this.active;
    const isCT = v && v.series && v.series.modality === 'CT';
    if (!this.presetButtons) return;
    for (const b of this.presetButtons) b.classList.toggle('dim', !isCT);
    $('#preset-note').textContent = isCT ? '' : 'Hazır ayarlar BT (HU) içindir. MR ve grafide "Otomatik" kullanın.';
  }

  togglePresets() {
    const p = $('#presets');
    if (p.classList.contains('open')) this.closePresets();
    else { this.closeDrawer(); p.classList.add('open'); $('#scrim').classList.add('on'); }
  }

  closePresets() {
    $('#presets').classList.remove('open');
    if (!$('#drawer').classList.contains('open')) $('#scrim').classList.remove('on');
  }

  // ---------- series drawer ----------

  toggleDrawer() {
    if ($('#drawer').classList.contains('open')) this.closeDrawer();
    else { this.closePresets(); $('#drawer').classList.add('open'); $('#scrim').classList.add('on'); }
  }

  closeDrawer() {
    $('#drawer').classList.remove('open');
    if (!$('#presets').classList.contains('open')) $('#scrim').classList.remove('on');
  }

  renderSeriesList() {
    const list = $('#series-list');
    list.innerHTML = '';
    let lastStudy = null;
    for (const s of this.series) {
      const study = `${s.patientName}|${s.studyDate}|${s.studyUID}`;
      if (study !== lastStudy) {
        lastStudy = study;
        const h = document.createElement('div');
        h.className = 'study-head';
        h.textContent = [s.patientName, s.studyDate].filter(Boolean).join(' · ') || 'Çalışma';
        list.appendChild(h);
      }
      const item = document.createElement('button');
      item.className = 'series-item';
      if (this.active && this.active.series === s) item.classList.add('current');
      const usedBy = this.viewports.filter((v, i) => v.series === s && (i === 0 || this.layout === 2)).map((v) => v.id + 1);
      item.innerHTML = `<canvas class="thumb" width="72" height="72"></canvas>
        <div class="meta"><b></b><div class="chips"></div><span></span></div>
        <div class="badge">${usedBy.length && this.layout === 2 ? usedBy.join(',') : ''}</div>`;
      item.querySelector('b').textContent = s.description;
      const chips = item.querySelector('.chips');
      for (const t of s.tags || []) {
        const c = document.createElement('i');
        c.className = `chip chip-${t.kind}${t.guess ? ' guess' : ''}`;
        c.textContent = t.text + (t.guess ? '?' : '');
        if (t.guess) c.title = 'Çekim parametrelerinden tahmin';
        chips.appendChild(c);
      }
      item.querySelector('span').textContent = [s.modality, s.seriesNumber != null ? `#${s.seriesNumber}` : '', `${s.images.length} görüntü`].filter(Boolean).join(' · ');
      s.thumbCanvas = item.querySelector('canvas');
      if (s.thumb) s.thumbCanvas.getContext('2d').drawImage(s.thumb, 0, 0);
      item.addEventListener('click', () => {
        this.active.setSeries(s);
        if (this.sync) this.onSliceChanged(this.viewports.find((v) => v !== this.active && v.series) || this.active);
        this.renderSeriesList();
        this.closeDrawer();
      });
      list.appendChild(item);
    }
    $('#drawer-empty').style.display = this.series.length ? 'none' : '';
  }

  async makeThumbnails() {
    for (const s of this.series) {
      if (s.thumb) continue;
      const img = s.images[Math.floor(s.images.length / 2)];
      try {
        const frame = await this.store.get(img);
        const c = document.createElement('canvas');
        c.width = img.cols; c.height = img.rows;
        const cx = c.getContext('2d');
        const id = cx.createImageData(img.cols, img.rows);
        if (frame.kind === 'gray') {
          renderGray(frame, img, this.store.defaultVOI(img, frame), img.photometric === 'MONOCHROME1', new Uint32Array(id.data.buffer));
        } else id.data.set(frame.rgba);
        cx.putImageData(id, 0, 0);
        const t = document.createElement('canvas');
        t.width = 72; t.height = 72;
        const tc = t.getContext('2d');
        tc.fillStyle = '#000'; tc.fillRect(0, 0, 72, 72);
        const k = Math.min(72 / img.cols, 72 / img.rows);
        tc.drawImage(c, (72 - img.cols * k) / 2, (72 - img.rows * k) / 2, img.cols * k, img.rows * k);
        s.thumb = t;
        if (s.thumbCanvas) s.thumbCanvas.getContext('2d').drawImage(t, 0, 0);
      } catch { /* no thumbnail */ }
    }
  }

  // ---------- misc ----------

  updateEmpty() {
    const empty = !this.series.length;
    $('#empty').style.display = empty ? '' : 'none';
    document.body.classList.toggle('no-data', empty);
  }

  showLoading(t) {
    $('#loading').classList.add('on');
    $('#loading-text').textContent = t;
  }

  hideLoading() {
    $('#loading').classList.remove('on');
  }

  toast(t) {
    const el = $('#toast');
    el.textContent = t;
    el.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
  }
}

window.app = new App();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
