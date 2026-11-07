// 자막 폰트 비교에 쓰는 후보 목록. 분석할 때 브라우저가 내려받는다.
// (이름, 주소) - 주소는 Google Fonts 저장소, 눈누 CDN, Pretendard 배포본이다.

const GOOGLE = 'https://raw.githubusercontent.com/google/fonts/main/ofl/';
const NOONNU = 'https://fastly.jsdelivr.net/gh/projectnoonnu/';
const PRETENDARD = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard/packages/pretendard/dist/public/static/';

export const FONT_SOURCES = {
  // 유튜브 편집에서 많이 쓰는 무료 폰트
  '여기어때 잘난체': NOONNU + 'noonfonts_four@1.2/JalnanOTF00.woff',
  'G마켓 산스 Bold': NOONNU + 'noonfonts_2001@1.1/GmarketSansBold.woff',
  'G마켓 산스 Medium': NOONNU + 'noonfonts_2001@1.1/GmarketSansMedium.woff',
  '에스코어 드림 Bold': NOONNU + 'noonfonts_six@1.2/S-CoreDream-6Bold.woff',
  '에스코어 드림 Heavy': NOONNU + 'noonfonts_six@1.2/S-CoreDream-8Heavy.woff',
  '카페24 써라운드': NOONNU + 'noonfonts_2105_2@1.0/Cafe24Ssurround.woff',
  '어그로체 Bold': NOONNU + 'noonfonts_2108@1.1/SBAggroB.woff',
  '어그로체 Medium': NOONNU + 'noonfonts_2108@1.1/SBAggroM.woff',
  '티몬 몬소리': NOONNU + 'noonfonts_two@1.0/TmonMonsori.woff',
  '쿠키런 Regular': NOONNU + 'noonfonts_2001@1.1/CookieRun-Regular.woff',
  '넥슨 Lv1 고딕 Bold': NOONNU + 'noonfonts_20-04@2.1/NEXON%20Lv1%20Gothic%20OTF%20Bold.woff',
  '넥슨 Lv2 고딕 Bold': NOONNU + 'noonfonts_20-04@2.1/NEXON%20Lv2%20Gothic%20Bold.woff',
  '프리텐다드 Bold': PRETENDARD + 'Pretendard-Bold.otf',
  '프리텐다드 ExtraBold': PRETENDARD + 'Pretendard-ExtraBold.otf',
  '프리텐다드 Black': PRETENDARD + 'Pretendard-Black.otf',
  // Google Fonts 한글 폰트
  '검은고딕 (Black Han Sans)': GOOGLE + 'blackhansans/BlackHanSans-Regular.ttf',
  '배민 도현체 (Do Hyeon)': GOOGLE + 'dohyeon/DoHyeon-Regular.ttf',
  '배민 주아체 (Jua)': GOOGLE + 'jua/Jua-Regular.ttf',
  '나눔고딕 Bold': GOOGLE + 'nanumgothic/NanumGothic-Bold.ttf',
  '나눔고딕 ExtraBold': GOOGLE + 'nanumgothic/NanumGothic-ExtraBold.ttf',
  '나눔손글씨 펜': GOOGLE + 'nanumpenscript/NanumPenScript-Regular.ttf',
  '나눔손글씨 붓': GOOGLE + 'nanumbrushscript/NanumBrushScript-Regular.ttf',
  '나눔명조 Bold': GOOGLE + 'nanummyeongjo/NanumMyeongjo-Bold.ttf',
  '구기 (Gugi)': GOOGLE + 'gugi/Gugi-Regular.ttf',
  'Sunflower Bold': GOOGLE + 'sunflower/Sunflower-Bold.ttf',
  '감자꽃 (Gamja Flower)': GOOGLE + 'gamjaflower/GamjaFlower-Regular.ttf',
  '개구 (Gaegu Bold)': GOOGLE + 'gaegu/Gaegu-Bold.ttf',
  'Cute Font': GOOGLE + 'cutefont/CuteFont-Regular.ttf',
  'Dongle Bold': GOOGLE + 'dongle/Dongle-Bold.ttf',
  '고운돋움': GOOGLE + 'gowundodum/GowunDodum-Regular.ttf',
  '고딕 A1 Bold': GOOGLE + 'gothica1/GothicA1-Bold.ttf',
  'IBM Plex Sans KR Bold': GOOGLE + 'ibmplexsanskr/IBMPlexSansKR-Bold.ttf',
  '독도 (Dokdo)': GOOGLE + 'dokdo/Dokdo-Regular.ttf',
  '연성체 (Yeon Sung)': GOOGLE + 'yeonsung/YeonSung-Regular.ttf',
  '스타일리시 (Stylish)': GOOGLE + 'stylish/Stylish-Regular.ttf',
  '싱글데이 (Single Day)': GOOGLE + 'singleday/SingleDay-Regular.ttf',
  '하이멜로디 (Hi Melody)': GOOGLE + 'himelody/HiMelody-Regular.ttf',
  '기랑해랑 (Kirang Haerang)': GOOGLE + 'kiranghaerang/KirangHaerang-Regular.ttf',
  '흑백사진 (Black and White Picture)': GOOGLE + 'blackandwhitepicture/BlackAndWhitePicture-Regular.ttf',
};

let loaded = null;

async function loadOne(name, url, index) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const parsed = opentype.parse(buffer);
  const family = `vicode-font-${index}`;
  const face = new FontFace(family, buffer);
  await face.load();
  document.fonts.add(face);
  return {
    name, family,
    covers: text => [...text].every(c => /\s/.test(c) || parsed.charToGlyphIndex(c) > 0),
  };
}

/** 폰트를 한 번만 받아서 쓸 수 있는 것만 돌려준다. */
export async function ensureFonts(onProgress = () => {}) {
  if (loaded) return loaded;
  const entries = Object.entries(FONT_SOURCES);
  const results = new Array(entries.length);
  let next = 0;
  let done = 0;
  // 한꺼번에 다 받으면 느려져서 6개씩 받는다
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < entries.length) {
      const index = next++;
      const [name, url] = entries[index];
      try {
        results[index] = await loadOne(name, url, index);
      } catch (err) {
        console.warn('폰트 받기 실패:', name, err);
      }
      onProgress(`폰트 받는 중 ${++done} / ${entries.length} (처음 한 번은 오래 걸려요)`);
    }
  }));
  loaded = results.filter(Boolean);
  return loaded;
}

export function fontFamily(name) {
  return (loaded || []).find(f => f.name === name)?.family;
}
