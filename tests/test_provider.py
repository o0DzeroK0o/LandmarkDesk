import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from vision_api import ModelError, infer


class ProviderTest(unittest.TestCase):
    def setUp(self):
        case = self
        self.status = 200
        self.requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                case.requests.append((self.path, self.headers, body))
                self.send_response(case.status)
                self.send_header("retry-after", "47")
                self.end_headers()
                result = json.dumps(dict(driver_present=False, needs_review=False, review_note="", points=[]))
                reply = {"content": [{"type": "text", "text": result}]} if self.path.endswith("messages") else {"choices":[{"message":{"content":result}}]}
                self.wfile.write(json.dumps(reply).encode())

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.base = f"http://127.0.0.1:{server.server_port}/v1"
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.image = Path(self.temp.name) / "test.png"
        self.image.write_bytes(b"png")

    def run_request(self, provider):
        values = dict(AI_PROVIDER=provider, AI_BASE_URL=self.base, AI_MODEL="fixture", AI_API_KEY="fixture-key", AI_MAX_TOKENS="")
        with patch.dict("os.environ", values):
            return infer([self.image], "Inspect this image", {"type":"object"})

    def test_both_vision_protocols(self):
        for provider in ("openai","anthropic"):
            self.assertFalse(self.run_request(provider)["driver_present"])
            route, headers, body = self.requests[-1]
            image = body["messages"][0]["content"][1]
            if provider == "anthropic":
                self.assertEqual(route, "/v1/messages")
                self.assertEqual(headers["x-api-key"], "fixture-key")
                self.assertEqual(headers["anthropic-version"], "2023-06-01")
                self.assertEqual(image["source"]["data"], "cG5n")
                self.assertGreater(body["max_tokens"], 0)
            else:
                self.assertEqual(route, "/v1/chat/completions")
                self.assertEqual(headers["Authorization"], "Bearer fixture-key")
                self.assertEqual(image["image_url"]["url"], "data:image/png;base64,cG5n")

    def test_rate_limit_and_auth(self):
        for self.status, code in ((429,"RATE_LIMIT"), (401,"AUTH_REQUIRED")):
            with self.assertRaises(ModelError) as caught:
                self.run_request("openai")
            self.assertEqual(caught.exception.code, code)
            if self.status == 429:
                self.assertEqual(caught.exception.retry_after, 47)
