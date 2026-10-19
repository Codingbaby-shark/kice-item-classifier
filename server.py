import base64
import datetime
import http.server
import json
import os
import socketserver
import ssl
import threading
import traceback
import urllib.parse
import urllib.request
from typing import Any, Dict, List

from analyzer import (
    build_system_prompt,
    call_anthropic_api_analysis,
    call_claude_cli_analysis,
    call_codex_cli_analysis,
    call_gemini_analysis,
    call_openai_api_analysis,
    check_cli_sessions,
)
from parsers import parse_hwp_bytes, parse_hwpx_bytes

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STATIC_DIR = os.path.join(BASE_DIR, "static")

FRAMEWORKS_PATH = os.path.join(DATA_DIR, "kice_frameworks.json")
SAMPLES_PATH = os.path.join(DATA_DIR, "sample_exams.json")
HISTORY_PATH = os.path.join(DATA_DIR, "history.json")
LOGGING_CONFIG_PATH = os.path.join(DATA_DIR, "logging_config.json")
USAGE_LOGS_PATH = os.path.join(DATA_DIR, "usage_logs.jsonl")

KST = datetime.timezone(datetime.timedelta(hours=9))


def now_kst_str() -> str:
    return datetime.datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")


def load_json_file(path: str, default: Any) -> Any:
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json_file(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_google_sheet_webhook_url() -> str:
    env_url = os.environ.get("GOOGLE_SHEET_WEBHOOK_URL", "").strip()
    if env_url:
        return env_url
    cfg = load_json_file(LOGGING_CONFIG_PATH, {})
    return str(cfg.get("webhook_url", "")).strip()


def summarize_user_agent(ua: str) -> str:
    if not ua:
        return "Unknown"
    os_name = "Other"
    if "Macintosh" in ua or "Mac OS" in ua:
        os_name = "Mac"
    elif "Windows" in ua:
        os_name = "Windows"
    elif "iPhone" in ua or "iPad" in ua:
        os_name = "iOS"
    elif "Android" in ua:
        os_name = "Android"
    elif "Linux" in ua:
        os_name = "Linux"

    browser = "Browser"
    if "Edg/" in ua:
        browser = "Edge"
    elif "Chrome/" in ua and "Safari/" in ua:
        browser = "Chrome"
    elif "Safari/" in ua and "Chrome/" not in ua:
        browser = "Safari"
    elif "Firefox/" in ua:
        browser = "Firefox"
    return f"{os_name} / {browser}"


def _post_to_google_sheet_sync(webhook_url: str, entry: Dict[str, Any]) -> bool:
    if not webhook_url or not webhook_url.startswith("https://"):
        return False
    try:
        ssl_ctx = ssl.create_default_context(
            cafile="/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None
        )
        payload = json.dumps(entry, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            webhook_url,
            data=payload,
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8, context=ssl_ctx) as resp:
            _ = resp.read()
        return True
    except Exception as e:
        print(f"[UsageLog Webhook Warning] {e}")
        return False


def record_usage_event(entry: Dict[str, Any], sync: bool = False) -> bool:
    """Append usage event to local JSONL file and send asynchronously to Google Sheets webhook."""
    os.makedirs(DATA_DIR, exist_ok=True)
    entry.setdefault("timestamp", now_kst_str())
    try:
        with open(USAGE_LOGS_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass

    webhook_url = get_google_sheet_webhook_url()
    if not webhook_url:
        return False

    if sync:
        return _post_to_google_sheet_sync(webhook_url, entry)
    else:
        t = threading.Thread(
            target=_post_to_google_sheet_sync,
            args=(webhook_url, entry),
            daemon=True,
        )
        t.start()
        return True


def read_recent_usage_logs(limit: int = 100) -> List[Dict[str, Any]]:
    if not os.path.exists(USAGE_LOGS_PATH):
        return []
    try:
        with open(USAGE_LOGS_PATH, "r", encoding="utf-8") as f:
            lines = f.readlines()
        out = []
        for line in reversed(lines[-limit:]):
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
        return out
    except Exception:
        return []


class CSATRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def _send_json(self, status_code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> Dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            return {}
        raw = self.rfile.read(content_length)
        return json.loads(raw.decode("utf-8"))

    def _get_client_meta(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        ip = forwarded or (self.client_address[0] if self.client_address else "local")
        ua_summary = summarize_user_agent(self.headers.get("User-Agent", ""))
        return f"{ua_summary} ({ip})"

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path

        if route == "/api/frameworks":
            fw = load_json_file(FRAMEWORKS_PATH, {})
            self._send_json(200, {"ok": True, "data": fw})
            return

        if route == "/api/samples":
            samples = load_json_file(SAMPLES_PATH, {"samples": []})
            self._send_json(200, {"ok": True, "data": samples})
            return

        if route == "/api/history":
            history = load_json_file(HISTORY_PATH, {"reports": []})
            self._send_json(200, {"ok": True, "data": history})
            return

        if route == "/api/admin/logs":
            webhook_url = get_google_sheet_webhook_url()
            logs = read_recent_usage_logs(100)
            self._send_json(
                200,
                {
                    "ok": True,
                    "webhook_url": webhook_url,
                    "has_env_webhook": bool(os.environ.get("GOOGLE_SHEET_WEBHOOK_URL", "").strip()),
                    "logs": logs,
                },
            )
            return

        if route == "/api/env":
            gemini_key = os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")
            openai_key = os.environ.get("OPENAI_API_KEY", "")
            anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
            cli_sessions = check_cli_sessions()
            self._send_json(
                200,
                {
                    "ok": True,
                    "has_env_api_key": bool(gemini_key or openai_key or anthropic_key),
                    "env_keys": {
                        "gemini": bool(gemini_key),
                        "openai": bool(openai_key),
                        "anthropic": bool(anthropic_key),
                    },
                    "cli_sessions": cli_sessions,
                },
            )
            return

        if route == "/" or route == "":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path

        try:
            # Silent Client Telemetry Endpoint (100% invisible to regular users)
            if route == "/api/t":
                body = self._read_json_body()
                entry = {
                    "timestamp": now_kst_str(),
                    "visitor_id": str(body.get("vid", "anon"))[:32],
                    "event": str(body.get("event", "활동"))[:80],
                    "grade_curriculum": str(body.get("grade_curriculum", ""))[:60],
                    "subject": str(body.get("subject", ""))[:80],
                    "exam_title": str(body.get("exam_title", ""))[:120],
                    "item_count": body.get("item_count", ""),
                    "provider": str(body.get("provider", ""))[:40],
                    "detail": str(body.get("detail", ""))[:200],
                    "client": self._get_client_meta(),
                }
                record_usage_event(entry, sync=False)
                self._send_json(200, {"ok": True})
                return

            # Owner-only Admin Configuration for Google Sheets Logging
            if route == "/api/admin/config":
                body = self._read_json_body()
                action = body.get("action", "save")
                webhook_url = str(body.get("webhook_url", "")).strip()
                cfg = load_json_file(LOGGING_CONFIG_PATH, {})
                cfg["webhook_url"] = webhook_url
                save_json_file(LOGGING_CONFIG_PATH, cfg)

                sent_ok = False
                if action == "test" and webhook_url:
                    test_entry = {
                        "timestamp": now_kst_str(),
                        "visitor_id": "admin_test",
                        "event": "✅ 구글 시트 연동 테스트",
                        "grade_curriculum": "고3 · N수생 (2015 개정)",
                        "subject": "수학 영역 (미적분)",
                        "exam_title": "구글 시트 자동 기록 연동 확인용 테스트",
                        "item_count": 30,
                        "provider": "admin_test",
                        "detail": "정상적으로 시트에 기록되었습니다!",
                        "client": self._get_client_meta(),
                    }
                    sent_ok = record_usage_event(test_entry, sync=True)

                self._send_json(
                    200,
                    {
                        "ok": True,
                        "webhook_url": webhook_url,
                        "test_sent": sent_ok,
                    },
                )
                return

            if route == "/api/parse-document":
                body = self._read_json_body()
                filename = body.get("filename", "document.hwp")
                b64_data = body.get("data_base64", "")
                if not b64_data:
                    self._send_json(400, {"ok": False, "error": "파일 데이터가 비어 있습니다."})
                    return

                raw_bytes = base64.b64decode(b64_data)
                lower_name = filename.lower()
                if lower_name.endswith(".hwpx"):
                    parsed_doc = parse_hwpx_bytes(raw_bytes, filename)
                elif lower_name.endswith(".hwp"):
                    parsed_doc = parse_hwp_bytes(raw_bytes, filename)
                else:
                    text = raw_bytes.decode("utf-8", errors="ignore")
                    parsed_doc = {
                        "file_type": "text",
                        "filename": filename,
                        "text": text,
                        "equation_count": 0,
                        "equations": [],
                        "embedded_images": [],
                        "char_count": len(text),
                    }

                self._send_json(200, {"ok": True, "document": parsed_doc})
                return

            if route == "/api/frameworks":
                body = self._read_json_body()
                new_fw = body.get("frameworks")
                if not new_fw or "subjects" not in new_fw:
                    self._send_json(400, {"ok": False, "error": "유효하지 않은 평가틀 데이터입니다."})
                    return
                save_json_file(FRAMEWORKS_PATH, new_fw)
                self._send_json(200, {"ok": True, "message": "평가틀이 저장되었습니다."})
                return

            if route == "/api/build-prompt":
                body = self._read_json_body()
                subject_id = body.get("subject_id", "math")
                grade_id = body.get("grade_id", "grade3")
                curriculum_id = "2015" if grade_id == "grade3" else "2022"
                target_range = body.get("target_range", "")
                custom_instruction = body.get("custom_instruction", "")
                selected_elective = body.get("selected_elective", "")
                custom_subject_framework = body.get("subject_framework")

                fw_db = load_json_file(FRAMEWORKS_PATH, {})
                common_guidelines = fw_db.get("guidelines_common", {})
                subjects_map = fw_db.get("subjects", {})
                subject_framework = custom_subject_framework or subjects_map.get(subject_id)

                if not subject_framework:
                    self._send_json(
                        400,
                        {"ok": False, "error": f"선택한 과목({subject_id})의 평가틀을 찾을 수 없습니다."},
                    )
                    return

                sys_prompt = build_system_prompt(
                    common_guidelines=common_guidelines,
                    subject_framework=subject_framework,
                    curriculum_id=curriculum_id,
                    grade_id=grade_id,
                    target_range=target_range,
                    custom_instruction=custom_instruction,
                    selected_elective=selected_elective,
                )
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "system_prompt": sys_prompt,
                        "subject_name": subject_framework.get("name", subject_id),
                    },
                )
                return

            if route == "/api/analyze":
                body = self._read_json_body()
                provider = body.get("provider", "codex")
                api_key = body.get("api_key", "").strip()
                model_name = body.get("model_name", "")
                subject_id = body.get("subject_id", "math")
                grade_id = body.get("grade_id", "grade3")
                curriculum_id = "2015" if grade_id == "grade3" else "2022"
                selected_elective = body.get("selected_elective", "")
                exam_title = body.get("exam_title", "수능/모의고사 문항 분류 분석")
                raw_text = body.get("raw_text", "")
                target_range = body.get("target_range", "")
                custom_instruction = body.get("custom_instruction", "")
                media_parts = body.get("media_parts", [])
                custom_subject_framework = body.get("subject_framework")

                fw_db = load_json_file(FRAMEWORKS_PATH, {})
                common_guidelines = fw_db.get("guidelines_common", {})
                subjects_map = fw_db.get("subjects", {})
                subject_framework = custom_subject_framework or subjects_map.get(subject_id)

                if not subject_framework:
                    self._send_json(
                        400,
                        {"ok": False, "error": f"선택한 과목({subject_id})의 평가틀을 찾을 수 없습니다."},
                    )
                    return

                if not raw_text.strip() and not media_parts:
                    self._send_json(
                        400,
                        {"ok": False, "error": "분석할 시험지 파일(PDF/이미지/HWP)이나 문항 텍스트를 입력해 주세요."},
                    )
                    return

                sys_prompt = build_system_prompt(
                    common_guidelines=common_guidelines,
                    subject_framework=subject_framework,
                    curriculum_id=curriculum_id,
                    grade_id=grade_id,
                    target_range=target_range,
                    custom_instruction=custom_instruction,
                    selected_elective=selected_elective,
                )

                if provider == "codex":
                    result = call_codex_cli_analysis(
                        model_name=model_name,
                        system_prompt=sys_prompt,
                        exam_title=exam_title,
                        raw_text=raw_text,
                        media_parts=media_parts,
                        workspace_dir=BASE_DIR,
                    )
                elif provider == "claude":
                    result = call_claude_cli_analysis(
                        model_name=model_name,
                        system_prompt=sys_prompt,
                        exam_title=exam_title,
                        raw_text=raw_text,
                        media_parts=media_parts,
                        workspace_dir=BASE_DIR,
                    )
                elif provider == "openai":
                    if not api_key:
                        api_key = os.environ.get("OPENAI_API_KEY", "")
                    result = call_openai_api_analysis(
                        api_key=api_key,
                        model_name=model_name or "gpt-4o",
                        system_prompt=sys_prompt,
                        exam_title=exam_title,
                        raw_text=raw_text,
                        media_parts=media_parts,
                    )
                elif provider == "anthropic":
                    if not api_key:
                        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
                    result = call_anthropic_api_analysis(
                        api_key=api_key,
                        model_name=model_name or "claude-sonnet-4-20250514",
                        system_prompt=sys_prompt,
                        exam_title=exam_title,
                        raw_text=raw_text,
                        media_parts=media_parts,
                    )
                else:
                    if not api_key:
                        api_key = os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")
                    result = call_gemini_analysis(
                        api_key=api_key,
                        model_name=model_name or "gemini-2.5-flash",
                        system_prompt=sys_prompt,
                        exam_title=exam_title,
                        raw_text=raw_text,
                        media_parts=media_parts,
                    )

                curriculums_map = common_guidelines.get("curriculums", {})
                grades_map = common_guidelines.get("grade_levels", {})

                result["exam_title"] = result.get("exam_title") or exam_title
                result["subject_id"] = subject_id
                result["subject_name"] = subject_framework.get("name", subject_id)
                result["curriculum_id"] = curriculum_id
                result["curriculum_name"] = curriculums_map.get(curriculum_id, {}).get(
                    "name", f"{curriculum_id} 개정 교육과정"
                )
                result["target_grade"] = grades_map.get(grade_id, {}).get("name", grade_id)
                result["analyzed_at"] = datetime.datetime.now(KST).strftime("%Y-%m-%d %H:%M")

                history = load_json_file(HISTORY_PATH, {"reports": []})
                report_entry = {
                    "id": f"rep_{int(datetime.datetime.now().timestamp() * 1000)}",
                    "created_at": result["analyzed_at"],
                    "exam_title": result["exam_title"],
                    "subject_id": result["subject_id"],
                    "subject_name": result["subject_name"],
                    "curriculum_name": result["curriculum_name"],
                    "target_grade": result["target_grade"],
                    "item_count": len(result.get("items", [])),
                    "report": result,
                }
                history.setdefault("reports", []).insert(0, report_entry)
                history["reports"] = history["reports"][:30]
                save_json_file(HISTORY_PATH, history)

                self._send_json(
                    200, {"ok": True, "report": result, "history_id": report_entry["id"]}
                )
                return

            if route == "/api/history/save":
                body = self._read_json_body()
                report = body.get("report")
                if not report:
                    self._send_json(400, {"ok": False, "error": "저장할 리포트 데이터가 없습니다."})
                    return
                history = load_json_file(HISTORY_PATH, {"reports": []})
                report_entry = {
                    "id": f"rep_{int(datetime.datetime.now().timestamp() * 1000)}",
                    "created_at": datetime.datetime.now(KST).strftime("%Y-%m-%d %H:%M"),
                    "exam_title": report.get("exam_title", "분석 리포트"),
                    "subject_id": report.get("subject_id", "math"),
                    "subject_name": report.get("subject_name", "수학 영역"),
                    "curriculum_name": report.get("curriculum_name", "2015 개정 교육과정"),
                    "target_grade": report.get("target_grade", "고3 · N수생"),
                    "item_count": len(report.get("items", [])),
                    "report": report,
                }
                history.setdefault("reports", []).insert(0, report_entry)
                history["reports"] = history["reports"][:30]
                save_json_file(HISTORY_PATH, history)
                self._send_json(200, {"ok": True, "entry": report_entry})
                return

            if route == "/api/history/delete":
                body = self._read_json_body()
                report_id = body.get("id")
                idx = body.get("index")
                history = load_json_file(HISTORY_PATH, {"reports": []})
                reports = history.get("reports", [])
                if report_id:
                    reports = [r for r in reports if r.get("id") != report_id]
                elif isinstance(idx, int) and 0 <= idx < len(reports):
                    reports.pop(idx)
                history["reports"] = reports
                save_json_file(HISTORY_PATH, history)
                self._send_json(200, {"ok": True, "reports": reports})
                return

            self._send_json(404, {"ok": False, "error": f"Unknown API endpoint: {route}"})

        except Exception as e:
            traceback.print_exc()
            self._send_json(500, {"ok": False, "error": str(e)})


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run_server(port: int = 8080, host: str = "0.0.0.0") -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(STATIC_DIR, exist_ok=True)
    server = ThreadedHTTPServer((host, port), CSATRequestHandler)
    print(f"============================================================")
    print(f" KICE 수능 출제 지침 기반 문항 분류·평가 시스템 서버 가동 중")
    print(f" 로컬 접속 주소: http://localhost:{port}")
    print(f" 관리자 로그 설정 주소 (소유자 전용): http://localhost:{port}/?admin=1")
    print(f"============================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
        server.server_close()


if __name__ == "__main__":
    import sys

    default_port = int(os.environ.get("PORT", "8080"))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else default_port
    run_server(port)
