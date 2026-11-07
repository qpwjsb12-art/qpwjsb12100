# 소리 조각(wav)을 받아 Shazam으로 곡을 찾는다. 나머지 분석은 전부 브라우저에서 한다.
import asyncio
import json
from http.server import BaseHTTPRequestHandler

from aiohttp_retry import ExponentialRetry
from shazamio import Shazam
from shazamio.client import HTTPClient

MAX_BYTES = 2 * 1024 * 1024


async def recognize(data):
    # 기본값은 거절당하면 20번까지 다시 시도해서 한 번에 20초씩 멈춘다
    http_client = HTTPClient(retry_options=ExponentialRetry(attempts=2, max_timeout=5))
    try:
        return await Shazam(http_client=http_client).recognize(data)
    finally:
        await http_client.close()


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get("Content-Length") or 0)
        if not 0 < size <= MAX_BYTES:
            return self.reply(413, {"error": "소리 조각이 너무 커요."})
        try:
            found = asyncio.run(recognize(self.rfile.read(size)))
        except Exception as err:
            return self.reply(502, {"error": str(err)[-200:]})
        track = found.get("track")
        if not track:
            return self.reply(200, {"track": None})
        self.reply(200, {"track": {
            "key": track.get("key"), "title": track.get("title"),
            "artist": track.get("subtitle"), "url": track.get("url"),
            "cover": (track.get("images") or {}).get("coverart"),
        }})

    def reply(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
