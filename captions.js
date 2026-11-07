import { ensureFonts } from './fonts.js';

const MAX_FRAMES = 120;
const FRAME_WIDTH = 960;
const MAX_FIXED_SECONDS = 12;   // 이보다 오래 그대로 있는 글자는 자막이 아니라 화면 UI로 본다
const MIN_SCORE = 60;           // tesseract 신뢰도 (0~100)
const COMPARE_HEIGHT = 32;      // 브라우저에서는 계산이 느려서 원래(64)보다 작게 비교한다
const MAX_COMPARED = 8;
const HANGUL = /[가-힣]/;

// ===================== 공통 유틸 =====================

/** 두 글자열이 얼마나 비슷한지 0~1로 돌려준다. (파이썬 SequenceMatcher.ratio 대신) */
export function ratio(a, b) {
  if (!a.length && !b.length) return 1;
  let prev = new Array(b.length + 1).fill(0);
  for (const ca of a) {
    const cur = [0];
    for (let j = 0; j < b.length; j++) cur.push(ca === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j]));
    prev = cur;
  }
  return (2 * prev[b.length]) / (a.length + b.length);
}

function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

const breathe = () => new Promise(resolve => setTimeout(resolve, 0));

// ===================== 프레임에서 글자 읽기 =====================

let scheduler = null;

async function getOcr(onProgress) {
  if (!scheduler) {
    onProgress('글자 인식 준비 중 (처음 한 번만 오래 걸려요)');
    const next = Tesseract.createScheduler();
    const workers = await Promise.all([0, 1].map(() => Tesseract.createWorker(['kor', 'eng'])));
    workers.forEach(worker => next.addWorker(worker));
    scheduler = next;
  }
  return scheduler;
}

function seekTo(video, time) {
  return new Promise(resolve => {
    video.addEventListener('seeked', resolve, { once: true });
    video.currentTime = time;
  });
}

async function sampleFrames(video, duration, onProgress) {
  const interval = Math.max(1, duration / MAX_FRAMES);
  const scale = Math.min(1, FRAME_WIDTH / video.videoWidth);
  const canvas = canvasOf(Math.round(video.videoWidth * scale), Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d');
  const count = Math.ceil(duration / interval);
  const frames = [];
  for (let i = 0; i < count; i++) {
    onProgress(`화면 뽑는 중 ${i + 1} / ${count}`);
    await seekTo(video, Math.min(i * interval + 0.05, duration - 0.05));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92)));
  }
  return { interval, frames, width: canvas.width, height: canvas.height };
}

function looksLikeCaption(item, width, height) {
  // 가운데 정렬이고 글자가 어느 정도 크면 자막 후보로 본다
  if (!/[가-힣ㄱ-ㅎㅏ-ㅣ]|[A-Za-z]{3,}/.test(item.text)) return false;
  return Math.abs(item.cx - width / 2) <= width * 0.2 && item.h >= height * 0.025;
}

async function readFrame(ocr, blob) {
  const { data } = await ocr.addJob('recognize', blob);
  return (data.lines || [])
    .filter(line => line.confidence >= MIN_SCORE && line.text.trim())
    .map(line => {
      const { x0, y0, x1, y1 } = line.bbox;
      return {
        text: line.text.trim(), score: line.confidence, box: [x0, y0, x1, y1],
        cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, h: y1 - y0,
      };
    });
}

async function groupCaptions(sampled, onProgress) {
  const { frames, interval, width, height } = sampled;
  const ocr = await getOcr(onProgress);
  let done = 0;
  // 글자 인식 일꾼 두 명이 프레임을 나눠 읽는다
  const read = await Promise.all(frames.map(blob => readFrame(ocr, blob).then(items => {
    onProgress(`화면 글자 읽는 중 ${++done} / ${frames.length}`);
    return items;
  })));

  // 프레임마다 읽은 글자 중 같은 자막을 하나로 묶는다
  const groups = [];
  read.forEach((items, index) => {
    const time = index * interval;
    for (const item of items) {
      if (!looksLikeCaption(item, width, height)) continue;
      let match = null;
      for (let g = groups.length - 1; g >= 0; g--) {
        const group = groups[g];
        if (time - group.end > interval * 2.5) break;
        const near = Math.abs(group.cy - item.cy) < height * 0.08;
        if (near && ratio(group.text, item.text) >= 0.5) {
          match = group;
          break;
        }
      }
      if (!match) {
        groups.push({ ...item, start: time, end: time, frame: index });
        continue;
      }
      match.end = time;
      if (item.score > match.score) Object.assign(match, item, { frame: index });
    }
  });

  const captions = dropScreenText(groups.filter(g => g.end - g.start <= MAX_FIXED_SECONDS));
  captions.forEach(group => { group.end += interval; });
  return captions;
}

function dropScreenText(groups) {
  // 게임 UI처럼 같은 글자가 여러 번 되풀이되는 것과, 한글 자막 사이의 영어 UI를 뺀다
  const kept = groups.filter(group => {
    const same = groups.filter(g => ratio(g.text, group.text) >= 0.6);
    return !(same.length >= 4 || same.reduce((sum, g) => sum + g.end - g.start, 0) > 15);
  });
  const korean = kept.filter(g => HANGUL.test(g.text));
  return korean.length >= 3 ? korean : kept;
}

// ===================== 글자 모양 비교 =====================
// 마스크는 { w, h, data } 이고 글자 부분이 255에 가깝다.

function tight(mask) {
  let x0 = mask.w, y0 = mask.h, x1 = -1, y1 = -1;
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (mask.data[y * mask.w + x] > 127) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return cropMask(mask, x0, y0, x1 + 1, y1 + 1);
}

function cropMask(mask, x0, y0, x1, y1) {
  const w = x1 - x0;
  const h = y1 - y0;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    data.set(mask.data.subarray((y0 + y) * mask.w + x0, (y0 + y) * mask.w + x1), y * w);
  }
  return { w, h, data };
}

function otsu(gray) {
  const hist = new Array(256).fill(0);
  gray.forEach(v => hist[v]++);
  const total = gray.length;
  let sum = 0;
  hist.forEach((count, i) => { sum += i * count; });
  let sumB = 0, weightB = 0, best = 0, threshold = 0;
  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += t * hist[t];
    const between = weightB * weightF * (sumB / weightB - (sum - sumB) / weightF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

function captionMask(crop) {
  // 자막 조각에서 글자 부분만 흰색으로 남긴다
  const { width: w, height: h } = crop;
  const pixels = crop.getContext('2d').getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]);
  }
  const threshold = otsu(gray);
  const data = new Float32Array(w * h);
  gray.forEach((v, i) => { data[i] = v > threshold ? 255 : 0; });
  let border = 0;
  for (let x = 0; x < w; x++) border += data[x] + data[(h - 1) * w + x];
  for (let y = 0; y < h; y++) border += data[y * w] + data[y * w + w - 1];
  if (border / (2 * (w + h)) > 127) data.forEach((v, i) => { data[i] = 255 - v; });
  return tight({ w, h, data });
}

function resize(mask, w, h) {
  // 칸마다 원본 픽셀을 평균 낸다 (cv2 INTER_AREA 대신)
  const data = new Float32Array(w * h);
  const sx = mask.w / w;
  const sy = mask.h / h;
  for (let y = 0; y < h; y++) {
    const ya = Math.floor(y * sy);
    const yb = Math.min(mask.h, Math.max(ya + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const xa = Math.floor(x * sx);
      const xb = Math.min(mask.w, Math.max(xa + 1, Math.floor((x + 1) * sx)));
      let total = 0;
      for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) total += mask.data[yy * mask.w + xx];
      data[y * w + x] = total / ((yb - ya) * (xb - xa));
    }
  }
  return { w, h, data };
}

function blur(mask) {
  // 3x3 가우시안 블러
  const { w, h } = mask;
  const at = (src, x, y) => src[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const across = new Float32Array(w * h);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      across[y * w + x] = (at(mask.data, x - 1, y) + 2 * at(mask.data, x, y) + at(mask.data, x + 1, y)) / 4;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      data[y * w + x] = (at(across, x, y - 1) + 2 * at(across, x, y) + at(across, x, y + 1)) / 4;
    }
  }
  return { w, h, data };
}

function padRows(mask, pad) {
  const data = new Float32Array(mask.w * (mask.h + pad * 2));
  data.set(mask.data, pad * mask.w);
  return { w: mask.w, h: mask.h + pad * 2, data };
}

function scaleHeight(mask) {
  return resize(mask, Math.max(1, Math.round(mask.w * COMPARE_HEIGHT / mask.h)), COMPARE_HEIGHT);
}

function integral(mask) {
  const stride = mask.w + 1;
  const sum = new Float64Array(stride * (mask.h + 1));
  const sq = new Float64Array(stride * (mask.h + 1));
  for (let y = 0; y < mask.h; y++) {
    let rowSum = 0, rowSq = 0;
    for (let x = 0; x < mask.w; x++) {
      const v = mask.data[y * mask.w + x];
      rowSum += v;
      rowSq += v * v;
      sum[(y + 1) * stride + x + 1] = sum[y * stride + x + 1] + rowSum;
      sq[(y + 1) * stride + x + 1] = sq[y * stride + x + 1] + rowSq;
    }
  }
  const rect = (table, x, y, w, h) =>
    table[(y + h) * stride + x + w] - table[y * stride + x + w] - table[(y + h) * stride + x] + table[y * stride + x];
  return { sum: (x, y, w, h) => rect(sum, x, y, w, h), sq: (x, y, w, h) => rect(sq, x, y, w, h) };
}

function bestMatch(target, sums, template, lo, hi) {
  // cv2.matchTemplate(TM_CCOEFF_NORMED)의 가장 큰 값을 lo~hi 가로 범위에서만 찾는다
  const { w: tw, h: th } = template;
  const n = tw * th;
  let mean = 0;
  template.data.forEach(v => { mean += v; });
  mean /= n;
  const centered = template.data.map(v => v - mean);
  let norm = 0;
  centered.forEach(v => { norm += v * v; });
  let best = -1;
  for (let y = 0; y + th <= target.h; y++) {
    for (let x = lo; x + tw <= hi; x++) {
      let cross = 0;
      for (let ty = 0; ty < th; ty++) {
        const row = (y + ty) * target.w + x;
        const trow = ty * tw;
        for (let tx = 0; tx < tw; tx++) cross += centered[trow + tx] * target.data[row + tx];
      }
      const total = sums.sum(x, y, tw, th);
      const spread = sums.sq(x, y, tw, th) - (total * total) / n;
      if (spread <= 1e-6) continue;
      best = Math.max(best, cross / Math.sqrt(norm * spread));
    }
  }
  return best;
}

function layout(text, ctx, size) {
  // 글자마다 가로 위치를 정한다. 공백 글자가 없는 폰트가 있어서 띄어쓰기는 직접 띄운다
  let x = 0;
  const placed = [];
  for (const char of text) {
    if (/\s/.test(char)) {
      x += size * 0.3;
      continue;
    }
    placed.push([char, x]);
    x += ctx.measureText(char).width;
  }
  return { placed, width: x };
}

function glyphsOf(text, family, size = 96) {
  // 글자를 하나씩 그리고, 줄 안에서의 가로 위치와 줄 전체 크기를 돌려준다
  const canvas = canvasOf(size * 2, size * 2);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.font = `${size}px "${family}"`;
  ctx.textBaseline = 'top';
  const { placed, width: lineW } = layout(text, ctx, size);
  const cells = [];
  for (const [char, x] of placed) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.fillText(char, size / 2, size / 3);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const data = new Float32Array(canvas.width * canvas.height);
    let max = 0;
    for (let i = 0; i < data.length; i++) {
      data[i] = rgba[i * 4];
      if (data[i] > max) max = data[i];
    }
    if (max > 127) cells.push({ x, mask: { w: canvas.width, h: canvas.height, data } });
  }
  if (!cells.length) return { glyphs: [], lineW: 0, lineH: 0 };

  let top = canvas.height, bottom = 0;
  for (const { mask } of cells) {
    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) {
        if (mask.data[y * mask.w + x] > 127) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y + 1);
          break;
        }
      }
    }
  }
  const glyphs = cells.map(({ x, mask }) => {
    let x0 = mask.w, x1 = 0;
    for (let y = top; y < bottom; y++) {
      for (let xx = 0; xx < mask.w; xx++) {
        if (mask.data[y * mask.w + xx] > 127) {
          x0 = Math.min(x0, xx);
          x1 = Math.max(x1, xx + 1);
        }
      }
    }
    return { x: x + x0 - size / 2, mask: cropMask(mask, x0, top, x1, bottom) };
  });
  return { glyphs, lineW, lineH: bottom - top };
}

function similarity(real, text, family) {
  // 글자마다 원본에서 제자리를 찾아 겹쳐 보고, 잘 맞는 글자들의 평균을 낸다
  const { glyphs, lineW, lineH } = glyphsOf(text, family);
  if (!glyphs.length || lineW <= 0 || lineH <= 0) return 0;
  const target = blur(padRows(real, 3));
  const sums = integral(target);
  const base = real.h / lineH;
  const stretch = real.w / (lineW * base);
  const scores = [];
  for (const { x, mask } of glyphs) {
    let best = -1;
    for (const factor of [0.92, 1, 1.08]) {
      const scale = base * factor;
      const width = Math.max(1, Math.round(mask.w * scale));
      const height = Math.max(1, Math.round(mask.h * scale));
      if (width < 4 || height + 2 > target.h || width >= target.w) continue;
      const template = blur(resize(mask, width, height));
      let mean = 0, spread = 0;
      template.data.forEach(v => { mean += v; });
      mean /= template.data.length;
      template.data.forEach(v => { spread += (v - mean) ** 2; });
      if (Math.sqrt(spread / template.data.length) < 1) continue;
      const center = x * base * stretch;
      const margin = Math.max(5, Math.floor(width * 0.6));
      const lo = Math.max(0, Math.floor(center) - margin);
      const hi = Math.min(target.w, Math.floor(center) + width + margin);
      if (hi - lo < width) continue;
      best = Math.max(best, bestMatch(target, sums, template, lo, hi));
    }
    if (best > -1) scores.push(best);
  }
  if (!scores.length) return 0;
  // OCR이 틀린 글자가 끼어도 흔들리지 않도록 잘 맞은 글자만 평균 낸다
  scores.sort((a, b) => b - a);
  const kept = scores.slice(0, Math.max(1, Math.floor(scores.length * 0.75)));
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  return mean * Math.exp(-Math.abs(Math.log(stretch)) * 0.5);
}

function renderSample(text, family, size = 48) {
  // 폰트로 쓴 글자를 흰 바탕에 검은 글씨로 그려서 이미지 주소로 돌려준다
  const probe = canvasOf(1, 1).getContext('2d');
  probe.font = `${size}px "${family}"`;
  const { placed, width } = layout(text, probe, size);
  const canvas = canvasOf(Math.ceil(width) + size, size * 2);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = probe.font;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#fff';
  placed.forEach(([char, x]) => ctx.fillText(char, x + size / 2, size / 3));
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const data = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
  const glyph = tight({ w: canvas.width, h: canvas.height, data });
  if (!glyph) return null;
  const out = canvasOf(glyph.w, glyph.h);
  const image = out.getContext('2d').createImageData(glyph.w, glyph.h);
  glyph.data.forEach((v, i) => {
    image.data.fill(255 - v, i * 4, i * 4 + 3);
    image.data[i * 4 + 3] = 255;
  });
  out.getContext('2d').putImageData(image, 0, 0);
  return out.toDataURL('image/png');
}

async function cropOf(blob, box) {
  const bitmap = await createImageBitmap(blob);
  const [x1, y1, x2, y2] = box;
  const x = Math.max(0, x1);
  const y = Math.max(0, y1);
  const canvas = canvasOf(Math.max(1, x2 - x), Math.max(1, y2 - y));
  canvas.getContext('2d', { willReadFrequently: true })
    .drawImage(bitmap, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

async function identifyFonts(captions, frames, onProgress) {
  const fonts = await ensureFonts(onProgress);
  const chosen = [...captions].sort((a, b) => b.text.length * b.score - a.text.length * a.score).slice(0, MAX_COMPARED);
  const totals = Object.fromEntries(fonts.map(f => [f.name, []]));

  for (const [number, caption] of chosen.entries()) {
    onProgress(`폰트 비교 중 ${number + 1} / ${chosen.length}`);
    const crop = await cropOf(frames[caption.frame], caption.box);
    const mask = captionMask(crop);
    if (!mask || mask.h < 8) continue;
    const real = scaleHeight(mask);
    const scores = {};
    for (const font of fonts) {
      if (!font.covers(caption.text)) continue;
      scores[font.name] = similarity(real, caption.text, font.family);
      totals[font.name].push(scores[font.name]);
      await breathe();
    }
    const names = Object.keys(scores);
    if (names.length) {
      caption.font = names.reduce((a, b) => (scores[b] > scores[a] ? b : a));
      caption.crop = crop.toDataURL('image/jpeg');
    }
  }

  const measured = chosen.filter(c => c.crop);
  const ranked = Object.entries(totals)
    .filter(([, values]) => values.length >= Math.max(1, Math.floor(measured.length / 2)))
    .map(([name, values]) => [name, values.reduce((a, b) => a + b, 0) / values.length])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const sample = measured[0] || null;
  const results = ranked.map(([name, score]) => ({
    name, score: Math.round(Math.max(score, 0) * 100),
    sample: sample ? renderSample(sample.text, fonts.find(f => f.name === name).family) : null,
  }));
  return { fonts: results, sample };
}

export async function analyzeCaptions(video, duration, onProgress) {
  const sampled = await sampleFrames(video, duration, onProgress);
  const captions = await groupCaptions(sampled, onProgress);
  const { fonts, sample } = captions.length
    ? await identifyFonts(captions, sampled.frames, onProgress)
    : { fonts: [], sample: null };
  return {
    fonts,
    sample_crop: sample ? sample.crop : null,
    sample_text: sample ? sample.text : null,
    compared: captions.filter(c => c.crop).length,
    lines: captions
      .sort((a, b) => a.start - b.start)
      .map(c => ({ start: c.start, end: c.end, text: c.text, font: c.font, crop: c.crop })),
  };
}
