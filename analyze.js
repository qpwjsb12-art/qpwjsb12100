// 영상 분석은 전부 브라우저 안에서 한다. 곡 찾기만 소리 조각을 /api/recognize로 보낸다.
import { analyzeCaptions } from './captions.js';
import { checkCopyright } from './copyright.js';

const SAMPLE_RATE = 16000;
const MAX_DURATION = 15 * 60;
const MAX_FILE_BYTES = 500 * 1024 ** 2;
const MEDIAPIPE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@0.10.14';
const YAMNET_URL = 'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/latest/yamnet.tflite';
const MUSIC_LABELS = new Set([
  'Music', 'Background music', 'Theme music', 'Soundtrack music', 'Song',
  'Pop music', 'Hip hop music', 'Electronic music', 'Dance music',
  'Ambient music', 'Video game music', 'Singing', 'Rapping',
]);
const STEPS = [
  ['download', '영상 준비'], ['captions', '화면 자막과 폰트'], ['subtitles', '말소리'], ['bgm', '브금과 저작권'],
];

class AnalyzeError extends Error {}   // 사용자에게 그대로 보여줄 수 있는 실패 이유

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ===================== 공통 유틸 =====================

function mergeRanges(items, key, gap) {
  // 같은 key 값이 gap초 안에 이어지면 하나의 구간으로 합친다
  const merged = [];
  const lastByKey = new Map();
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    const prev = lastByKey.get(item[key]);
    if (prev && item.start - prev.end <= gap) {
      prev.end = Math.max(prev.end, item.end);
    } else {
      const copied = { ...item };
      merged.push(copied);
      lastByKey.set(item[key], copied);
    }
  }
  return merged;
}

function peakOf(samples) {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  return peak;
}

// ===================== 1. 영상 열기 =====================

function openVideo(url) {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  return new Promise((resolve, reject) => {
    video.addEventListener('loadeddata', () => resolve(video), { once: true });
    video.addEventListener('error', () => reject(new AnalyzeError(
      '이 브라우저에서 열 수 없는 영상이에요. mp4(H.264)로 바꿔서 올려주세요.')), { once: true });
    video.src = url;
  });
}

async function extractAudio(file) {
  // 오디오 컨텍스트를 16kHz로 만들면 디코딩하면서 같이 바꿔준다
  const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  let buffer;
  try {
    buffer = await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new AnalyzeError('이 영상에서는 소리를 꺼낼 수 없어요.');
  }
  const samples = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    buffer.getChannelData(c).forEach((v, i) => { samples[i] += v / buffer.numberOfChannels; });
  }
  if (!samples.length) throw new AnalyzeError('이 영상에는 소리가 없어요.');
  return samples;
}

function waveformPeaks(samples, count = 400) {
  const size = Math.ceil(samples.length / count);
  const peaks = Array.from({ length: count }, (_, i) => peakOf(samples.subarray(i * size, (i + 1) * size)));
  const top = Math.max(...peaks) || 1;
  return peaks.map(p => Math.round((p / top) * 1000) / 1000);
}

// ===================== 2. 말소리 =====================

let speechWorker = null;

function transcribe(samples, onProgress) {
  speechWorker ||= new Worker('speech-worker.js', { type: 'module' });
  return new Promise((resolve, reject) => {
    speechWorker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress(data.message);
      else if (data.type === 'done') resolve({ source: '말소리 받아쓰기 (Whisper)', lines: data.lines });
      else reject(new Error(data.message));
    };
    speechWorker.postMessage({ samples, sampleRate: SAMPLE_RATE });
  });
}

// ===================== 3. 음악 구간 =====================

let classifier = null;

async function detectMusic(samples, onProgress) {
  if (!classifier) {
    onProgress('음악 구분 모델 준비 중');
    const { AudioClassifier, FilesetResolver } = await import(`${MEDIAPIPE}/audio_bundle.mjs`);
    const fileset = await FilesetResolver.forAudioTasks(`${MEDIAPIPE}/wasm`);
    classifier = await AudioClassifier.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: YAMNET_URL }, maxResults: 8, scoreThreshold: 0.1,
    });
  }
  // 한 번에 넣으면 메모리가 모자랄 수 있어서 약 1분씩 나눈다
  const chunk = Math.round(0.975 * 60 * SAMPLE_RATE);
  const music = [];
  for (let begin = 0; begin < samples.length; begin += chunk) {
    onProgress(`음악 구간 찾는 중 ${Math.round(begin / SAMPLE_RATE)}초`);
    for (const result of classifier.classify(samples.subarray(begin, begin + chunk), SAMPLE_RATE)) {
      const start = begin / SAMPLE_RATE + result.timestampMs / 1000;
      const heard = result.classifications[0].categories
        .some(cat => MUSIC_LABELS.has(cat.categoryName) && cat.score >= 0.25);
      if (heard) music.push({ start, end: start + 0.975, label: 'music' });
    }
    await sleep(0);
  }
  return mergeRanges(music, 'label', 2)
    .filter(r => r.end - r.start >= 2)
    .map(r => ({ start: r.start, end: r.end }));
}

// ===================== 4. 브금 찾기 =====================

function toWav(samples) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true));
  return new Blob([view], { type: 'audio/wav' });
}

async function recognizeAll(samples, onProgress) {
  const total = samples.length / SAMPLE_RATE;
  const clip = 12;
  const step = Math.max(8, total / 24);
  const starts = [];
  for (let start = 0; start < Math.max(total - 3, 0.1); start += step) starts.push(start);
  const matches = [];
  let failed = 0;
  for (const [i, start] of starts.entries()) {
    onProgress(`브금 찾는 중 ${i + 1} / ${starts.length}`);
    const begin = Math.floor(start * SAMPLE_RATE);
    const piece = samples.subarray(begin, begin + clip * SAMPLE_RATE);
    if (peakOf(piece) < 0.01) continue;
    let data;
    try {
      const res = await fetch('/api/recognize', { method: 'POST', body: toWav(piece) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      console.warn('곡 찾기 실패:', err);
      failed += 1;
      await sleep(3000);
      continue;
    }
    if (data.track) {
      matches.push({ ...data.track, start, end: Math.min(start + clip, total), hits: 1 });
    }
    await sleep(1200);
  }
  const counts = {};
  matches.forEach(m => { counts[m.key] = (counts[m.key] || 0) + 1; });
  const merged = mergeRanges(matches, 'key', step * 2);
  merged.forEach(track => { track.hits = counts[track.key]; });
  return { tracks: merged, failed, checked: starts.length };
}

async function analyzeBgm(samples, musicRanges, onProgress) {
  const result = await recognizeAll(samples, onProgress);
  // 한 번만 잡혔거나 음악이 안 들리는 곳에서 잡힌 곡은 착각일 때가 많다
  for (const track of result.tracks) {
    const heard = musicRanges.some(m => m.start < track.end && track.start < m.end);
    track.uncertain = track.hits < 2 || !heard;
  }
  return result;
}

// ===================== 전체 순서 =====================

const stepOf = (job, key) => job.steps.find(s => s.key === key);

export function newJob() {
  return {
    status: 'queued', error: null, result: {}, videoUrl: null,
    steps: STEPS.map(([key, name]) => ({ key, name, state: 'waiting', message: '' })),
  };
}

async function runStep(job, key, update, work) {
  // 한 단계가 실패해도 나머지 분석 결과는 살린다
  const step = stepOf(job, key);
  step.state = 'running';
  update();
  const onProgress = message => {
    step.message = message;
    update();
  };
  try {
    job.result[key] = await work(onProgress);
    step.state = 'done';
    step.message = '';
  } catch (err) {
    console.error(err);
    job.result[key] = null;
    step.state = 'failed';
    step.message = String(err.message || err).slice(0, 200);
  }
  update();
}

export async function runJob(job, file, update) {
  job.status = 'running';
  const download = stepOf(job, 'download');
  download.state = 'running';
  update();
  let video, samples;
  try {
    if (file.size > MAX_FILE_BYTES) throw new AnalyzeError('500MB 이하 영상만 올릴 수 있어요.');
    job.videoUrl = URL.createObjectURL(file);
    download.message = '영상 여는 중';
    update();
    video = await openVideo(job.videoUrl);
    if (video.duration > MAX_DURATION && Number.isFinite(video.duration)) {
      throw new AnalyzeError(`${MAX_DURATION / 60}분 이하 영상만 분석할 수 있어요.`);
    }
    download.message = '소리 꺼내는 중';
    update();
    samples = await extractAudio(file);
  } catch (err) {
    console.error(err);
    download.state = 'failed';
    job.status = 'failed';
    job.error = err instanceof AnalyzeError ? err.message : `예상하지 못한 오류가 났어요: ${err.message}`;
    update();
    return;
  }

  download.state = 'done';
  download.message = '';
  const duration = Number.isFinite(video.duration) ? video.duration : samples.length / SAMPLE_RATE;
  job.result.meta = {
    title: file.name, uploader: '직접 올린 영상', duration,
    webpage_url: null, listed_track: null, listed_artist: null,
  };
  job.result.peaks = waveformPeaks(samples);
  update();

  await runStep(job, 'captions', update, p => analyzeCaptions(video, duration, p));
  video.removeAttribute('src');
  video.load();

  // 말소리는 화면 자막이 없을 때만 보여주므로 그때만 받아쓴다
  await runStep(job, 'subtitles', update, p => (job.result.captions?.lines.length
    ? { source: '화면 자막이 있어서 건너뜀', lines: [] }
    : transcribe(samples, p)));

  await runStep(job, 'bgm', update, async p => {
    const musicRanges = await detectMusic(samples, p);
    job.result.music_ranges = musicRanges;
    return analyzeBgm(samples, musicRanges, p);
  });

  job.result.copyright = checkCopyright(job.result.bgm, job.result.music_ranges);
  job.status = 'done';
  update();
}
