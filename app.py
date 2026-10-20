import base64
import datetime
import json
import mimetypes
import os
import traceback
from typing import Any, Callable, Dict, Iterable, List, Tuple

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
from server import (
    BASE_DIR,
    DATA_DIR,
    FRAMEWORKS_PATH,
    HISTORY_PATH,
    KST,
    LOGGING_CONFIG_PATH,
    SAMPLES_PATH,
    STATIC_DIR,
    get_google_sheet_webhook_url,
    load_json_file,
    now_kst_str,
    read_recent_usage_logs,
    record_usage_event,
    run_server,
    save_json_file,
    summarize_user_agent,
)


def _json_response(
    start_response: Callable, status_code: int, payload: Dict[str, Any]
) -> Iterable[bytes]:
    status_map = {
        200: "200 OK",
        400: "400 Bad Request",
        404: "404 Not Found",
        500: "500 Internal Server Error",
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers: List[Tuple[str, str]] = [
        ("Content-Type", "application/json; charset=utf-8"),
        ("Content-Length", str(len(body))),
        ("Cache-Control", "no-store"),
    ]
    start_response(status_map.get(status_code, f"{status_code} OK"), headers)
    return [body]


def _client_meta_from_environ(environ: Dict[str, Any]) -> str:
    forwarded = str(environ.get("HTTP_X_FORWARDED_FOR", "")).split(",")[0].strip()
    ip = forwarded or str(environ.get("REMOTE_ADDR", "remote"))
    ua = str(environ.get("HTTP_USER_AGENT", ""))
    return f"{summarize_user_agent(ua)} ({ip})"


def app(environ: Dict[str, Any], start_response: Callable) -> Iterable[bytes]:
    """WSGI application entrypoint for `gunicorn app:app` on Render / Cloudtype / Railway."""
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(STATIC_DIR, exist_ok=True)

    method = environ.get("REQUEST_METHOD", "GET").upper()
    route = environ.get("PATH_INFO", "/") or "/"

    if method in ("GET", "HEAD"):
        is_head = method == "HEAD"
        if route == "/api/frameworks":
            fw = load_json_file(FRAMEWORKS_PATH, {})
            return _json_response(start_response, 200, {"ok": True, "data": fw})

        if route == "/api/samples":
            samples = load_json_file(SAMPLES_PATH, {"samples": []})
            return _json_response(start_response, 200, {"ok": True, "data": samples})

        if route == "/api/history":
            history = load_json_file(HISTORY_PATH, {"reports": []})
            return _json_response(start_response, 200, {"ok": True, "data": history})

        if route == "/api/admin/logs":
            webhook_url = get_google_sheet_webhook_url()
            logs = read_recent_usage_logs(100)
            return _json_response(
                start_response,
                200,
                {
                    "ok": True,
                    "webhook_url": webhook_url,
                    "has_env_webhook": bool(os.environ.get("GOOGLE_SHEET_WEBHOOK_URL", "").strip()),
                    "logs": logs,
                },
            )

        if route == "/api/env":
            gemini_key = os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")
            openai_key = os.environ.get("OPENAI_API_KEY", "")
            anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
            cli_sessions = check_cli_sessions()
            return _json_response(
                start_response,
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

        # Serve static files
        rel_path = "index.html" if route in ("", "/") else route.lstrip("/")
        safe_path = os.path.normpath(os.path.join(STATIC_DIR, rel_path))
        if not safe_path.startswith(STATIC_DIR) or not os.path.isfile(safe_path):
            safe_path = os.path.join(STATIC_DIR, "index.html")

        try:
            with open(safe_path, "rb") as f:
                data = f.read()
            ctype, _ = mimetypes.guess_type(safe_path)
            if not ctype:
                ctype = "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            start_response(
                "200 OK",
                [
                    ("Content-Type", ctype),
                    ("Content-Length", str(len(data))),
                ],
            )
            return [] if is_head else [data]
        except Exception:
            start_response("404 Not Found", [("Content-Type", "text/plain; charset=utf-8")])
            return [] if is_head else [b"Not Found"]

    if method == "POST":
        try:
            content_length = int(environ.get("CONTENT_LENGTH") or "0")
            raw_body = environ["wsgi.input"].read(content_length) if content_length > 0 else b"{}"
            body = json.loads(raw_body.decode("utf-8")) if raw_body else {}

            if route == "/api/t":
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
                    "client": _client_meta_from_environ(environ),
                }
                record_usage_event(entry, sync=False)
                return _json_response(start_response, 200, {"ok": True})

            if route == "/api/admin/config":
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
                        "client": _client_meta_from_environ(environ),
                    }
                    sent_ok = record_usage_event(test_entry, sync=True)

                return _json_response(
                    start_response,
                    200,
                    {"ok": True, "webhook_url": webhook_url, "test_sent": sent_ok},
                )

            if route == "/api/parse-document":
                filename = body.get("filename", "document.hwp")
                b64_data = body.get("data_base64", "")
                if not b64_data:
                    return _json_response(start_response, 400, {"ok": False, "error": "파일 데이터가 비어 있습니다."})
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
                return _json_response(start_response, 200, {"ok": True, "document": parsed_doc})

            if route == "/api/frameworks":
                new_fw = body.get("frameworks")
                if not new_fw or "subjects" not in new_fw:
                    return _json_response(start_response, 400, {"ok": False, "error": "유효하지 않은 평가틀 데이터입니다."})
                save_json_file(FRAMEWORKS_PATH, new_fw)
                return _json_response(start_response, 200, {"ok": True, "message": "평가틀이 저장되었습니다."})

            if route == "/api/build-prompt":
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
                    return _json_response(
                        start_response,
                        400,
                        {"ok": False, "error": f"선택한 과목({subject_id})의 평가틀을 찾을 수 없습니다."},
                    )
                sys_prompt = build_system_prompt(
                    common_guidelines=common_guidelines,
                    subject_framework=subject_framework,
                    curriculum_id=curriculum_id,
                    grade_id=grade_id,
                    target_range=target_range,
                    custom_instruction=custom_instruction,
                    selected_elective=selected_elective,
                )
                return _json_response(
                    start_response,
                    200,
                    {
                        "ok": True,
                        "system_prompt": sys_prompt,
                        "subject_name": subject_framework.get("name", subject_id),
                    },
                )

            if route == "/api/analyze":
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
                    return _json_response(
                        start_response,
                        400,
                        {"ok": False, "error": f"선택한 과목({subject_id})의 평가틀을 찾을 수 없습니다."},
                    )
                if not raw_text.strip() and not media_parts:
                    return _json_response(
                        start_response,
                        400,
                        {"ok": False, "error": "분석할 시험지 파일(PDF/이미지/HWP)이나 문항 텍스트를 입력해 주세요."},
                    )

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
                        model_name=model_name or "gemini-3.5-flash",
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

                return _json_response(
                    start_response,
                    200,
                    {"ok": True, "report": result, "history_id": report_entry["id"]},
                )

            if route == "/api/history/save":
                report = body.get("report")
                if not report:
                    return _json_response(start_response, 400, {"ok": False, "error": "저장할 리포트 데이터가 없습니다."})
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
                return _json_response(start_response, 200, {"ok": True, "entry": report_entry})

            if route == "/api/history/delete":
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
                return _json_response(start_response, 200, {"ok": True, "reports": reports})

            return _json_response(start_response, 404, {"ok": False, "error": f"Unknown API endpoint: {route}"})
        except Exception as e:
            traceback.print_exc()
            return _json_response(start_response, 500, {"ok": False, "error": str(e)})

    return _json_response(start_response, 404, {"ok": False, "error": "Method not allowed"})


if __name__ == "__main__":
    import sys

    default_port = int(os.environ.get("PORT", "8080"))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else default_port
    run_server(port)
