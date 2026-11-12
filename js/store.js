// Loads files, keeps decoded frames in a memory-bounded cache.
import { parseBuffer, looksLikeDicom, extractImages } from './dicom.js';
import { decodeImage } from './decode.js';

const FRAME_BUDGET = 700 * 1024 * 1024; // bytes of decoded pixels kept in memory
const DS_CACHE = 3; // parsed files kept (useful for multi-frame files)

let sourceId = 0;

// dicomParser and some codecs throw strings or plain objects.
export function errorText(e) {
  if (!e) return 'Bilinmeyen hata';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.exception) return String(e.exception);
  return String(e);
}

export function fileSource(file, name = file.name) {
  return { id: ++sourceId, name, size: file.size, read: () => file.arrayBuffer() };
}

export class ImageStore {
  constructor() {
    this.frames = new Map(); // key -> frame (Map keeps insertion order => LRU)
    this.bytes = 0;
    this.inflight = new Map();
    this.errors = new Map();
    this.datasets = new Map(); // source id -> dataset
    this.voiCache = new Map();
    this.queue = [];
    this.pumping = false;
  }

  // ---------- loading ----------

  // Expand ZIP files into sources. Returns a flat list of sources.
  async expand(files, onProgress) {
    const out = [];
    for (const f of files) {
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.zip')) {
        onProgress && onProgress(`ZIP açılıyor: ${f.name}`);
        const zip = await JSZip.loadAsync(f);
        zip.forEach((path, entry) => {
          if (entry.dir) return;
          const base = path.split('/').pop();
          if (path.startsWith('__MACOSX/') || base.startsWith('.') || /\.(txt|xml|html?|pdf|jpe?g|png|exe|inf|ini|htm|js|css|bat)$/i.test(base)) return;
          out.push({ id: ++sourceId, name: path, read: () => entry.async('arraybuffer') });
        });
      } else if (!f.name.startsWith('.')) {
        out.push(fileSource(f));
      }
    }
    return out;
  }

  // Parse headers of all sources. Returns { images, skipped }.
  async scan(sources, onProgress) {
    const images = [];
    let skipped = 0, done = 0;
    const work = async (src) => {
      try {
        const buf = await src.read();
        if (!looksLikeDicom(buf)) { skipped++; return; }
        const ds = parseBuffer(buf);
        const imgs = extractImages(ds, src);
        if (!imgs.length) { skipped++; return; }
        images.push(...imgs);
        if (imgs.length > 1) this.rememberDataset(src, ds);
      } catch (e) {
        skipped++;
      } finally {
        done++;
        if (onProgress && (done % 5 === 0 || done === sources.length)) onProgress(`Okunuyor ${done}/${sources.length}`);
      }
    };
    let i = 0;
    const workers = Array.from({ length: 4 }, async () => {
      while (i < sources.length) await work(sources[i++]);
    });
    await Promise.all(workers);
    return { images, skipped };
  }

  rememberDataset(src, ds) {
    this.datasets.delete(src.id);
    this.datasets.set(src.id, ds);
    while (this.datasets.size > DS_CACHE) this.datasets.delete(this.datasets.keys().next().value);
  }

  async dataset(src) {
    if (this.datasets.has(src.id)) {
      const ds = this.datasets.get(src.id);
      this.rememberDataset(src, ds);
      return ds;
    }
    const ds = parseBuffer(await src.read());
    this.rememberDataset(src, ds);
    return ds;
  }

  // ---------- frames ----------

  peek(img) {
    const f = this.frames.get(img.key);
    if (f) { this.frames.delete(img.key); this.frames.set(img.key, f); }
    return f;
  }

  error(img) {
    return this.errors.get(img.key);
  }

  get(img) {
    const f = this.frames.get(img.key);
    if (f) return Promise.resolve(f);
    if (this.errors.has(img.key)) return Promise.reject(new Error(this.errors.get(img.key)));
    if (this.inflight.has(img.key)) return this.inflight.get(img.key);
    const p = (async () => {
      try {
        const ds = await this.dataset(img.source);
        const frame = await decodeImage(ds, img);
        if (img.numFrames === 1) this.datasets.delete(img.source.id);
        this.put(img.key, frame);
        return frame;
      } catch (e) {
        const msg = errorText(e);
        this.errors.set(img.key, msg);
        throw new Error(msg);
      } finally {
        this.inflight.delete(img.key);
      }
    })();
    this.inflight.set(img.key, p);
    return p;
  }

  put(key, frame) {
    frame.bytes = frame.kind === 'gray' ? frame.pixels.byteLength : frame.rgba.byteLength;
    this.frames.set(key, frame);
    this.bytes += frame.bytes;
    while (this.bytes > FRAME_BUDGET && this.frames.size > 1) {
      const [k, f] = this.frames.entries().next().value;
      this.frames.delete(k);
      this.bytes -= f.bytes;
    }
  }

  // Low-priority background decoding (nearest slices first).
  prefetch(list) {
    this.queue = list.filter((img) => !this.frames.has(img.key) && !this.errors.has(img.key));
    this.pump();
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length) {
      const img = this.queue.shift();
      if (this.frames.has(img.key)) continue;
      try { await this.get(img); } catch { /* shown when viewed */ }
      await new Promise((r) => setTimeout(r, 0));
    }
    this.pumping = false;
  }

  // ---------- window / level ----------

  defaultVOI(img, frame) {
    if (img.windowWidth > 0 && Number.isFinite(img.windowCenter)) {
      return { wc: img.windowCenter, ww: img.windowWidth };
    }
    return this.autoVOI(img, frame);
  }

  autoVOI(img, frame) {
    if (this.voiCache.has(img.key)) return this.voiCache.get(img.key);
    const slope = img.slope ?? 1, intercept = img.intercept ?? 0;
    const lo0 = frame.min * slope + intercept, hi0 = frame.max * slope + intercept;
    const a = Math.min(lo0, hi0), b = Math.max(lo0, hi0);
    let voi;
    if (b - a < 1) {
      voi = { wc: a, ww: 1 };
    } else {
      const bins = 2048;
      const hist = new Uint32Array(bins);
      const px = frame.pixels;
      const step = Math.max(1, Math.floor(px.length / 300000));
      let count = 0;
      for (let i = 0; i < px.length; i += step) {
        const v = px[i] * slope + intercept;
        hist[Math.min(bins - 1, Math.floor(((v - a) / (b - a)) * bins))]++;
        count++;
      }
      const pick = (q) => {
        let acc = 0;
        for (let i = 0; i < bins; i++) { acc += hist[i]; if (acc >= q * count) return a + (i / bins) * (b - a); }
        return b;
      };
      const lo = pick(0.005), hi = pick(0.995);
      voi = { wc: (lo + hi) / 2, ww: Math.max(1, hi - lo) };
    }
    this.voiCache.set(img.key, voi);
    return voi;
  }

  clear() {
    this.frames.clear();
    this.bytes = 0;
    this.errors.clear();
    this.datasets.clear();
    this.voiCache.clear();
    this.queue = [];
  }
}
