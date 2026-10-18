"""Optional local SigLIP2 encoder. Run --help for installation/runtime options."""
import argparse
import base64
import hashlib
import importlib.util
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 16 * 1024 * 1024


class Encoder:
    def __init__(self, args):
        self.args = args
        self.lock = threading.Lock()
        self.model = None
        self.processor = None
        self.fingerprint = None

    def health(self):
        missing = [name for name in ("torch", "transformers", "PIL") if importlib.util.find_spec(name) is None]
        return {"model": self.args.model, "revision": self.args.revision, "ready": not missing,
                "loaded": self.model is not None,
                "diagnostic": "Missing dependencies: " + ", ".join(missing) if missing else "Ready; first encode loads cached model weights"}

    def load(self):
        if self.model is not None:
            return
        import torch
        import transformers
        import PIL
        from transformers import AutoModel, AutoProcessor
        self.torch = torch
        options = {"revision": self.args.weights_revision, "local_files_only": not self.args.download,
                   "trust_remote_code": False}
        model = AutoModel.from_pretrained(self.args.model, **options).eval().to(self.args.device)
        weights_revision = getattr(model.config, "_commit_hash", None)
        if not weights_revision:
            raise RuntimeError("Model must resolve to a versioned Hugging Face snapshot")
        processor = AutoProcessor.from_pretrained(self.args.model, **{**options, "revision": weights_revision})
        identity = [self.args.model, self.args.revision, weights_revision,
                    "siglip2-rgb-processor-v1", "siglip-max-position-padding-v1", "l2-v1",
                    transformers.__version__, PIL.__version__, torch.__version__, str(processor)]
        fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        self.processor, self.model, self.fingerprint = processor, model, fingerprint

    def encode(self, payload):
        if payload.get("model") != self.args.model or payload.get("revision") != self.args.revision:
            raise ValueError("Requested model/revision differs from server configuration")
        has_images, has_texts = "images" in payload, "texts" in payload
        if has_images == has_texts or set(payload) != {"model", "revision", "images" if has_images else "texts"}:
            raise ValueError("Supply exactly one of images or texts")
        values = payload["images"] if has_images else payload["texts"]
        if not isinstance(values, list) or not 1 <= len(values) <= 8 or any(not isinstance(v, str) for v in values):
            raise ValueError("Expected 1-8 inputs")
        if not self.lock.acquire(blocking=False):
            raise BlockingIOError("Encoder is busy")
        try:
            self.load()
            if has_images:
                from PIL import Image
                Image.MAX_IMAGE_PIXELS = 16_000_000
                images = []
                for value in values:
                    raw = base64.b64decode(value, validate=True)
                    if len(raw) > 4 * 1024 * 1024:
                        raise ValueError("Image exceeds 4 MiB")
                    with Image.open(io.BytesIO(raw)) as image:
                        if image.width * image.height > 16_000_000:
                            raise ValueError("Image dimensions exceed limit")
                        images.append(image.convert("RGB"))
                inputs = self.processor(images=images, return_tensors="pt").to(self.args.device)
                with self.torch.inference_mode():
                    vectors = self.model.get_image_features(**inputs)
            else:
                if any(not value.strip() or len(value) > 2000 for value in values):
                    raise ValueError("Text must contain 1-2000 characters")
                inputs = self.processor(text=values, padding="max_length", truncation=True,
                                        max_length=self.model.config.text_config.max_position_embeddings,
                                        return_tensors="pt").to(self.args.device)
                with self.torch.inference_mode():
                    vectors = self.model.get_text_features(**inputs)
            # Transformers versions may return a ModelOutput instead of a tensor.
            if hasattr(vectors, "pooler_output"):
                vectors = vectors.pooler_output
            vectors = self.torch.nn.functional.normalize(vectors.float(), dim=-1)
            if not self.torch.isfinite(vectors).all():
                raise RuntimeError("Non-finite model output")
            return {"model": self.args.model, "revision": self.args.revision, "fingerprint": self.fingerprint,
                    "dimensions": vectors.shape[-1], "embeddings": vectors.cpu().tolist()}
        finally:
            self.lock.release()


def handler(encoder):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, code, value):
            data = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.reply(200, encoder.health()) if self.path == "/health" else self.reply(404, {"error": "Not found"})

        def do_POST(self):
            self.connection.settimeout(30)
            if self.path != "/encode":
                return self.reply(404, {"error": "Not found"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= MAX_BODY:
                    return self.reply(413, {"error": "Invalid body size"})
                if self.headers.get_content_type() != "application/json":
                    return self.reply(415, {"error": "Expected JSON"})
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise ValueError("Expected object")
                self.reply(200, encoder.encode(payload))
            except BlockingIOError as error:
                self.reply(429, {"error": str(error)})
            except (ValueError, TypeError, KeyError) as error:
                self.reply(400, {"error": str(error)})
            except Exception as error:
                # Details stay on the local service; the Wiki displays an actionable HTTP error.
                print(f"Encoding failed: {error}", flush=True)
                self.reply(503, {"error": "Model unavailable; check local service console and cached weights"})

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--model", default="google/siglip2-base-patch16-224")
    parser.add_argument("--revision", default="1", help="Application model revision; match Wiki settings")
    parser.add_argument("--weights-revision", default="main", help="Prefer a fixed Hugging Face commit")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda", "mps"])
    parser.add_argument("--download", action="store_true", help="Allow fetching missing weights from Hugging Face")
    parser.add_argument("--warmup", action="store_true", help="Load model before serving requests")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be 1-65535")
    encoder = Encoder(args)
    if args.warmup:
        encoder.load()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler(encoder))
    server.daemon_threads = True
    print(f"Visual encoder: http://127.0.0.1:{args.port} ({args.model}, {args.device})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
