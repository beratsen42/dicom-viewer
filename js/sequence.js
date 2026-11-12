// Series labels: MR sequence type, contrast, plane, CT kernel, X-ray view.
// Keyword matches are trusted. Guesses from scan parameters get a "?".

const has = (re, s) => re.test(s);

function plane(img) {
  if (!img.iop) return null;
  const r = img.iop.slice(0, 3), c = img.iop.slice(3, 6);
  const n = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]].map(Math.abs);
  const i = n.indexOf(Math.max(...n));
  return ['Sagital', 'Koronal', 'Aksiyel'][i];
}

function maxB(images) {
  let b = -1;
  for (const i of images) if (Number.isFinite(i.bValue) && i.bValue > b) b = i.bValue;
  return b;
}

function mrSequence(img, images, text) {
  const type = (img.imageType || '').toUpperCase();
  const b = maxB(images);
  if (type.includes('LOCALIZER') || has(/locali[sz]er|scout|survey|tri.?pilot|aahead|\b3.?pl(ane)?\b|\bloc\b/, text)) return ['Lokalizer', false];
  if (type.includes('ADC') || has(/\badc\b|apparent/, text)) return ['ADC', false];
  if (type.includes('EADC') || has(/\bexp\b|eadc/, text)) return ['eADC', false];
  if (type.includes('DIFFUSION') || type.includes('TRACEW') || has(/dwi|diff|trace|\bdw\b|resolve/, text) || b > 0) {
    return [b > 0 ? `DWI b${Math.round(b)}` : 'DWI', false];
  }
  if (has(/\bswi\b|swan|venobold|\bsws\b|susc/, text)) return ['SWI', false];
  if (has(/perf|\bdsc\b|\bpwi\b|\bdce\b|asl\b|pcasl/, text)) return ['Perfüzyon', false];
  if (has(/\btof\b|\bmra\b|angio|anjio|\bpc.?mra/, text)) return ['TOF/MRA', false];
  const t1 = has(/t1|mp-?rage|bravo|spgr|vibe|\btfe\b|flash|lava|thrive/, text);
  if (has(/flair|dark.?fluid/, text)) return [t1 ? 'T1 FLAIR' : 'FLAIR', false];
  if (has(/tirm/, text)) return [img.ti > 1200 ? 'FLAIR' : 'STIR', false];
  if (has(/stir/, text)) return ['STIR', false];
  if (has(/t2\*|t2.?star|hemo|\bgre\b.*t2|t2.*\bgre\b|\bmedic\b|\bmerge\b|ffe.*t2/, text)) return ['T2*', false];
  if (has(/\bpd\b|proton|pdw/, text)) return ['PD', false];
  if (t1) return ['T1', false];
  if (has(/t2/, text)) return ['T2', false];

  // Guess from scan parameters.
  const { tr, te, ti } = img;
  const gre = (img.scanningSequence || '').includes('GR');
  if (ti > 0) {
    if (ti >= 1400) return ['FLAIR', true];
    if (ti <= 300) return ['STIR', true];
    return ['T1', true];
  }
  if (!(tr > 0) || !(te >= 0)) return null;
  if (gre) return te >= 15 ? ['T2*', true] : ['T1', true];
  if (tr < 1000 && te < 30) return ['T1', true];
  if (tr >= 2000 && te >= 70) return ['T2', true];
  if (tr >= 1500 && te < 40) return ['PD', true];
  return null;
}

function contrast(img, text) {
  const agent = (img.contrastAgent || '').trim().toUpperCase();
  if (agent && !/^(NONE|NO|N|0|-|YOK)$/.test(agent)) return true;
  if (has(/\bpre\b|non.?contrast|kontrastsiz|kontrastsız|\bnc\b/, text)) return false;
  return has(/\+ ?c\b|\bc ?\+|\bpost\b|post.?(gd|gad|c\b|kontrast|contrast)|gad|\bgd\b|kontrastl|contrast|arter|ven[öo]z|venous|portal|\bce\b/, text);
}

function ctKernel(img, text) {
  if (has(/bone|kemik|osseous/, text)) return ['Kemik', false];
  if (has(/lung|akci[gğ]er|parenkim|pulmo/, text)) return ['Akciğer', false];
  const k = (img.kernel || '').toLowerCase();
  if (!k) return null;
  if (has(/bone|sharp|edge|detail|lung|ultra/, k)) return [/lung/.test(k) ? 'Akciğer' : 'Kemik', false];
  if (has(/soft|standard|smooth|brain|std/, k)) return ['Yumuşak doku', false];
  // Vendor codes (Siemens B/H/Br/Hr/Qr, Canon FC): higher number = sharper.
  const m = k.match(/^(?:[bhjiqtdr]{1,2}|fc)(\d{2})/);
  if (m) return [Number(m[1]) >= 60 ? 'Kemik' : 'Yumuşak doku', true];
  return null;
}

// Returns [{ text, kind: 'seq'|'contrast'|'plane'|'info', guess }]
export function seriesTags(series) {
  const img = series.images[0];
  const text = [img.seriesDescription, img.protocolName, img.sequenceName].filter(Boolean).join(' ').toLowerCase().replace(/_/g, ' ');
  const tags = [];
  const add = (t, kind, guess = false) => t && tags.push({ text: t, kind, guess });

  if (img.modality === 'MR') {
    const seq = mrSequence(img, series.images, text);
    if (seq) add(seq[0], 'seq', seq[1]);
    if (contrast(img, text)) add('+K', 'contrast');
    add(plane(img), 'plane');
  } else if (img.modality === 'CT') {
    const k = ctKernel(img, text);
    if (k) add(k[0], 'seq', k[1]);
    if (contrast(img, text)) add('+K', 'contrast');
    add(plane(img), 'plane');
    if (img.sliceThickness) add(`${+img.sliceThickness.toFixed(2)} mm`, 'info');
  } else if (['CR', 'DX', 'DR', 'RF', 'MG'].includes(img.modality)) {
    add(img.viewPosition, 'seq');
    add(img.bodyPart, 'info');
  }
  return tags;
}

export function tagText(tags) {
  return tags.map((t) => t.text + (t.guess ? '?' : '')).join(' · ');
}
