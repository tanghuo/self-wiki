"""Self Wiki host for the pinned chatgpt-imagegen web backend (JSON lines)."""
import argparse
import importlib.machinery
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time


def emit(kind, **data):
    print(json.dumps({"type": kind, **data}, ensure_ascii=False), flush=True)


def load_backend():
    source = Path(__file__).parent / "vendor" / "chatgpt-imagegen" / "chatgpt-imagegen"
    loader = importlib.machinery.SourceFileLoader("self_wiki_imagegen", str(source))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class BrowserProcess:
    """Run the configured browser CLI with UTF-8 pipes and cooperative cancellation."""
    def __init__(self, browser, cancelled):
        self.browser = browser
        self.cancelled = cancelled

    def __getattr__(self, name):
        return getattr(subprocess, name)

    def run(self, command, **kwargs):
        if self.cancelled.is_set() and "close" not in command:
            raise InterruptedError("网页版生图已停止；已提交的网页任务可能仍会完成")
        if str(command[0]) == self.browser and Path(self.browser).suffix.lower() in (".js", ".mjs", ".cjs"):
            command = [os.environ["SELF_WIKI_NODE"], *command]
        # Never invoke a shell with a prompt or local path as shell text.
        if Path(str(command[0])).suffix.lower() in (".cmd", ".bat"):
            raise RuntimeError("请指定 chrome-use.exe 或其 JavaScript 入口路径，不能使用批处理启动器")
        timeout = kwargs.pop("timeout", 30)
        kwargs.pop("capture_output", None)
        kwargs.pop("text", None)
        kwargs.pop("encoding", None)
        kwargs.pop("errors", None)
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        # A newly started chrome-use daemon can inherit the CLI's stdout handles
        # on Windows. communicate() then waits for that long-lived daemon to exit,
        # even after the CLI itself exits. Files let us wait for the CLI only.
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, **kwargs)
            deadline = time.monotonic() + timeout
            try:
                while process.poll() is None:
                    if self.cancelled.is_set() and "close" not in command:
                        raise InterruptedError("网页版生图已停止；已提交的网页任务可能仍会完成")
                    if time.monotonic() >= deadline:
                        raise subprocess.TimeoutExpired(command, timeout)
                    time.sleep(0.05)
            except BaseException:
                process.kill()
                process.wait(timeout=5)
                raise
            stdout.seek(0)
            stderr.seek(0)
            output = stdout.read(40 * 1024 * 1024 + 1)
            if len(output) > 40 * 1024 * 1024:
                raise RuntimeError("浏览器返回内容超过限制")
            return subprocess.CompletedProcess(command, process.returncode, output.decode("utf-8", "replace"), stderr.read(8000).decode("utf-8", "replace"))


class BrowserClock:
    """Wake upstream polling immediately so cancellation can close its tab."""
    def __init__(self, cancelled):
        self.cancelled = cancelled

    def __getattr__(self, name):
        return getattr(time, name)

    def sleep(self, seconds):
        if self.cancelled.wait(seconds):
            raise InterruptedError("网页版生图已停止；已提交的网页任务可能仍会完成")


def main():
    request = json.loads(sys.stdin.readline())
    cancelled = threading.Event()

    def watch_cancel():
        # Host closes stdin or sends a cancellation line when the owning turn ends.
        sys.stdin.readline()
        cancelled.set()

    threading.Thread(target=watch_cancel, daemon=True).start()
    backend = load_backend()
    browser = request["browser"]
    browser = str(Path(browser).resolve()) if Path(browser).is_file() else shutil.which(browser)
    if not browser:
        raise RuntimeError("未找到 chrome-use，请安装并连接已登录 ChatGPT 的 Chrome，或在设置中填写程序路径")
    backend.subprocess = BrowserProcess(browser, cancelled)
    backend.time = BrowserClock(cancelled)
    backend._find_agent_browser = lambda: browser
    # The app supplies an explicit profile/relay; do not scan or copy cookie databases.
    backend._detect_logged_in_profiles = lambda *args, **kwargs: []
    backend._fmt_progress = lambda elapsed, message: progress(message)
    prepared_prompt = ""
    submitted = False
    initial_users = 0
    conversation_url = request.get("conversationUrl", "")
    known_url = ""
    if conversation_url and not re.fullmatch(r"https://chatgpt\.com/c/[a-zA-Z0-9-]+", conversation_url):
        raise RuntimeError("无效的网页会话地址")
    # Reuse the pinned backend's normal open/cleanup path with an explicit target.
    if conversation_url:
        backend.WEB_NEW_CHAT_URL = conversation_url

    def remember_url(url):
        nonlocal known_url
        if isinstance(url, str) and re.fullmatch(r"https://chatgpt\.com/c/[a-zA-Z0-9-]+", url) and url != known_url:
            if conversation_url and url != conversation_url:
                raise RuntimeError("网页跳转到了其他会话，已停止本轮请求")
            known_url = url
            emit("conversation", url=url)

    def check_cancel():
        if cancelled.is_set():
            raise InterruptedError("网页版生图已停止；已提交的网页任务可能仍会完成")

    def progress(message):
        check_cancel()
        if message.startswith("warning: composer did not clear"):
            raise backend.GatewayError("未能确认网页收到提示词，已停止等待；请查看 ChatGPT 页面后再决定是否重试")
        emit("progress", message=message)
        return ""

    original_command = backend._ab

    def command(ab, *arguments, session, timeout, profile=None):
        raw = original_command(ab, *arguments, "--json", session=session, timeout=timeout, profile=profile)
        try:
            result = json.loads(raw)
        except ValueError:
            raise backend.GatewayError("chrome-use 未返回有效 JSON；请检查程序版本") from None
        if isinstance(result, dict) and result.get("success") is False:
            raise backend.GatewayError("浏览器操作失败：" + str(result.get("error"))[:1000])
        return raw

    def evaluate(ab, js, session, timeout):
        nonlocal submitted
        confirmation = "t.trim().length===0" in js
        polling = "const seen = new Set(" in js
        if polling:
            js = """(() => {
              const state = JSON.parse(%s);
              const text = document.body?.innerText || '';
              state.pageFailure = !document.querySelector('main') && /Content failed to load|Application error|Unable to load conversation/i.test(text);
              state.pageUrl = location.href;
              const user = [...document.querySelectorAll('[data-message-author-role="user"]')].at(-1);
              const afterUser = node => !!user && !!(user.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
              const lastAssistant = [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(afterUser).at(-1);
              state.assistant = !!lastAssistant;
              state.atext = lastAssistant?.textContent?.trim().slice(0, 240) || '';
              if (state.last && ![...document.querySelectorAll('main img')].some(i => afterUser(i) && !i.closest('[data-message-author-role="user"]') && (i.currentSrc || i.src) === state.last)) state.last = null;
              return JSON.stringify(state);
            })()""" % js
        if confirmation:
            # Confirm the actual message on the page, not an empty or missing
            # composer. This also avoids mistaking failed typing for submission.
            js = """(() => {
              const normalize = value => (value || '').replace(/\\s+/g, '');
              const expected = normalize(%s);
              const user = [...document.querySelectorAll('[data-message-author-role="user"]')].at(-1);
              const count = document.querySelectorAll('[data-message-author-role="user"]').length;
              return JSON.stringify(count > %d && !!user && normalize(user.innerText).includes(expected));
            })()""" % (json.dumps(prepared_prompt), initial_users)
        result = json.loads(command(ab, "eval", js, session=session, timeout=timeout))
        if isinstance(result, dict) and "success" in result:
            data = result.get("data")
            if not isinstance(data, dict) or "result" not in data:
                raise backend.GatewayError("chrome-use eval 返回缺少 data.result")
            result = data["result"]
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except ValueError:
                pass
        if polling and isinstance(result, dict):
            remember_url(result.get("pageUrl"))
        if polling and isinstance(result, dict) and result.get("pageFailure"):
            # RuntimeError is intentional: upstream retries GatewayError during
            # polling, which would hide a terminal page failure for 30 minutes.
            raise RuntimeError("ChatGPT 页面内容加载失败，已停止等待。请求已提交，请重新加载原网页查看结果：" + str(result.get("pageUrl", "https://chatgpt.com/")))
        if confirmation and result is True and not submitted:
            submitted = True
            emit("submitted", message="已确认 ChatGPT 收到提示词，等待生成图片")
            remember_url(evaluate(ab, "JSON.stringify(location.href)", session, timeout))
        return result

    backend._ab = command
    backend._ab_eval = evaluate
    original_generate = backend._generate_in_browser

    def generate_in_conversation(ab, session, user_text, args, deadline, remaining, report, refs=None):
        nonlocal initial_users
        state = evaluate(ab, """(() => {
          const users = document.querySelectorAll('[data-message-author-role="user"]');
          return JSON.stringify({ conversationGuard: true, url: location.href, users: users.length,
            busy: !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i]'),
            draft: document.querySelector('#prompt-textarea')?.textContent?.trim() || '',
            failed: /Content failed to load|Unable to load conversation/i.test(document.body?.innerText || '') });
        })()""", session, min(20.0, remaining()))
        if not isinstance(state, dict) or state.get("failed"):
            raise RuntimeError("网页会话未能加载，未发送本轮消息")
        if conversation_url and (state.get("url") != conversation_url or not state.get("users")):
            raise RuntimeError("无法恢复已绑定的网页会话，未发送本轮消息；请检查网页登录和会话是否仍存在")
        if state.get("busy") or state.get("draft"):
            raise RuntimeError("网页仍在生成或有未发送草稿，未发送本轮消息；请先在网页处理")
        initial_users = state.get("users", 0)
        if conversation_url:
            remember_url(state.get("url"))
            report("已恢复当前会话对应的 ChatGPT 网页对话")
        return original_generate(ab, session, user_text, args, deadline, remaining, report, refs=refs)

    backend._generate_in_browser = generate_in_conversation

    # Preserve the user's actual prompt and each reference's stated role; upstream's
    # character/style prompt framing is intended for its separate asset library.
    def build_prompt(prompt, size, **kwargs):
        nonlocal prepared_prompt
        text = prompt if request.get("verbatim") else "请使用图片生成功能完成以下要求，生成一张图片。参考图片的用途以要求为准。\n" + prompt
        if not request.get("verbatim") and size != "auto":
            text += "\n期望画幅：" + size
        prepared_prompt = text
        emit("prepared_prompt", prompt=text)
        return text

    backend._build_web_text = build_prompt
    def upload(ab, session, paths, remaining, report):
        report(f"正在上传 {len(paths)} 张参考图")
        for index, selector in enumerate(backend._UPLOAD_SELECTORS):
            check_cancel()
            try:
                backend._ab(ab, "upload", selector, *paths, session=session, timeout=min(90.0, remaining()))
                break
            except backend.GatewayError:
                if index == len(backend._UPLOAD_SELECTORS) - 1:
                    raise
        # Unlike upstream's best-effort single-thumbnail check, require every
        # reference before allowing a prompt to leave the composer.
        for _ in range(15):
            check_cancel()
            count = backend._ab_eval(ab, backend._JS_PENDING_UPLOADS, session=session, timeout=min(10.0, remaining()))
            if isinstance(count, int) and count >= len(paths):
                backend.time.sleep(2)
                check_cancel()
                report("参考图已全部上传")
                return
            backend.time.sleep(1)
        raise backend.GatewayError("参考图片未全部上传成功，未提交生图请求；请检查网页连接后重试")

    backend._upload_references = upload
    if request["profile"] in ("relay", "current", "off") and not backend._relay_connected(browser):
        raise RuntimeError("chrome-use 已安装，但 Chrome 扩展尚未连接；请连接扩展并登录 ChatGPT")
    if request.get("operation") == "probe":
        result = backend.subprocess.run([browser, "--version"], capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise RuntimeError("chrome-use 无法启动：" + (result.stderr or result.stdout)[-500:])
        emit("result", version=result.stdout.strip(), message="网页版执行器已就绪；ChatGPT 登录状态会在生成时检查")
        return
    args = argparse.Namespace(gen_prompt=request["prompt"], size=request["size"], session=request["session"],
                              profile=request["profile"], project="", timeout=1800,
                              keep_conversation=True, keep_tab=False, n_character_refs=0,
                              n_style_refs=0, n_composition_refs=0)
    check_cancel()
    data, metadata = backend.run_web(args, True, time.monotonic(), refs=request["referencePaths"])
    check_cancel()
    if not known_url:
        raise RuntimeError("网页未返回可保存的会话地址，无法确认后续续聊；请检查网页结果")
    if not data or len(data) > 25 * 1024 * 1024:
        raise RuntimeError("网页生成的图片为空或超过 25 MiB")
    with open(request["output"], "xb") as output:
        output.write(data)
    emit("result", path=request["output"], bytes=len(data), contentType=metadata.get("content_type"))


if __name__ == "__main__":
    try:
        main()
    except (Exception, SystemExit) as error:
        emit("error", message=str(error)[:2000])
        sys.exit(1)
