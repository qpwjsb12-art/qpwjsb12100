# 그린공차 영상검토 (웹 버전)

영상 파일을 올리면 화면 자막, 폰트 후보, 브금, 저작권 위험을 찾아 주는 사이트.
분석은 보는 사람의 브라우저 안에서 하고, 곡 찾기만 `api/recognize.py`(Vercel 서버)가 한다.
컴퓨터에서 직접 돌리는 원래 버전은 `../vicode-site`에 있다.

## 원래 버전과 다른 점

- 유튜브/인스타 링크는 못 넣는다. 영상 파일만 올릴 수 있다 (500MB, 15분 이하).
- AI 검토(자막 교정, 장단점)가 없다.
- 글자 인식은 RapidOCR 대신 Tesseract, 말소리는 Whisper base를 쓴다. 정확도가 조금 낮을 수 있다.
- 말소리 받아쓰기는 화면 자막이 없을 때만 한다.

## 올리기 (Vercel)

1. 이 폴더 안의 파일을 GitHub 저장소에 올린다.
2. https://vercel.com 에 GitHub로 로그인하고 Add New → Project에서 그 저장소를 Import한다.
3. Project Name을 `greengongcha100`으로 하고 Deploy를 누른다. 주소는 https://greengongcha100.vercel.app 이 된다.

저장소에 고친 파일을 올리면 Vercel이 알아서 다시 배포한다.
