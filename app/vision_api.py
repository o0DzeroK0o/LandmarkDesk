"""Vision inference over Chat Completions or Anthropic Messages."""
import base64
import json
import math
import os
import sys
import time
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class ModelError(RuntimeError):
    def __init__(self, code, detail, retry_after=None):
        self.code, self.detail, self.retry_after = code, detail, retry_after
        super().__init__(f"[{code}] {detail}")

    def report(self, folder):
        diagnostic = {"code": self.code, "detail": self.detail, "retryAfterSeconds": self.retry_after}
        (folder / "agent-error.json").write_text(json.dumps(diagnostic, ensure_ascii=False), encoding="utf-8")
        print(f"ModelError: {self}", file=sys.stderr)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def retry_seconds(headers):
    delays = []
    for key, divisor in (("retry-after-ms", 1000), ("retry-after", 1)):
        raw = headers.get(key)
        if not raw:
            continue
        try:
            number = float(raw) / divisor
        except ValueError:
            try:
                number = parsedate_to_datetime(raw).timestamp() - time.time()
            except (ValueError, OverflowError, OSError, TypeError):
                continue
        if math.isfinite(number):
            delays.append(max(0, math.ceil(number)))
    return max(delays, default=None)


def infer(images, prompt, schema):
    provider = os.environ.get("AI_PROVIDER", "")
    base = os.environ.get("AI_BASE_URL", "").rstrip("/")
    model, key = os.environ.get("AI_MODEL"), os.environ.get("AI_API_KEY")
    url = urlsplit(base)
    if (provider not in ("openai", "anthropic") or not model or not key or not url.hostname or
        url.username or url.password or url.query or url.fragment or
        not (url.scheme == "https" or url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1"))):
        raise ModelError("CONFIG", "Kiểm tra thông tin API trong .env.")
    anthropic = provider == "anthropic"
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if anthropic:
        headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
    else:
        headers["Authorization"] = "Bearer " + key
    instruction = prompt + "\nReturn only one JSON object matching this schema:\n" + json.dumps(schema)
    content = [{"type": "text", "text": instruction}]
    for image in images:
        encoded = base64.b64encode(image.read_bytes()).decode("ascii")
        if anthropic:
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": encoded}})
        else:
            content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + encoded}})
    body = {"model": model, "messages": [{"role": "user", "content": content}]}
    budget = os.environ.get("AI_MAX_TOKENS")
    if anthropic or budget:
        body["max_tokens" if anthropic else "max_completion_tokens"] = int(budget or 8192)
    request = Request(base + ("/messages" if anthropic else "/chat/completions"),
                      data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with build_opener(NoRedirect()).open(request, timeout=180) as response:
            payload = json.load(response)
    except HTTPError as exc:
        code = {401:"AUTH_REQUIRED", 403:"AUTH_REQUIRED", 429:"RATE_LIMIT"}.get(exc.code, "API_FAILED")
        if exc.code == 429:
            try:
                error = json.loads(exc.read(65536)).get("error", {})
                if isinstance(error, dict) and error.get("code") == "insufficient_quota":
                    code = "QUOTA_EXHAUSTED"
            except (ValueError, AttributeError):
                pass
        raise ModelError(code, f"API trả về HTTP {exc.code}.", retry_seconds(exc.headers)) from None
    except (URLError, TimeoutError, OSError):
        raise ModelError("CONNECTION", "Không kết nối được với API hoặc yêu cầu đã hết thời gian.") from None
    except ValueError:
        raise ModelError("INVALID_OUTPUT", "Phản hồi HTTP chưa phải JSON.") from None
    try:
        if anthropic:
            answer = "".join(block["text"] for block in payload["content"] if block["type"] == "text")
        else:
            answer = payload["choices"][0]["message"]["content"]
        answer = answer.strip()
        if answer.startswith(("```json\n", "```\n")) and answer.endswith("```"):
            answer = answer.split("\n", 1)[1][:-3]
        result = json.loads(answer)
        if not isinstance(result, dict) or type(result.get("driver_present")) is not bool or type(result.get("needs_review")) is not bool:
            raise ValueError()
        if not isinstance(result.get("points"), list) or not isinstance(result.get("review_note"), str):
            raise ValueError()
        return result
    except (KeyError, IndexError, ValueError, TypeError, AttributeError):
        raise ModelError("INVALID_OUTPUT", "Model cần trả đủ JSON theo cấu trúc landmark. Kiểm tra model và giới hạn đầu ra.") from None
