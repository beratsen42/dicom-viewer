// DICOM parsing, metadata extraction and series grouping.
import { seriesTags } from './sequence.js';
// Uses the global `dicomParser` (vendor/dicomParser.min.js).

const TS_IMPLICIT_LE = '1.2.840.10008.1.2';

// ---------- text decoding (handles Turkish / UTF-8 names) ----------

const CHARSET_MAP = {
  'ISO_IR 192': 'utf-8',
  'ISO_IR 148': 'windows-1254', // Latin-5 (Turkish)
  'ISO 2022 IR 148': 'windows-1254',
  'ISO_IR 100': 'windows-1252',
  'ISO 2022 IR 100': 'windows-1252',
  'ISO_IR 101': 'iso-8859-2',
  'ISO_IR 144': 'iso-8859-5',
  'ISO_IR 127': 'iso-8859-6',
  'ISO_IR 126': 'iso-8859-7',
  'ISO_IR 138': 'iso-8859-8',
  'GB18030': 'gb18030',
  'GBK': 'gbk',
  'ISO_IR 13': 'shift_jis',
};

const decoders = {};
function textDecoder(label) {
  if (!decoders[label]) {
    try { decoders[label] = new TextDecoder(label); } catch { decoders[label] = new TextDecoder('windows-1252'); }
  }
  return decoders[label];
}

function charsetOf(ds, parent) {
  const raw = ds.string('x00080005') || (parent && parent.charset) || '';
  const parts = raw.split('\\').map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  return CHARSET_MAP[last] || (last ? 'utf-8' : 'windows-1252');
}

export function text(ds, tag, charset = 'windows-1252') {
  const el = ds.elements[tag];
  if (!el || !el.length) return '';
  const bytes = new Uint8Array(ds.byteArray.buffer, ds.byteArray.byteOffset + el.dataOffset, el.length);
  let s = textDecoder(charset).decode(bytes);
  return s.replace(/\0/g, '').trim();
}

// ---------- small tag helpers ----------

function num(ds, tag, index = 0) {
  if (!ds || !ds.elements[tag]) return undefined;
  const v = ds.floatString(tag, index);
  return Number.isFinite(v) ? v : undefined;
}

function nums(ds, tag, count) {
  if (!ds || !ds.elements[tag]) return undefined;
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = ds.floatString(tag, i);
    if (!Number.isFinite(v)) return undefined;
    out.push(v);
  }
  return out;
}

function us(ds, tag) {
  const el = ds.elements[tag];
  if (!el || !el.length) return undefined;
  return ds.uint16(tag);
}

function intStr(ds, tag) {
  const v = ds.intString(tag);
  return Number.isFinite(v) ? v : undefined;
}

function seqItem(ds, tag, i = 0) {
  const el = ds && ds.elements[tag];
  if (!el || !el.items || !el.items[i]) return undefined;
  return el.items[i].dataSet;
}

// Look up a functional group macro for a frame of an enhanced multi-frame object.
function frameGroup(ds, frame, groupTag) {
  const perFrame = seqItem(ds, 'x52009230', frame);
  const fromPerFrame = perFrame && seqItem(perFrame, groupTag);
  if (fromPerFrame) return fromPerFrame;
  const shared = seqItem(ds, 'x52009229');
  return shared && seqItem(shared, groupTag);
}

// ---------- parsing ----------

export function parseBuffer(arrayBuffer) {
  const byteArray = new Uint8Array(arrayBuffer);
  try {
    return dicomParser.parseDicom(byteArray);
  } catch (e) {
    // Files without the 128-byte preamble / DICM prefix.
    if (byteArray.length > 8 && byteArray[0] === 0x08 && byteArray[1] === 0x00) {
      return dicomParser.parseDicom(byteArray, { TransferSyntaxUID: TS_IMPLICIT_LE });
    }
    throw e;
  }
}

export function looksLikeDicom(arrayBuffer) {
  const b = new Uint8Array(arrayBuffer, 0, Math.min(132, arrayBuffer.byteLength));
  if (b.length >= 132 && b[128] === 0x44 && b[129] === 0x49 && b[130] === 0x43 && b[131] === 0x4d) return true;
  return b.length > 8 && b[0] === 0x08 && b[1] === 0x00;
}

function formatName(pn) {
  if (!pn) return '';
  const first = pn.split('=')[0];
  return first.split('^').filter(Boolean).join(' ').trim();
}

function formatDate(d) {
  if (!d || d.length < 8) return d || '';
  return `${d.slice(6, 8)}.${d.slice(4, 6)}.${d.slice(0, 4)}`;
}

function formatTime(t) {
  if (!t || t.length < 4) return t || '';
  return `${t.slice(0, 2)}:${t.slice(2, 4)}`;
}

// Build one "image" entry per frame from a parsed dataset.
export function extractImages(ds, source) {
  const pixelEl = ds.elements.x7fe00010 || ds.elements.x7fe00008 || ds.elements.x7fe00009;
  if (!pixelEl) return [];
  const rows = us(ds, 'x00280010');
  const cols = us(ds, 'x00280011');
  if (!rows || !cols) return [];

  const charset = charsetOf(ds);
  const tsuid = ds.string('x00020010') || TS_IMPLICIT_LE;
  const frames = Math.max(1, intStr(ds, 'x00280008') || 1);
  const modality = (ds.string('x00080060') || '').toUpperCase();

  const common = {
    source,
    tsuid: tsuid.replace(/\0/g, '').trim(),
    rows,
    cols,
    numFrames: frames,
    bitsAllocated: us(ds, 'x00280100') || 16,
    bitsStored: us(ds, 'x00280101') || us(ds, 'x00280100') || 16,
    highBit: us(ds, 'x00280102'),
    pixelRepresentation: us(ds, 'x00280103') || 0,
    samplesPerPixel: us(ds, 'x00280002') || 1,
    planarConfiguration: us(ds, 'x00280006') || 0,
    photometric: (ds.string('x00280004') || 'MONOCHROME2').trim().toUpperCase(),
    modality,
    sopInstanceUID: ds.string('x00080018') || '',
    seriesUID: ds.string('x0020000e') || 'unknown-series',
    studyUID: ds.string('x0020000d') || '',
    frameOfReferenceUID: ds.string('x00200052') || '',
    seriesNumber: intStr(ds, 'x00200011'),
    instanceNumber: intStr(ds, 'x00200013'),
    seriesDescription: text(ds, 'x0008103e', charset),
    studyDescription: text(ds, 'x00081030', charset),
    bodyPart: text(ds, 'x00180015', charset),
    patientName: formatName(text(ds, 'x00100010', charset)),
    patientId: text(ds, 'x00100020', charset),
    patientSex: ds.string('x00100040') || '',
    patientAge: (ds.string('x00101010') || '').replace(/^0+/, ''),
    patientBirthDate: formatDate(ds.string('x00100030')),
    studyDate: formatDate(ds.string('x00080020') || ds.string('x00080021')),
    studyTime: formatTime(ds.string('x00080030') || ds.string('x00080031')),
    institution: text(ds, 'x00080080', charset),
    sliceThickness: num(ds, 'x00180050'),
    kvp: num(ds, 'x00180060'),
    pixelSpacing: nums(ds, 'x00280030', 2),
    imagerPixelSpacing: nums(ds, 'x00181164', 2),
    iop: nums(ds, 'x00200037', 6),
    ipp: nums(ds, 'x00200032', 3),
    sliceLocation: num(ds, 'x00201041'),
    slope: num(ds, 'x00281053'),
    intercept: num(ds, 'x00281052'),
    windowCenter: num(ds, 'x00281050'),
    windowWidth: num(ds, 'x00281051'),
    smallestPixel: undefined,
    imageType: ds.string('x00080008') || '',
    rescaleType: ds.string('x00281054') || '',
    protocolName: text(ds, 'x00181030', charset),
    sequenceName: ds.string('x00180024') || '',
    scanningSequence: ds.string('x00180020') || '',
    tr: num(ds, 'x00180080'),
    te: num(ds, 'x00180081'),
    ti: num(ds, 'x00180082'),
    contrastAgent: text(ds, 'x00180010', charset),
    kernel: (ds.string('x00181210') || '').split('\\')[0],
    viewPosition: ds.string('x00185101') || '',
    bValue: bValueOf(ds),
  };

  // Palette color lookup tables.
  if (common.photometric === 'PALETTE COLOR') {
    common.palette = readPalette(ds);
  }

  const out = [];
  const isEnhanced = !!ds.elements.x52009230 || !!ds.elements.x52009229;
  for (let f = 0; f < frames; f++) {
    const img = { ...common, frame: f };
    if (isEnhanced) {
      const pos = frameGroup(ds, f, 'x00209113');
      const ori = frameGroup(ds, f, 'x00209116');
      const meas = frameGroup(ds, f, 'x00289110');
      const pvt = frameGroup(ds, f, 'x00289145');
      const voi = frameGroup(ds, f, 'x00289132');
      if (pos) img.ipp = nums(pos, 'x00200032', 3) || img.ipp;
      if (ori) img.iop = nums(ori, 'x00200037', 6) || img.iop;
      if (meas) {
        img.pixelSpacing = nums(meas, 'x00280030', 2) || img.pixelSpacing;
        img.sliceThickness = num(meas, 'x00180050') ?? img.sliceThickness;
      }
      if (pvt) {
        img.slope = num(pvt, 'x00281053') ?? img.slope;
        img.intercept = num(pvt, 'x00281052') ?? img.intercept;
      }
      if (voi) {
        img.windowCenter = num(voi, 'x00281050') ?? img.windowCenter;
        img.windowWidth = num(voi, 'x00281051') ?? img.windowWidth;
      }
    }
    img.key = `${img.sopInstanceUID || source.name}#${f}`;
    out.push(img);
  }
  return out;
}

// Diffusion b-value: standard tag, then common vendor private tags.
function bValueOf(ds) {
  try {
    if (ds.elements.x00189087 && ds.elements.x00189087.length === 8) return ds.double('x00189087');
    const ge = ds.elements.x00431039 && ds.intString('x00431039');
    if (Number.isFinite(ge)) return ge >= 1e9 ? ge % 1e9 : ge;
    if (ds.elements.x20011003 && ds.elements.x20011003.length === 4) return ds.float('x20011003');
    const sv = ds.elements.x0019100c && ds.intString('x0019100c');
    if (Number.isFinite(sv)) return sv;
    const m = (ds.string('x00180024') || '').match(/b(\d{2,4})/);
    if (m) return Number(m[1]);
  } catch { /* ignore malformed private tags */ }
  return undefined;
}

function readPalette(ds) {
  const read = (descTag, dataTag) => {
    const desc = ds.elements[descTag];
    const data = ds.elements[dataTag];
    if (!desc || !data) return null;
    let count = ds.uint16(descTag, 0);
    if (count === 0) count = 65536;
    const first = ds.uint16(descTag, 1);
    const bits = ds.uint16(descTag, 2);
    const values = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = bits === 8 && data.length === count ? ds.byteArray[data.dataOffset + i] : ds.uint16(dataTag, i);
    }
    const shift = bits === 8 ? 0 : 8;
    return { first, count, values, shift };
  };
  const r = read('x00281101', 'x00281201');
  const g = read('x00281102', 'x00281202');
  const b = read('x00281103', 'x00281203');
  return r && g && b ? { r, g, b } : null;
}

// ---------- geometry ----------

export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function normalOf(img) {
  if (!img.iop) return null;
  return cross(img.iop.slice(0, 3), img.iop.slice(3, 6));
}

// Pixel spacing in mm: [rowSpacing (vertical), colSpacing (horizontal)].
export function spacingOf(img) {
  if (img.pixelSpacing) return { row: img.pixelSpacing[0], col: img.pixelSpacing[1], source: 'patient' };
  if (img.imagerPixelSpacing) return { row: img.imagerPixelSpacing[0], col: img.imagerPixelSpacing[1], source: 'detector' };
  return null;
}

// ---------- series grouping ----------

export function buildSeries(images) {
  const map = new Map();
  for (const img of images) {
    // Split by series and by image size / orientation to keep stacks consistent.
    const key = `${img.seriesUID}|${img.rows}x${img.cols}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(img);
  }
  const series = [];
  for (const [key, list] of map) {
    // De-duplicate (same file loaded twice).
    const seen = new Set();
    const uniq = list.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
    sortStack(uniq);
    const first = uniq[0];
    series.push({
      id: key,
      images: uniq,
      seriesUID: first.seriesUID,
      studyUID: first.studyUID,
      modality: first.modality,
      description: first.seriesDescription || first.bodyPart || first.studyDescription || 'Seri',
      seriesNumber: first.seriesNumber,
      studyDate: first.studyDate,
      patientName: first.patientName,
    });
    series[series.length - 1].tags = seriesTags(series[series.length - 1]);
  }
  series.sort((a, b) =>
    (a.studyDate || '').localeCompare(b.studyDate || '') ||
    (a.studyUID || '').localeCompare(b.studyUID || '') ||
    (a.seriesNumber ?? 1e9) - (b.seriesNumber ?? 1e9) ||
    a.description.localeCompare(b.description));
  return series;
}

function sortStack(list) {
  const n0 = normalOf(list[0]);
  const allPos = n0 && list.every((i) => i.ipp && i.iop);
  if (allPos) {
    for (const i of list) i.z = dot(i.ipp, n0);
    const distinct = new Set(list.map((i) => i.z.toFixed(3))).size;
    if (distinct > 1) {
      // Axial: superior (head) first, like most PACS. Others: along the normal.
      const axial = Math.abs(n0[2]) > 0.8;
      const key = axial ? (i) => -i.ipp[2] : (i) => i.z;
      list.sort((a, b) => key(a) - key(b) || (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0) || a.frame - b.frame);
      return;
    }
  }
  list.sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0) || a.frame - b.frame);
}
