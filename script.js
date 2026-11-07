import { newJob, runJob } from './analyze.js';
import { fontFamily } from './fonts.js';

const $ = id => document.getElementById(id);

const state = { job: null, duration: 0, rendered: {}, rows: [], lines: [] };

// ===================== 공통 유틸 =====================

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function seek(sec) {
  $('player').currentTime = sec;
  $('player').play().catch(() => {});
}

function showMessage(container, className, text) {
  container.replaceChildren(el('p', className, text));
}

// ===================== 분석 시작 / 진행 상황 =====================

function resetReport() {
  if (state.job && state.job.videoUrl) URL.revokeObjectURL(state.job.videoUrl);
  Object.assign(state, { job: null, rendered: {}, rows: [], lines: [], duration: 0 });
  $('report').hidden = true;
  $('player').pause();
  $('player').removeAttribute('src');
  $('player').load();
  ['laneBgm', 'laneSub', 'bgmList', 'subList', 'fontList', 'fontHero', 'copyrightBox']
    .forEach(id => $(id).replaceChildren());
  $('subSource').textContent = '';
  $('captionOverlay').hidden = true;
  $('captionOverlay').style.fontFamily = '';
}

function showError(message) {
  $('formError').textContent = message;
  $('formError').hidden = false;
}

function setBusy(busy) {
  $('fileInput').disabled = busy;
  $('fileLabel').classList.toggle('disabled', busy);
}

async function startJob(file) {
  $('formError').hidden = true;
  resetReport();
  setBusy(true);
  const job = newJob();
  state.job = job;
  $('hero').classList.add('compact');
  $('progressBox').hidden = false;
  const update = () => {
    if (job !== state.job) return;
    renderSteps(job.steps);
    renderResult(job);
  };
  await runJob(job, file, update);
  if (job !== state.job) return;
  setBusy(false);
  if (job.status === 'failed') showError(job.error);
  else $('progressBox').hidden = !job.steps.some(s => s.state === 'failed');
}

$('fileInput').addEventListener('change', () => {
  const file = $('fileInput').files[0];
  if (!file) return;
  startJob(file);
  $('fileInput').value = '';
});

function renderSteps(steps) {
  $('stepList').replaceChildren(...steps.map(step => {
    const li = el('li');
    li.dataset.state = step.state;
    li.append(el('span', 'step-name', step.name), el('span', 'step-msg', step.message));
    return li;
  }));
}

// ===================== 결과 그리기 =====================

function renderResult(job) {
  const r = job.result;
  if (r.meta && !state.rendered.meta) {
    state.rendered.meta = true;
    renderMeta(r.meta, r.peaks, job.videoUrl);
  }
  const stepOf = key => job.steps.find(s => s.key === key);
  const captionsStep = stepOf('captions');
  const speechStep = stepOf('subtitles');
  if (!state.rendered.captions) {
    if (captionsStep.state === 'done' || captionsStep.state === 'failed') {
      if (speechStep.state === 'done' || speechStep.state === 'failed') {
        state.rendered.captions = true;
        renderCaptions(r, captionsStep);
      }
    } else {
      showMessage($('subList'), 'empty', '자막을 읽는 중이에요...');
      showMessage($('fontList'), 'empty', '폰트를 비교하는 중이에요...');
    }
  }
  const bgm = stepOf('bgm');
  if (!state.rendered.bgm && (bgm.state === 'done' || bgm.state === 'failed')) {
    state.rendered.bgm = true;
    if (bgm.state === 'done') renderBgm(r);
    else showMessage($('bgmList'), 'fail', `브금을 찾지 못했어요: ${bgm.message}`);
  }
  if (!state.rendered.final && job.status === 'done') {
    state.rendered.final = true;
    renderCopyright(r.copyright);
  }
}

function renderMeta(meta, peaks, videoUrl) {
  state.duration = meta.duration;
  $('report').hidden = false;
  $('player').src = videoUrl;
  $('videoTitle').textContent = meta.title;
  $('videoUploader').textContent = [meta.uploader, formatTime(meta.duration)].filter(Boolean).join(' · ');
  drawWave(peaks);
  showMessage($('copyrightBox'), 'empty', '모든 분석이 끝나면 정리해 드려요.');
}

function drawWave(peaks) {
  const canvas = $('waveCanvas');
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = 56 * devicePixelRatio;
  const ctx = canvas.getContext('2d');
  const barW = canvas.width / peaks.length;
  ctx.fillStyle = '#5b6072';
  peaks.forEach((p, i) => {
    const h = Math.max(1, p * canvas.height);
    ctx.fillRect(i * barW, (canvas.height - h) / 2, Math.max(1, barW - 0.5), h);
  });
}

function addMark(lane, kind, start, end, title) {
  const mark = el('button', `mark ${kind}`);
  mark.type = 'button';
  mark.style.left = `${(start / state.duration) * 100}%`;
  mark.style.width = `${((end - start) / state.duration) * 100}%`;
  mark.title = title;
  mark.addEventListener('click', (e) => { e.stopPropagation(); seek(start); });
  lane.append(mark);
}

// ---- 자막 ----

function drawCaptionRows(lines) {
  state.lines = lines;
  $('laneSub').replaceChildren();
  const list = $('subList');
  list.replaceChildren();
  state.rows = lines.map(line => {
    addMark($('laneSub'), 'cap', line.start, line.end, line.text);
    const row = el('button', 'row');
    row.type = 'button';
    row.addEventListener('click', () => seek(line.start));
    const body = el('span', '', line.text);
    if (line.font) body.append(el('span', 'line-font', line.font));
    row.append(el('span', 'time', formatTime(line.start)), body);
    list.append(row);
    return { row, start: line.start, end: line.end };
  });
}

function renderCaptions(result, step) {
  const found = result.captions;
  const speech = result.subtitles;
  if (step.state === 'failed' || !found) {
    showMessage($('subList'), 'fail', `화면 자막을 읽지 못했어요: ${step.message}`);
    showMessage($('fontList'), 'fail', '자막을 읽지 못해서 폰트도 찾지 못했어요.');
    return;
  }
  if (found.lines.length) {
    $('subSource').textContent = `화면에서 읽은 자막 ${found.lines.length}개`;
    drawCaptionRows(found.lines);
  } else if (speech && speech.lines.length) {
    $('subSource').textContent = `화면 자막이 없어서 말소리를 보여드려요. 출처: ${speech.source}`;
    drawCaptionRows(speech.lines);
  } else {
    showMessage($('subList'), 'empty', '화면 자막과 말소리를 찾지 못했어요.');
  }
  renderFonts(found);
}

function renderFonts(found) {
  const list = $('fontList');
  list.replaceChildren();
  if (!found.fonts.length) {
    showMessage(list, 'empty', '폰트를 비교할 만한 자막을 찾지 못했어요.');
    return;
  }
  if (found.sample_crop) {
    const original = el('div', 'font-row original');
    const img = el('img');
    img.src = found.sample_crop;
    img.alt = `영상 속 자막: ${found.sample_text}`;
    original.append(el('strong', '', '영상 속 자막'), img);
    list.append(original);
  }
  found.fonts.forEach(font => {
    const row = el('div', 'font-row');
    row.append(el('strong', '', `${font.name} · ${font.score}점`));
    if (font.sample) {
      const img = el('img');
      img.src = font.sample;
      img.alt = `${font.name} 글자 모양`;
      row.append(img);
    }
    list.append(row);
  });
  setCaptionFont(found.fonts[0].name);
  showFontHero(found.fonts[0].name, '모양이 가장 비슷한 폰트');
}

function showFontHero(name, label) {
  $('fontHero').replaceChildren(el('span', 'note', label), el('strong', '', name));
}

function setCaptionFont(name) {
  // 폰트 비교할 때 이미 받아 둔 폰트를 그대로 쓴다
  const family = fontFamily(name);
  if (family) $('captionOverlay').style.fontFamily = `"${family}", "Noto Sans KR", sans-serif`;
}

// ---- 브금 / 저작권 ----

function renderBgm(result) {
  const tracks = result.bgm.tracks;
  const music = result.music_ranges || [];
  music.forEach(m => addMark($('laneBgm'), 'music', m.start, m.end, `음악 구간 ${formatTime(m.start)}`));
  tracks.forEach(t => addMark($('laneBgm'), t.uncertain ? 'music' : 'bgm', t.start, t.end, `${t.title} - ${t.artist}`));

  const list = $('bgmList');
  list.replaceChildren();
  tracks.forEach(t => {
    const row = el('div', 'track');
    if (t.cover) {
      const img = el('img');
      img.src = t.cover;
      img.alt = '';
      row.append(img);
    } else {
      row.append(el('div', 'no-cover'));
    }
    const info = el('div');
    const time = el('button', 'time', `${formatTime(t.start)} - ${formatTime(t.end)}`);
    time.type = 'button';
    time.addEventListener('click', () => seek(t.start));
    info.append(el('strong', '', t.title), el('span', '', t.artist), time);
    if (t.url) {
      const link = el('a', '', ' Shazam에서 보기');
      link.href = t.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      info.append(link);
    }
    if (t.uncertain) info.append(el('span', 'warn', '확실하지 않아요. 잘못 찾았을 수 있어요.'));
    row.append(info);
    list.append(row);
  });

  if (!tracks.length) {
    list.append(el('p', 'empty', music.length
      ? `음악 구간 ${music.length}곳을 찾았지만 곡 이름은 알아내지 못했어요.`
      : '음악을 찾지 못했어요.'));
  }
}

function renderCopyright(report) {
  const box = $('copyrightBox');
  box.replaceChildren();
  if (!report) {
    showMessage(box, 'empty', '저작권을 점검하지 못했어요.');
    return;
  }
  box.append(el('p', `verdict ${report.overall}`, report.summary));
  report.items.forEach(item => {
    const row = el('div', `risk ${item.level}`);
    row.append(el('strong', '', item.title), el('span', '', item.detail));
    box.append(row);
  });
  box.append(el('p', 'note', report.notice));
}

// ===================== 재생 위치 표시 =====================

$('player').addEventListener('timeupdate', () => {
  const now = $('player').currentTime;
  if (state.duration) $('playhead').style.left = `${(now / state.duration) * 100}%`;
  state.rows.forEach(s => s.row.classList.toggle('now', now >= s.start && now < s.end));
  const current = state.lines.filter(l => now >= l.start && now < l.end).map(l => l.text);
  $('captionOverlay').hidden = !current.length;
  $('captionOverlay').textContent = current.join('\n');
});

$('lanes').addEventListener('click', (e) => {
  if (!state.duration) return;
  const rect = $('lanes').getBoundingClientRect();
  seek(((e.clientX - rect.left) / rect.width) * state.duration);
});
