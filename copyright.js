// 찾아낸 곡과 음악 구간으로 저작권 위험을 정리한다.
// 유튜브 Content ID에 직접 물어볼 방법은 없으므로 "문제없음"을 보장하지는 않는다.

function fmt(seconds) {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function checkCopyright(bgm, musicRanges) {
  const items = [];
  const tracks = (bgm && bgm.tracks) || [];
  for (const track of tracks) {
    const when = `${fmt(track.start)} - ${fmt(track.end)}`;
    const name = `${track.title} - ${track.artist}`;
    if (track.uncertain) {
      items.push({ level: 'caution', title: name,
        detail: `${when} 구간에서 한 번만 잡혔어요. 잘못 찾았을 수 있으니 직접 들어보세요.` });
    } else {
      items.push({ level: 'danger', title: name,
        detail: `${when} 구간에 등록된 음악이 쓰였어요. 수익 창출 제한이나 차단이 될 수 있어요.` });
    }
  }

  if (!tracks.length && musicRanges && musicRanges.length) {
    const seconds = musicRanges.reduce((sum, m) => sum + m.end - m.start, 0);
    items.push({ level: 'caution', title: '곡을 알 수 없는 음악',
      detail: `음악이 약 ${Math.round(seconds)}초 흐르지만 어떤 곡인지 찾지 못했어요. 출처와 사용 허락을 확인하세요.` });
  }

  if (!bgm) {
    items.push({ level: 'caution', title: '음악 확인 실패',
      detail: '곡 찾기가 실패해서 음악 저작권을 확인하지 못했어요. 다시 검토해 주세요.' });
  } else if (bgm.failed) {
    items.push({ level: 'caution', title: '일부 구간 확인 못 함',
      detail: `${bgm.checked}곳 중 ${bgm.failed}곳은 곡 찾기 서비스가 막혀서 확인하지 못했어요. 그 구간에 다른 곡이 있을 수 있어요.` });
  }

  const levels = new Set(items.map(item => item.level));
  const overall = levels.has('danger') ? 'danger' : levels.has('caution') ? 'caution' : 'clear';
  return {
    overall,
    summary: {
      danger: '저작권 문제가 생길 수 있어요',
      caution: '확인이 필요한 부분이 있어요',
      clear: '찾아낸 위험 요소는 없어요',
    }[overall],
    items,
    notice: '이 결과는 참고용이에요. 유튜브나 인스타그램의 실제 판정과 다를 수 있고, 사용해도 된다는 보증이 아니에요.',
  };
}
