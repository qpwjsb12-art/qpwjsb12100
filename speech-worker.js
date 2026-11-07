// 말소리 받아쓰기(Whisper). 화면이 멈추지 않도록 따로 돌린다.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

const MODEL = 'Xenova/whisper-base';
const PIECE_SECONDS = 30;

let asr = null;

self.onmessage = async ({ data: { samples, sampleRate } }) => {
  const progress = message => self.postMessage({ type: 'progress', message });
  try {
    if (!asr) {
      progress('음성 인식 모델 받는 중 (처음 한 번만 오래 걸려요)');
      asr = await pipeline('automatic-speech-recognition', MODEL);
    }
    const total = samples.length / sampleRate;
    const piece = PIECE_SECONDS * sampleRate;
    const lines = [];
    for (let begin = 0; begin < samples.length; begin += piece) {
      const offset = begin / sampleRate;
      progress(`말소리 받아쓰는 중 ${Math.round(offset)}초 / ${Math.round(total)}초`);
      const audio = samples.subarray(begin, begin + piece);
      // 조용한 구간은 Whisper가 없는 말을 지어내서 건너뛴다
      if (audio.reduce((max, v) => Math.max(max, Math.abs(v)), 0) < 0.01) continue;
      const out = await asr(audio, { return_timestamps: true });
      for (const chunk of out.chunks || []) {
        const text = chunk.text.trim();
        if (!text) continue;
        const [start, end] = chunk.timestamp;
        lines.push({ start: offset + start, end: offset + (end ?? audio.length / sampleRate), text });
      }
    }
    self.postMessage({ type: 'done', lines });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err.message || err) });
  }
};
