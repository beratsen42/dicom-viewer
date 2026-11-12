// Pixel data decoding for all supported transfer syntaxes.
// Returns { kind: 'gray', pixels, min, max } or { kind: 'rgb', rgba }.

const TS = {
  IMPLICIT_LE: '1.2.840.10008.1.2',
  EXPLICIT_LE: '1.2.840.10008.1.2.1',
  EXPLICIT_BE: '1.2.840.10008.1.2.2',
  DEFLATE: '1.2.840.10008.1.2.1.99',
  JPEG_BASELINE: '1.2.840.10008.1.2.4.50',
  JPEG_EXTENDED: '1.2.840.10008.1.2.4.51',
  JPEG_LOSSLESS: '1.2.840.10008.1.2.4.57',
  JPEG_LOSSLESS_SV1: '1.2.840.10008.1.2.4.70',
  JPEG_LS: '1.2.840.10008.1.2.4.80',
  JPEG_LS_NEAR: '1.2.840.10008.1.2.4.81',
  J2K_LOSSLESS: '1.2.840.10008.1.2.4.90',
  J2K: '1.2.840.10008.1.2.4.91',
  HTJ2K_LOSSLESS: '1.2.840.10008.1.2.4.201',
  HTJ2K_RPCL: '1.2.840.10008.1.2.4.202',
  HTJ2K: '1.2.840.10008.1.2.4.203',
  RLE: '1.2.840.10008.1.2.5',
};

export const TS_NAMES = {
  [TS.IMPLICIT_LE]: 'Sıkıştırmasız',
  [TS.EXPLICIT_LE]: 'Sıkıştırmasız',
  [TS.EXPLICIT_BE]: 'Sıkıştırmasız (BE)',
  [TS.JPEG_BASELINE]: 'JPEG',
  [TS.JPEG_EXTENDED]: 'JPEG 12-bit',
  [TS.JPEG_LOSSLESS]: 'JPEG Lossless',
  [TS.JPEG_LOSSLESS_SV1]: 'JPEG Lossless',
  [TS.JPEG_LS]: 'JPEG-LS',
  [TS.JPEG_LS_NEAR]: 'JPEG-LS',
  [TS.J2K_LOSSLESS]: 'JPEG 2000',
  [TS.J2K]: 'JPEG 2000',
  [TS.HTJ2K_LOSSLESS]: 'HTJ2K',
  [TS.HTJ2K_RPCL]: 'HTJ2K',
  [TS.HTJ2K]: 'HTJ2K',
  [TS.RLE]: 'RLE',
};

// ---------- lazy codec loading ----------

const codecs = {};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Kod çözücü yüklenemedi: ${src}`));
    document.head.appendChild(s);
  });
}

async function wasmCodec(name, script, globalName, className) {
  if (!codecs[name]) {
    codecs[name] = (async () => {
      await loadScript(`vendor/${script}`);
      const mod = await window[globalName]({ locateFile: (f) => `vendor/${f}` });
      return new mod[className]();
    })();
  }
  return codecs[name];
}

async function jpegBaseline() {
  if (!codecs.jpeg) codecs.jpeg = import('../vendor/jpeg-baseline.js').then((m) => m.default);
  return codecs.jpeg;
}

async function jpegLossless() {
  if (!codecs.lossless) codecs.lossless = import('../vendor/jpeg-lossless.js').then((m) => m.Decoder);
  return codecs.lossless;
}

// ---------- frame byte extraction ----------

function encapsulatedFrame(ds, el, img) {
  const frames = img.numFrames;
  if (el.basicOffsetTable && el.basicOffsetTable.length) {
    return dicomParser.readEncapsulatedImageFrame(ds, el, img.frame);
  }
  if (frames === 1) {
    return dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, 0, el.fragments.length);
  }
  if (frames === el.fragments.length) {
    return dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, img.frame, 1);
  }
  const bot = dicomParser.createJPEGBasicOffsetTable(ds, el);
  return dicomParser.readEncapsulatedImageFrame(ds, el, img.frame, bot);
}

function nativeFrame(ds, el, img) {
  const bytesPerSample = img.bitsAllocated / 8;
  // YBR_FULL_422 stores 2 samples per pixel on average (Y Y Cb Cr per 2 pixels).
  const spp = img.photometric === 'YBR_FULL_422' ? 2 : img.samplesPerPixel;
  const frameSize = img.rows * img.cols * spp * bytesPerSample;
  const start = el.dataOffset + img.frame * frameSize;
  if (start + frameSize > ds.byteArray.length) throw new Error('Piksel verisi eksik (dosya kesik olabilir)');
  // slice() copies into a fresh, aligned buffer.
  const bytes = ds.byteArray.slice(start, start + frameSize);
  if (img.tsuid === TS.EXPLICIT_BE && bytesPerSample === 2) {
    for (let i = 0; i < bytes.length; i += 2) {
      const t = bytes[i]; bytes[i] = bytes[i + 1]; bytes[i + 1] = t;
    }
  } else if (img.tsuid === TS.EXPLICIT_BE && bytesPerSample === 4) {
    for (let i = 0; i < bytes.length; i += 4) {
      let t = bytes[i]; bytes[i] = bytes[i + 3]; bytes[i + 3] = t;
      t = bytes[i + 1]; bytes[i + 1] = bytes[i + 2]; bytes[i + 2] = t;
    }
  }
  return bytes;
}

// Decide if a 3-component JPEG (without an Adobe marker) holds YCbCr.
// R,G,B component IDs => RGB. JFIF marker => YCbCr. Otherwise follow the DICOM header.
function jpegNeedsYCbCr(data, photometric) {
  let jfif = false;
  for (let i = 2; i + 16 < data.length; ) {
    if (data[i] !== 0xff) { i++; continue; }
    const m = data[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xe0 && data[i + 4] === 0x4a && data[i + 5] === 0x46 && data[i + 6] === 0x49 && data[i + 7] === 0x46) jfif = true;
    if (m >= 0xc0 && m <= 0xc3) {
      if (data[i + 9] === 3 && data[i + 10] === 0x52 && data[i + 13] === 0x47 && data[i + 16] === 0x42) return false;
      break;
    }
    if (m === 0xda) break;
    i += 2 + ((data[i + 2] << 8) | data[i + 3]);
  }
  if (jfif) return true;
  return photometric !== 'RGB';
}

// ---------- RLE ----------

function decodeRLE(data, img) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nSeg = view.getUint32(0, true);
  const offsets = [];
  for (let i = 0; i < nSeg; i++) offsets.push(view.getUint32(4 + i * 4, true));
  const n = img.rows * img.cols;
  const bps = img.bitsAllocated / 8;
  const spp = img.samplesPerPixel;
  const out = new Uint8Array(n * spp * bps);
  for (let s = 0; s < nSeg; s++) {
    const sample = Math.floor(s / bps);
    const byteIdx = bps - 1 - (s % bps); // first segment is MSB
    const stride = spp * bps;
    let outPos = sample * bps + byteIdx;
    let p = offsets[s];
    const end = s + 1 < nSeg ? offsets[s + 1] : data.length;
    let written = 0;
    while (p < end && written < n) {
      const c = (data[p++] << 24) >> 24;
      if (c >= 0) {
        for (let k = 0; k <= c && written < n; k++) { out[outPos] = data[p++]; outPos += stride; written++; }
      } else if (c !== -128) {
        const v = data[p++];
        for (let k = 0; k < 1 - c && written < n; k++) { out[outPos] = v; outPos += stride; written++; }
      }
    }
  }
  return out;
}

// ---------- typed array helpers ----------

function typedFromBytes(bytes, img, bitsOverride, signedOverride) {
  const bits = bitsOverride || img.bitsAllocated;
  const signed = signedOverride ?? img.pixelRepresentation === 1;
  const buf = bytes.byteOffset % 4 === 0 ? bytes.buffer : bytes.slice().buffer;
  const off = bytes.byteOffset % 4 === 0 ? bytes.byteOffset : 0;
  if (bits <= 8) return signed ? new Int8Array(buf, off, bytes.byteLength) : new Uint8Array(buf, off, bytes.byteLength);
  if (bits <= 16) return signed ? new Int16Array(buf, off, bytes.byteLength >> 1) : new Uint16Array(buf, off, bytes.byteLength >> 1);
  return signed ? new Int32Array(buf, off, bytes.byteLength >> 2) : new Uint32Array(buf, off, bytes.byteLength >> 2);
}

// Apply bits-stored masking / sign extension and compute range.
function finishGray(pixels, img, applyBits) {
  const bs = img.bitsStored;
  const ba = img.bitsAllocated;
  if (applyBits && bs < ba && ba <= 16) {
    const shift = 32 - bs;
    if (img.pixelRepresentation === 1) {
      const out = new Int16Array(pixels.length);
      for (let i = 0; i < pixels.length; i++) out[i] = ((pixels[i] & 0xffff) << shift) >> shift;
      pixels = ba === 8 ? Int8Array.from(out) : out;
    } else {
      const mask = (1 << bs) - 1;
      let needs = false;
      for (let i = 0; i < pixels.length; i++) if (pixels[i] > mask) { needs = true; break; }
      if (needs) for (let i = 0; i < pixels.length; i++) pixels[i] &= mask;
    }
  }
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) { min = 0; max = 0; }
  return { kind: 'gray', pixels, min, max };
}

// ---------- color ----------

function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function toRGBA(bytes, img, { planar, ybr, ybr422, bits16 }) {
  const n = img.rows * img.cols;
  const rgba = new Uint8ClampedArray(n * 4);
  let src = bytes;
  if (bits16) {
    const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    src = new Uint8Array(u16.length);
    for (let i = 0; i < u16.length; i++) src[i] = u16[i] >> 8;
  }
  if (ybr422) {
    for (let p = 0, i = 0; p + 1 < n; p += 2, i += 4) {
      const y1 = src[i], y2 = src[i + 1], cb = src[i + 2] - 128, cr = src[i + 3] - 128;
      for (const [k, y] of [[p, y1], [p + 1, y2]]) {
        rgba[k * 4] = clamp8(y + 1.402 * cr);
        rgba[k * 4 + 1] = clamp8(y - 0.344136 * cb - 0.714136 * cr);
        rgba[k * 4 + 2] = clamp8(y + 1.772 * cb);
        rgba[k * 4 + 3] = 255;
      }
    }
    return { kind: 'rgb', rgba };
  }
  for (let p = 0; p < n; p++) {
    let r, g, b;
    if (planar) { r = src[p]; g = src[p + n]; b = src[p + 2 * n]; }
    else { r = src[p * 3]; g = src[p * 3 + 1]; b = src[p * 3 + 2]; }
    if (ybr) {
      const y = r, cb = g - 128, cr = b - 128;
      r = clamp8(y + 1.402 * cr);
      g = clamp8(y - 0.344136 * cb - 0.714136 * cr);
      b = clamp8(y + 1.772 * cb);
    }
    rgba[p * 4] = r; rgba[p * 4 + 1] = g; rgba[p * 4 + 2] = b; rgba[p * 4 + 3] = 255;
  }
  return { kind: 'rgb', rgba };
}

function paletteToRGBA(pixels, img) {
  const { r, g, b } = img.palette;
  const n = pixels.length;
  const rgba = new Uint8ClampedArray(n * 4);
  const look = (lut, v) => {
    let i = v - lut.first;
    if (i < 0) i = 0; else if (i >= lut.count) i = lut.count - 1;
    return lut.values[i] >> lut.shift;
  };
  for (let p = 0; p < n; p++) {
    const v = pixels[p];
    rgba[p * 4] = look(r, v); rgba[p * 4 + 1] = look(g, v); rgba[p * 4 + 2] = look(b, v); rgba[p * 4 + 3] = 255;
  }
  return { kind: 'rgb', rgba };
}

// ---------- main entry ----------

export async function decodeImage(ds, img) {
  const el = ds.elements.x7fe00010 || ds.elements.x7fe00008 || ds.elements.x7fe00009;
  if (!el) throw new Error('Piksel verisi yok');
  const ts = img.tsuid;
  const isColor = img.samplesPerPixel === 3;
  const pal = img.photometric === 'PALETTE COLOR' && img.palette;

  // Float / double pixel data.
  if (el.tag === 'x7fe00008' || el.tag === 'x7fe00009') {
    const bytes = ds.byteArray.slice(el.dataOffset, el.dataOffset + el.length);
    const n = img.rows * img.cols;
    const arr = el.tag === 'x7fe00008' ? new Float32Array(bytes.buffer) : new Float64Array(bytes.buffer);
    return finishGray(Float32Array.from(arr.subarray(img.frame * n, img.frame * n + n)), img, false);
  }

  if (!el.encapsulatedPixelData) {
    if (img.bitsAllocated === 1) throw new Error('1-bit görüntü desteklenmiyor');
    const bytes = nativeFrame(ds, el, img);
    if (isColor) {
      return toRGBA(bytes, img, {
        planar: img.planarConfiguration === 1,
        ybr: img.photometric === 'YBR_FULL',
        ybr422: img.photometric === 'YBR_FULL_422',
        bits16: img.bitsAllocated === 16,
      });
    }
    const typed = typedFromBytes(bytes, img);
    if (pal) return paletteToRGBA(typed, img);
    return finishGray(typed, img, true);
  }

  const data = encapsulatedFrame(ds, el, img);

  if (ts === TS.RLE) {
    const bytes = decodeRLE(data, img);
    if (isColor) {
      return toRGBA(bytes, img, { planar: false, ybr: img.photometric === 'YBR_FULL', bits16: img.bitsAllocated === 16 });
    }
    const typed = typedFromBytes(bytes, img);
    if (pal) return paletteToRGBA(typed, img);
    return finishGray(typed, img, true);
  }

  if (ts === TS.JPEG_BASELINE || ts === TS.JPEG_EXTENDED) {
    const JpegImage = await jpegBaseline();
    const jpeg = new JpegImage();
    try { jpeg.parse(data); } catch (e) { throw new Error(`JPEG çözülemedi: ${e.message || e}`); }
    if (isColor && !jpeg.adobe) jpeg.colorTransform = jpegNeedsYCbCr(data, img.photometric);
    else if (jpeg.adobe && !jpeg.adobe.transformCode) jpeg.colorTransform = false;
    if (isColor) {
      const rgb = jpeg.getData(img.cols, img.rows);
      return toRGBA(rgb, img, { planar: false, ybr: false });
    }
    if (img.bitsAllocated === 8 || !jpeg.components[0] || jpeg.components.length !== 1) {
      const g = jpeg.getData(img.cols, img.rows);
      return pal ? paletteToRGBA(g, img) : finishGray(img.pixelRepresentation ? new Int8Array(g.buffer) : g, img, true);
    }
    const g16 = jpeg.getData16(img.cols, img.rows);
    return finishGray(img.pixelRepresentation ? new Int16Array(g16.buffer) : g16, img, true);
  }

  if (ts === TS.JPEG_LOSSLESS || ts === TS.JPEG_LOSSLESS_SV1) {
    const Decoder = await jpegLossless();
    const dec = new Decoder();
    const bytesPer = img.bitsAllocated <= 8 ? 1 : 2;
    const out = dec.decode(data.buffer, data.byteOffset, data.length, bytesPer);
    const bytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    if (isColor) return toRGBA(bytes, img, { planar: false, ybr: false, bits16: bytesPer === 2 });
    const typed = typedFromBytes(bytes, img, bytesPer * 8);
    return pal ? paletteToRGBA(typed, img) : finishGray(typed, img, true);
  }

  let decoder;
  if (ts === TS.JPEG_LS || ts === TS.JPEG_LS_NEAR) {
    decoder = await wasmCodec('charls', 'charlswasm_decode.js', 'CharLSWASM', 'JpegLSDecoder');
  } else if ([TS.J2K, TS.J2K_LOSSLESS, TS.HTJ2K, TS.HTJ2K_LOSSLESS, TS.HTJ2K_RPCL].includes(ts)) {
    decoder = await wasmCodec('openjpeg', 'openjpegwasm_decode.js', 'OpenJPEGWASM', 'J2KDecoder');
  } else if (ts === TS.DEFLATE) {
    throw new Error('Deflate sıkıştırma desteklenmiyor');
  } else {
    throw new Error(`Desteklenmeyen sıkıştırma: ${ts}`);
  }
  decoder.getEncodedBuffer(data.length).set(data);
  decoder.decode();
  const info = decoder.getFrameInfo();
  const decoded = decoder.getDecodedBuffer();
  const bytes = new Uint8Array(decoded.length);
  bytes.set(decoded);
  if (isColor || info.componentCount === 3) {
    const interleave = typeof decoder.getInterleaveMode === 'function' ? decoder.getInterleaveMode() : 2;
    return toRGBA(bytes, img, {
      planar: interleave === 0 && info.componentCount === 3 && ts.startsWith('1.2.840.10008.1.2.4.8'),
      ybr: false,
      bits16: info.bitsPerSample > 8,
    });
  }
  const typed = typedFromBytes(bytes, img, info.bitsPerSample > 8 ? 16 : 8);
  return pal ? paletteToRGBA(typed, img) : finishGray(typed, img, true);
}
