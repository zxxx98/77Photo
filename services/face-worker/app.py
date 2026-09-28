"""Authenticated, bounded, one-inference-at-a-time API per worker process."""
import asyncio
from contextlib import asynccontextmanager
import hmac
import io
import os
import warnings

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
from PIL import Image

MAX_BODY = 8 * 1024 * 1024


def create_app(engine_factory=None, token=None):
    secret = token if token is not None else os.environ.get("FACE_API_KEY", "")
    if len(secret) < 32 or any(ord(c) <= 32 or ord(c) >= 127 for c in secret):
        raise ValueError("FACE_API_KEY needs at least 32 printable non-space ASCII characters")

    @asynccontextmanager
    async def lifespan(app):
        if engine_factory is None:
            from engine import Engine
            app.state.engine = await run_in_threadpool(Engine, os.environ.get("FACE_MODEL_DIR", "/models"))
        else:
            app.state.engine = engine_factory()
        app.state.lock = asyncio.Lock()
        yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def authenticate(request, call_next):
        if not hmac.compare_digest(request.headers.get("authorization", "").encode(), f"Bearer {secret}".encode()):
            return JSONResponse({"error": {"code": "UNAUTHORIZED"}}, status_code=401)
        return await call_next(request)

    @app.get("/v1/health")
    async def health():
        return app.state.engine.profile

    @app.post("/v1/analyze")
    async def analyze(image: UploadFile = File(...), request_id: str = Form(...), pipeline_id: str = Form(...)):
        if not 1 <= len(request_id) <= 128:
            raise HTTPException(422, "invalid request ID")
        if pipeline_id != app.state.engine.profile["pipeline_id"]:
            raise HTTPException(409, "pipeline mismatch")
        try:
            await asyncio.wait_for(app.state.lock.acquire(), timeout=30)
        except TimeoutError:
            raise HTTPException(429, "worker busy", headers={"Retry-After": "2"}) from None
        try:
            raw = await image.read(MAX_BODY + 1)
            await image.close()
            if len(raw) > MAX_BODY:
                raise HTTPException(413, "image too large")
            # Inspect dimensions before OpenCV allocation; limit accepted encodings.
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("error", Image.DecompressionBombWarning)
                    with Image.open(io.BytesIO(raw)) as check:
                        if check.format != "JPEG" or max(check.size) > 1280 or min(check.size) < 1:
                            raise ValueError("expected JPEG preview <= 1280px")
                        if check.getexif():
                            raise ValueError("EXIF must be stripped")
                        check.verify()
            except Exception:
                raise HTTPException(422, "invalid preview") from None
            try:
                result = await run_in_threadpool(app.state.engine.analyze, raw)
            except ValueError:
                raise HTTPException(422, "image could not be analyzed") from None
            except Exception:
                raise HTTPException(503, "inference unavailable") from None
            return {**result, "request_id": request_id}
        finally:
            app.state.lock.release()

    # Bound the entire body, including multipart fields, before the parser runs.
    class BoundedApp:
        async def __call__(self, scope, receive, send):
            if scope["type"] != "http" or scope.get("method") != "POST":
                return await app(scope, receive, send)
            headers = dict(scope.get("headers", []))
            if not hmac.compare_digest(headers.get(b"authorization", b""), f"Bearer {secret}".encode()):
                return await JSONResponse({"error": {"code": "UNAUTHORIZED"}}, status_code=401)(scope, receive, send)
            data = bytearray()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                data.extend(message.get("body", b""))
                if len(data) > MAX_BODY:
                    return await JSONResponse({"error": {"code": "BODY_TOO_LARGE"}}, status_code=413)(scope, receive, send)
                if not message.get("more_body", False):
                    break
            sent = False

            async def replay():
                nonlocal sent
                if not sent:
                    sent = True
                    return {"type": "http.request", "body": bytes(data), "more_body": False}
                return await receive()

            await app(scope, replay, send)

    return BoundedApp()
