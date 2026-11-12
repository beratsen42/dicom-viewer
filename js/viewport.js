// One image panel: rendering, touch gestures, measurements and overlays.
import { spacingOf, normalOf, dot } from './dicom.js';
import { TS_NAMES } from './decode.js';

const LOSSY = new Set(['1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51', '1.2.840.10008.1.2.4.81', '1.2.840.10008.1.2.4.91', '1.2.840.10008.1.2.4.203']);
const HANDLE_HIT = 26; // css px
const TAP_SLOP = 8;
const SCROLL_STEP = 10; // css px per slice

const COLORS = { line: '#ffd23f', active: '#4cc9f0', text: '#fff' };

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function fmt(v, d = 0) {
  if (v === undefined || v === null || !Number.isFinite(v)) return '';
  return (Math.round(v * 10 ** d) / 10 ** d).toString().replace('-', '−');
}

export class Viewport {
  constructor(container, app, id) {
    this.app = app;
    this.id = id;
    this.root = el('div', 'panel', container);
    this.canvas = el('canvas', 'panel-canvas', this.root);
    this.ctx = this.canvas.getContext('2d');
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d');

    this.ov = {};
    for (const c of ['tl', 'tr', 'bl', 'br']) this.ov[c] = el('div', `ov ov-${c}`, this.root);
    this.orient = {};
    for (const c of ['top', 'bottom', 'left', 'right']) this.orient[c] = el('div', `orient orient-${c}`, this.root);
    this.msg = el('div', 'panel-msg', this.root);
    this.spinner = el('div', 'panel-spinner', this.root);

    this.scrub = el('div', 'scrub', this.root);
    this.scrubThumb = el('div', 'scrub-thumb', this.scrub);

    this.series = null;
    this.index = 0;
    this.voi = null; // null => per-image default
    this.view = { zoom: 1, panX: 0, panY: 0, rot: 0, flipH: false, invert: false };
    this.measurements = new Map(); // image key -> []
    this.selected = null;
    this.offKey = '';
    this.shown = null; // { img, frame } actually on screen
    this.matrix = new DOMMatrix();
    this.pointers = new Map();
    this.gesture = null;
    this.lastTap = 0;
    this.renderQueued = false;

    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.root);
    this.showMessage('');
  }

  // ---------- state ----------

  get image() {
    return this.series ? this.series.images[this.index] : null;
  }

  setSeries(series, index) {
    this.series = series;
    this.index = Math.max(0, Math.min(series.images.length - 1, index ?? 0));
    this.voi = null;
    this.view = { zoom: 1, panX: 0, panY: 0, rot: 0, flipH: false, invert: false };
    this.measurements = new Map();
    this.selected = null;
    this.shown = null;
    this.offKey = '';
    this.scrub.style.display = series.images.length > 1 ? '' : 'none';
    this.showMessage('');
    this.requestRender();
    this.prefetch();
    this.app.onViewportChanged(this);
  }

  setIndex(i, fromSync = false) {
    if (!this.series) return;
    const n = this.series.images.length;
    i = Math.max(0, Math.min(n - 1, Math.round(i)));
    if (i === this.index) return;
    this.index = i;
    this.selected = null;
    this.requestRender();
    this.prefetch();
    if (!fromSync) this.app.onSliceChanged(this);
  }

  // Match another viewport's slice: by position if possible, else proportionally.
  syncTo(other) {
    if (!this.series || !other.series || this.series === other.series) {
      if (this.series === other.series && other !== this) this.setIndex(other.index, true);
      return;
    }
    const src = other.image;
    const a = src && normalOf(src);
    const b = this.series.images[0] && normalOf(this.series.images[0]);
    const samePlane = a && b && src.ipp && Math.abs(dot(a, b)) > 0.95 &&
      this.series.images.every((i) => i.ipp) && src.frameOfReferenceUID &&
      src.frameOfReferenceUID === this.series.images[0].frameOfReferenceUID;
    if (samePlane) {
      const z = dot(src.ipp, b);
      let best = 0, bestD = Infinity;
      this.series.images.forEach((img, i) => {
        const d = Math.abs(dot(img.ipp, b) - z);
        if (d < bestD) { bestD = d; best = i; }
      });
      this.setIndex(best, true);
    } else {
      const f = other.series.images.length > 1 ? other.index / (other.series.images.length - 1) : 0;
      this.setIndex(f * (this.series.images.length - 1), true);
    }
  }

  prefetch() {
    if (!this.series) return;
    const imgs = this.series.images;
    const order = [];
    for (let d = 1; d <= 6; d++) {
      if (imgs[this.index + d]) order.push(imgs[this.index + d]);
      if (imgs[this.index - d]) order.push(imgs[this.index - d]);
    }
    this.app.store.prefetch(order);
  }

  // ---------- VOI ----------

  currentVOI(img, frame) {
    if (this.voi) return this.voi;
    return this.app.store.defaultVOI(img, frame);
  }

  setVOI(wc, ww) {
    this.voi = { wc, ww: Math.max(1, ww) };
    this.requestRender();
  }

  // ---------- rendering ----------

  resize() {
    const r = this.root.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = r.width;
    this.cssH = r.height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.requestRender();
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  render() {
    const img = this.image;
    this.updateScrub();
    if (!img) {
      this.clear();
      this.updateOverlay(null, null);
      return;
    }
    const frame = this.app.store.peek(img);
    if (!frame) {
      const err = this.app.store.error(img);
      if (err) {
        this.clear();
        this.shown = null;
        this.showMessage(`Görüntü açılamadı.\n${err}`);
        this.spinner.classList.remove('on');
        this.updateOverlay(img, null);
        return;
      }
      this.spinner.classList.add('on');
      this.app.store.get(img).then(() => { if (this.image === img) this.requestRender(); },
        () => { if (this.image === img) this.requestRender(); });
      // Keep showing the last image until the new one is ready.
      if (this.shown) this.draw(this.shown.img, this.shown.frame);
      return;
    }
    this.spinner.classList.remove('on');
    this.showMessage('');
    this.shown = { img, frame };
    this.draw(img, frame);
  }

  clear() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  updateOffscreen(img, frame) {
    const voi = frame.kind === 'gray' ? this.currentVOI(img, frame) : null;
    const invert = this.view.invert !== (img.photometric === 'MONOCHROME1');
    const key = `${img.key}|${voi ? voi.wc + '/' + voi.ww : 'rgb'}|${invert}`;
    if (key === this.offKey) return;
    this.offKey = key;
    if (this.off.width !== img.cols || this.off.height !== img.rows) {
      this.off.width = img.cols;
      this.off.height = img.rows;
      this.imageData = null;
    }
    if (!this.imageData) this.imageData = this.offCtx.createImageData(img.cols, img.rows);
    const out = this.imageData.data;
    const n = img.rows * img.cols;
    if (frame.kind === 'rgb') {
      if (invert) {
        for (let i = 0; i < n * 4; i += 4) {
          out[i] = 255 - frame.rgba[i]; out[i + 1] = 255 - frame.rgba[i + 1]; out[i + 2] = 255 - frame.rgba[i + 2]; out[i + 3] = 255;
        }
      } else {
        out.set(frame.rgba);
      }
    } else {
      renderGray(frame, img, voi, invert, new Uint32Array(out.buffer));
    }
    this.offCtx.putImageData(this.imageData, 0, 0);
  }

  computeMatrix(img) {
    const sp = spacingOf(img);
    const aspect = sp && sp.col > 0 ? sp.row / sp.col : 1;
    const W = this.cssW, H = this.cssH;
    const odd = this.view.rot % 2 === 1;
    const iw = img.cols, ih = img.rows * aspect;
    const fit = odd ? Math.min(W / ih, H / iw) : Math.min(W / iw, H / ih);
    const s = fit * this.view.zoom;
    const m = new DOMMatrix()
      .translateSelf(W / 2 + this.view.panX, H / 2 + this.view.panY)
      .scaleSelf(this.view.flipH ? -1 : 1, 1) // flip in screen space
      .rotateSelf(this.view.rot * 90)
      .scaleSelf(s, s * aspect)
      .translateSelf(-img.cols / 2, -img.rows / 2);
    this.matrix = m;
    this.inverse = m.inverse();
    this.pxScale = s; // screen px per image column
  }

  draw(img, frame) {
    this.updateOffscreen(img, frame);
    this.computeMatrix(img);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const m = this.matrix;
    const d = this.dpr;
    ctx.setTransform(m.a * d, m.b * d, m.c * d, m.d * d, m.e * d, m.f * d);
    ctx.imageSmoothingEnabled = this.pxScale < 4;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.off, 0, 0);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    this.drawMeasurements(img, frame);
    this.updateOverlay(img, frame);
    this.updateOrientation(img);
  }

  // ---------- overlays ----------

  updateOverlay(img, frame) {
    const on = this.app.showInfo;
    for (const k in this.ov) this.ov[k].style.display = on ? '' : 'none';
    for (const k in this.orient) this.orient[k].style.display = on ? '' : 'none';
    if (!img) { for (const k in this.ov) this.ov[k].textContent = ''; return; }
    const n = this.series.images.length;
    const sp = spacingOf(img);
    const lines = (arr) => arr.filter(Boolean).join('\n');
    this.ov.tl.textContent = lines([
      img.patientName,
      img.patientId && `ID: ${img.patientId}`,
      [img.patientAge, img.patientSex].filter(Boolean).join(' '),
    ]);
    this.ov.tr.textContent = lines([
      img.institution,
      [img.studyDate, img.studyTime].filter(Boolean).join(' '),
      img.studyDescription,
      [img.modality, img.seriesNumber != null ? `Seri ${img.seriesNumber}` : '', img.seriesDescription].filter(Boolean).join(' · '),
    ]);
    const loc = img.sliceLocation ?? (img.z !== undefined && img.ipp ? img.ipp[2] : undefined);
    this.ov.bl.textContent = lines([
      n > 1 ? `Kesit ${this.index + 1}/${n}` : '',
      img.numFrames > 1 ? `Kare ${img.frame + 1}/${img.numFrames}` : '',
      img.sliceThickness ? `Kalınlık ${fmt(img.sliceThickness, 2)} mm` : '',
      loc !== undefined && n > 1 ? `Konum ${fmt(loc, 1)} mm` : '',
      `${img.cols}×${img.rows}`,
      LOSSY.has(img.tsuid) ? `${TS_NAMES[img.tsuid]} (kayıplı)` : '',
      sp && sp.source === 'detector' ? 'Ölçüm: dedektör düzlemi' : '',
      !sp ? 'Piksel boyutu yok: ölçüm px' : '',
    ]);
    const voi = frame && frame.kind === 'gray' ? this.currentVOI(img, frame) : null;
    this.ov.br.textContent = lines([
      voi ? `P: ${fmt(voi.wc)} / G: ${fmt(voi.ww)}` : '',
      `Büyütme ${fmt(this.view.zoom, 2)}×`,
    ]);
  }

  updateOrientation(img) {
    const set = (k, v) => { this.orient[k].textContent = v; };
    if (!img.iop) { for (const k in this.orient) set(k, ''); return; }
    const row = img.iop.slice(0, 3); // direction of increasing column (screen right at rest)
    const col = img.iop.slice(3, 6); // direction of increasing row (screen down at rest)
    // Patient direction of screen right/down after rotation, then screen flip.
    let right = row;
    let down = col;
    for (let r = 0; r < this.view.rot; r++) {
      // rotate 90° clockwise: new right = -old down, new down = old right
      const nr = down.map((v) => -v);
      down = right;
      right = nr;
    }
    if (this.view.flipH) right = right.map((v) => -v);
    const label = (v) => {
      const names = [['L', 'R'], ['P', 'A'], ['H', 'F']];
      const sorted = [0, 1, 2].sort((a, b) => Math.abs(v[b]) - Math.abs(v[a]));
      let s = '';
      for (const ax of sorted) {
        if (Math.abs(v[ax]) < 0.3) continue;
        s += v[ax] > 0 ? names[ax][0] : names[ax][1];
        if (s.length >= 2) break;
      }
      return s;
    };
    set('right', label(right));
    set('left', label(right.map((v) => -v)));
    set('bottom', label(down));
    set('top', label(down.map((v) => -v)));
  }

  updateScrub() {
    if (!this.series || this.series.images.length < 2) { this.scrub.style.display = 'none'; return; }
    this.scrub.style.display = '';
    const n = this.series.images.length;
    const f = this.index / (n - 1);
    const track = this.scrub.clientHeight - this.scrubThumb.offsetHeight;
    this.scrubThumb.style.transform = `translateY(${Math.max(0, track * f)}px)`;
  }

  showMessage(t) {
    this.msg.textContent = t;
    this.msg.style.display = t ? '' : 'none';
  }

  // ---------- measurements ----------

  list(img = this.image) {
    if (!img) return [];
    if (!this.measurements.has(img.key)) this.measurements.set(img.key, []);
    return this.measurements.get(img.key);
  }

  toScreen(p) {
    const r = this.matrix.transformPoint(new DOMPoint(p.x, p.y));
    return { x: r.x, y: r.y };
  }

  toImage(x, y) {
    const r = this.inverse.transformPoint(new DOMPoint(x, y));
    return { x: r.x, y: r.y };
  }

  drawMeasurements(img, frame) {
    const ctx = this.ctx;
    for (const m of this.list(img)) {
      const a = this.toScreen(m.p1), b = this.toScreen(m.p2);
      const color = m === this.selected ? COLORS.active : COLORS.line;
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      let labels;
      let anchor;
      if (m.type === 'length') {
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        labels = [lengthText(img, m)];
        anchor = a.y < b.y ? b : a;
      } else {
        // Ellipse defined in image space by the box p1-p2; draw via path of points.
        const cx = (m.p1.x + m.p2.x) / 2, cy = (m.p1.y + m.p2.y) / 2;
        const rx = Math.abs(m.p2.x - m.p1.x) / 2, ry = Math.abs(m.p2.y - m.p1.y) / 2;
        for (let t = 0; t <= 64; t++) {
          const ang = (t / 64) * Math.PI * 2;
          const s = this.toScreen({ x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang) });
          if (t === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        }
        ctx.closePath();
        ctx.stroke();
        labels = roiText(img, frame, m);
        const pts = [0, 1, 2, 3].map((q) => this.toScreen({ x: cx + rx * Math.cos(q * Math.PI / 2), y: cy + ry * Math.sin(q * Math.PI / 2) }));
        anchor = pts.reduce((p, c) => (c.y > p.y ? c : p));
      }
      for (const p of [a, b]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, m === this.selected ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
      }
      this.drawLabel(labels, anchor, color);
    }
  }

  drawLabel(lines, anchor, color) {
    const ctx = this.ctx;
    ctx.font = '600 14px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const lh = 17;
    let x = anchor.x + 10, y = anchor.y + 8;
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if (x + w > this.cssW - 30) x = this.cssW - 30 - w;
    if (y + lines.length * lh > this.cssH - 6) y = anchor.y - 8 - lines.length * lh;
    x = Math.max(4, x); y = Math.max(4, y);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 4, y - 3, w + 8, lines.length * lh + 4);
    ctx.fillStyle = color;
    lines.forEach((l, i) => ctx.fillText(l, x, y + i * lh));
  }

  hitMeasurement(x, y) {
    let best = null;
    for (const m of this.list()) {
      const a = this.toScreen(m.p1), b = this.toScreen(m.p2);
      for (const [h, p] of [['p1', a], ['p2', b]]) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < HANDLE_HIT && (!best || d < best.d)) best = { m, handle: h, d };
      }
    }
    if (best) return best;
    for (const m of this.list()) {
      const a = this.toScreen(m.p1), b = this.toScreen(m.p2);
      if (m.type === 'length') {
        if (segDist(x, y, a, b) < 16) return { m, handle: 'body' };
      } else {
        const p = this.toImage(x, y);
        const cx = (m.p1.x + m.p2.x) / 2, cy = (m.p1.y + m.p2.y) / 2;
        const rx = Math.abs(m.p2.x - m.p1.x) / 2 || 1, ry = Math.abs(m.p2.y - m.p1.y) / 2 || 1;
        if (((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2 <= 1.15) return { m, handle: 'body' };
      }
    }
    return null;
  }

  deleteSelectedOrAll() {
    const l = this.list();
    if (this.selected && l.includes(this.selected)) {
      l.splice(l.indexOf(this.selected), 1);
    } else {
      l.length = 0;
    }
    this.selected = null;
    this.requestRender();
  }

  // ---------- view actions ----------

  resetView() {
    Object.assign(this.view, { zoom: 1, panX: 0, panY: 0 });
    this.requestRender();
  }

  resetAll() {
    this.view = { zoom: 1, panX: 0, panY: 0, rot: 0, flipH: false, invert: false };
    this.voi = null;
    this.offKey = '';
    this.requestRender();
  }

  rotate() { this.view.rot = (this.view.rot + 1) % 4; this.requestRender(); }
  flip() { this.view.flipH = !this.view.flipH; this.requestRender(); }
  invert() { this.view.invert = !this.view.invert; this.requestRender(); }

  zoomAt(factor, x, y) {
    const z = Math.max(0.2, Math.min(40, this.view.zoom * factor));
    const f = z / this.view.zoom;
    const cx = this.cssW / 2 + this.view.panX, cy = this.cssH / 2 + this.view.panY;
    this.view.panX += (x - cx) * (1 - f);
    this.view.panY += (y - cy) * (1 - f);
    this.view.zoom = z;
    this.requestRender();
  }

  // ---------- input ----------

  bindEvents() {
    const c = this.root;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e, true));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    // Scrubber
    const scrubTo = (e) => {
      const r = this.scrub.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      this.setIndex(f * (this.series.images.length - 1));
    };
    this.scrub.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.app.setActive(this);
      try { this.scrub.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      this.scrubbing = true;
      scrubTo(e);
    });
    this.scrub.addEventListener('pointermove', (e) => { if (this.scrubbing) { e.stopPropagation(); scrubTo(e); } });
    const end = (e) => { e.stopPropagation(); this.scrubbing = false; };
    this.scrub.addEventListener('pointerup', end);
    this.scrub.addEventListener('pointercancel', end);
  }

  localXY(e) {
    const r = this.root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    e.preventDefault();
    this.app.setActive(this);
    try { this.root.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const p = this.localXY(e);
    this.pointers.set(e.pointerId, p);
    if (!this.image || !this.shown) return;

    if (this.pointers.size === 2) {
      // Start pinch; cancel any one-finger action.
      if (this.gesture && this.gesture.created) {
        const l = this.list();
        const i = l.indexOf(this.gesture.created);
        if (i >= 0) l.splice(i, 1);
      }
      const [a, b] = [...this.pointers.values()];
      this.gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      this.requestRender();
      return;
    }
    if (this.pointers.size > 2) return;

    const tool = e.button === 2 ? 'wl' : e.button === 1 ? 'pan' : this.app.tool;
    const g = { type: tool, start: p, last: p, moved: false, accum: 0, startIndex: this.index };
    if (tool === 'length' || tool === 'roi') {
      const hit = this.hitMeasurement(p.x, p.y);
      if (hit && hit.handle !== 'body') {
        g.type = 'edit';
        g.m = hit.m;
        g.handle = hit.handle;
        this.selected = hit.m;
      } else if (hit) {
        g.type = 'move-m';
        g.m = hit.m;
        g.startImg = this.toImage(p.x, p.y);
        g.orig = { p1: { ...hit.m.p1 }, p2: { ...hit.m.p2 } };
        this.selected = hit.m;
      } else {
        g.pendingCreate = true;
      }
      this.requestRender();
    }
    if (tool === 'wl') {
      const frame = this.shown.frame;
      g.voi = { ...this.currentVOI(this.shown.img, frame) };
    }
    this.gesture = g;
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.localXY(e);
    this.pointers.set(e.pointerId, p);
    const g = this.gesture;
    if (!g || g.type === 'none') return;

    if (g.type === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.view.panX += mid.x - g.mid.x;
      this.view.panY += mid.y - g.mid.y;
      if (g.dist > 10) this.zoomAt(dist / g.dist, mid.x, mid.y);
      g.dist = dist;
      g.mid = mid;
      this.requestRender();
      return;
    }

    const dx = p.x - g.last.x, dy = p.y - g.last.y;
    if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) > TAP_SLOP) g.moved = true;
    g.last = p;
    if (!g.moved) return;

    switch (g.type) {
      case 'scroll': {
        g.accum += dy;
        const steps = Math.trunc(g.accum / SCROLL_STEP);
        if (steps) {
          g.accum -= steps * SCROLL_STEP;
          this.setIndex(this.index + steps);
        }
        break;
      }
      case 'pan':
        this.view.panX += dx;
        this.view.panY += dy;
        this.requestRender();
        break;
      case 'wl': {
        if (this.shown.frame.kind !== 'gray') break;
        const s = Math.max(0.5, g.voi.ww / 250);
        g.voi.ww = Math.max(1, g.voi.ww + dx * s);
        g.voi.wc = g.voi.wc + dy * s;
        this.setVOI(g.voi.wc, g.voi.ww);
        break;
      }
      case 'length':
      case 'roi': {
        if (g.pendingCreate) {
          const start = this.toImage(g.start.x, g.start.y);
          g.created = { type: g.type, p1: start, p2: { ...start } };
          this.list().push(g.created);
          this.selected = g.created;
          g.pendingCreate = false;
        }
        g.created.p2 = this.toImage(p.x, p.y);
        this.requestRender();
        break;
      }
      case 'edit':
        g.m[g.handle] = this.toImage(p.x, p.y);
        this.requestRender();
        break;
      case 'move-m': {
        const ip = this.toImage(p.x, p.y);
        const ddx = ip.x - g.startImg.x, ddy = ip.y - g.startImg.y;
        g.m.p1 = { x: g.orig.p1.x + ddx, y: g.orig.p1.y + ddy };
        g.m.p2 = { x: g.orig.p2.x + ddx, y: g.orig.p2.y + ddy };
        this.requestRender();
        break;
      }
    }
  }

  onUp(e, cancel) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'pinch') {
      if (this.pointers.size === 0) this.gesture = null;
      else this.gesture = { type: 'none' };
      return;
    }
    if (this.pointers.size > 0) return;
    this.gesture = null;
    if (cancel || g.type === 'none') return;

    if (!g.moved) {
      // Tap: double-tap resets view; single tap selects a measurement.
      const now = performance.now();
      if (now - this.lastTap < 320) {
        this.lastTap = 0;
        this.resetView();
        return;
      }
      this.lastTap = now;
      const hit = this.hitMeasurement(g.start.x, g.start.y);
      this.selected = hit ? hit.m : null;
      this.requestRender();
      return;
    }
    if (g.created) {
      const a = this.toScreen(g.created.p1), b = this.toScreen(g.created.p2);
      if (Math.hypot(a.x - b.x, a.y - b.y) < 6) {
        const l = this.list();
        l.splice(l.indexOf(g.created), 1);
        this.selected = null;
      }
      this.requestRender();
    }
  }

  onWheel(e) {
    e.preventDefault();
    if (!this.series) return;
    this.app.setActive(this);
    if (e.ctrlKey || e.metaKey) {
      const p = this.localXY(e);
      this.zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y);
      return;
    }
    this.wheelAccum = (this.wheelAccum || 0) + e.deltaY;
    const steps = Math.trunc(this.wheelAccum / 40);
    if (steps) {
      this.wheelAccum -= steps * 40;
      this.setIndex(this.index + steps);
    }
  }
}

// ---------- pixel helpers ----------

export function renderGray(frame, img, voi, invert, out32) {
  const slope = img.slope ?? 1, intercept = img.intercept ?? 0;
  const c = voi.wc - 0.5, w = Math.max(1, voi.ww - 1);
  const lo = c - w / 2, hi = c + w / 2;
  const px = frame.pixels;
  const n = px.length;
  const toGray = (v) => {
    let y;
    if (v <= lo) y = 0;
    else if (v > hi) y = 255;
    else y = ((v - c) / w + 0.5) * 255;
    y = y | 0;
    if (invert) y = 255 - y;
    return 0xff000000 | (y << 16) | (y << 8) | y;
  };
  const range = frame.max - frame.min + 1;
  const isInt = !(px instanceof Float32Array || px instanceof Float64Array);
  if (isInt && range <= 1 << 20) {
    const lut = new Uint32Array(range);
    for (let k = 0; k < range; k++) lut[k] = toGray((frame.min + k) * slope + intercept);
    const min = frame.min;
    for (let i = 0; i < n; i++) out32[i] = lut[px[i] - min];
  } else {
    for (let i = 0; i < n; i++) out32[i] = toGray(px[i] * slope + intercept);
  }
}

function segDist(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

function lengthText(img, m) {
  const sp = spacingOf(img);
  const dx = m.p2.x - m.p1.x, dy = m.p2.y - m.p1.y;
  if (!sp) return `${fmt(Math.hypot(dx, dy), 0)} px`;
  const mm = Math.hypot(dx * sp.col, dy * sp.row);
  return mm >= 100 ? `${fmt(mm / 10, 2)} cm` : `${fmt(mm, 1)} mm`;
}

function roiText(img, frame, m) {
  const sp = spacingOf(img);
  const cx = (m.p1.x + m.p2.x) / 2, cy = (m.p1.y + m.p2.y) / 2;
  const rx = Math.abs(m.p2.x - m.p1.x) / 2, ry = Math.abs(m.p2.y - m.p1.y) / 2;
  const area = sp ? Math.PI * rx * sp.col * ry * sp.row : Math.PI * rx * ry;
  const areaText = sp ? (area >= 100 ? `${fmt(area / 100, 2)} cm²` : `${fmt(area, 1)} mm²`) : `${fmt(area, 0)} px²`;
  if (!frame || frame.kind !== 'gray') return [`Alan ${areaText}`];
  const key = `${cx},${cy},${rx},${ry},${img.key}`;
  if (m.cacheKey !== key) {
    m.cacheKey = key;
    m.stats = roiStats(frame, img, cx, cy, rx, ry);
  }
  const s = m.stats;
  const unit = img.modality === 'CT' || img.rescaleType === 'HU' ? ' HU' : '';
  if (!s) return [`Alan ${areaText}`];
  return [
    `Ort ${fmt(s.mean, 1)}${unit}  SS ${fmt(s.sd, 1)}`,
    `Min ${fmt(s.min, 0)}  Maks ${fmt(s.max, 0)}`,
    `Alan ${areaText}`,
  ];
}

function roiStats(frame, img, cx, cy, rx, ry) {
  const slope = img.slope ?? 1, intercept = img.intercept ?? 0;
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(img.cols - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(img.rows - 1, Math.ceil(cy + ry));
  let n = 0, sum = 0, sum2 = 0, min = Infinity, max = -Infinity;
  const px = frame.pixels;
  for (let y = y0; y <= y1; y++) {
    const ny = ry > 0 ? (y + 0.5 - cy) / ry : 0;
    for (let x = x0; x <= x1; x++) {
      const nx = rx > 0 ? (x + 0.5 - cx) / rx : 0;
      if (nx * nx + ny * ny > 1) continue;
      const v = px[y * img.cols + x] * slope + intercept;
      n++; sum += v; sum2 += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!n) return null;
  const mean = sum / n;
  return { n, mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), min, max };
}
