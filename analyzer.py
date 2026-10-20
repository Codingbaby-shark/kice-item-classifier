import base64
import datetime
import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from parsers import decode_kice_pua_text


EXTRA_BIN_PATHS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS",
    "/Applications/Codex.app/Contents/Resources/app/bin",
    os.path.expanduser("~/.local/bin"),
    os.path.expanduser("~/.npm-global/bin"),
]


def get_augmented_env() -> Dict[str, str]:
    env = os.environ.copy()
    current_path = env.get("PATH", "")
    path_parts = [p for p in EXTRA_BIN_PATHS if os.path.isdir(p)]
    if current_path:
        path_parts.append(current_path)
    env["PATH"] = ":".join(path_parts)
    return env


def find_cli_binary(name: str) -> Optional[str]:
    env = get_augmented_env()
    found = shutil.which(name, path=env.get("PATH"))
    if found:
        return found
    for d in EXTRA_BIN_PATHS:
        candidate = os.path.join(d, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def check_cli_sessions() -> Dict[str, Any]:
    """
    Detect installed Codex CLI and Claude Code CLI binaries and local auth token files on macOS.
    If not installed, users can freely use Direct API Keys (Gemini / OpenAI / Claude API)
    or the Web Browser Copy-Paste Bridge without installing any PC CLI program.
    """
    codex_bin = find_cli_binary("codex")
    claude_bin = find_cli_binary("claude")

    codex_auth_file = os.path.expanduser("~/.codex/auth.json")
    codex_logged_in = bool(codex_bin and os.path.isfile(codex_auth_file))

    claude_config_dir = os.path.expanduser("~/.claude")
    claude_json = os.path.expanduser("~/.claude.json")
    claude_logged_in = bool(
        claude_bin and (os.path.isdir(claude_config_dir) or os.path.isfile(claude_json))
    )

    return {
        "codex": {
            "installed": bool(codex_bin),
            "binary_path": codex_bin or "",
            "logged_in": codex_logged_in,
            "auth_source": "~/.codex/auth.json (로컬 ChatGPT/Codex 앱 인증 토큰)",
            "label": "로컬 Codex 구독 세션",
        },
        "claude": {
            "installed": bool(claude_bin),
            "binary_path": claude_bin or "",
            "logged_in": claude_logged_in,
            "auth_source": "~/.claude (로컬 Claude Code 인증 토큰)",
            "label": "로컬 Claude 구독 세션",
        },
    }


RESPONSE_SCHEMA_DESCRIPTION = """
반드시 아래 JSON 스키마 구조를 정확히 따르는 단일 JSON 객체만 출력하십시오(마크다운 코드블록 없이 순수 JSON만 출력, 각 해설 필드는 핵심만 1~2문장으로 간결하게 작성):
{
  "exam_title": "시험지 제목",
  "subject_id": "과목 ID",
  "subject_name": "과목명",
  "curriculum_id": "2015 또는 2022",
  "curriculum_name": "적용 교육과정명 (예: 2015 개정 교육과정 / 2022 개정 교육과정)",
  "target_grade": "대상 학년 (예: 고3 · N수생 (2015 개정) / 고2 (2022 개정) / 고1 (2022 개정))",
  "analyzed_at": "YYYY-MM-DD",
  "overall_evaluation": {
    "summary": "시험 전체 출제 경향 및 종합 총평 (2~3문장)",
    "overall_difficulty": "시험 전체의 체감 난이도 총평 (예: '평이한 수준이나 상위권 변별 문항이 적절히 배치됨 — 전반적인 개념 확인 문항은 무난하나 고배점 추론 문항에서 변별력을 확보함')",
    "challenging_items": [
      {
        "item_number": "어려운 주요 변별 문항 번호 (예: '15', '22', '미적분 30', '19' 등)",
        "topic": "해당 문항의 핵심 단원/소재",
        "reason": "왜 이 문항이 수험생에게 까다롭고 변별력이 높은지 핵심 병목 요인 설명 (1~2문장)"
      }
    ],
    "curriculum_and_grade_review": "대상 학년(고3→15개정, 고1·2→22개정) 교육과정 범위 적합성 총평 (1~2문장)",
    "content_balance_review": "내용영역 간 문항 수·배점 안배 균형성 (1~2문장)",
    "behavioral_balance_review": "행동영역 간 비중 분석 (1~2문장)"
  },
  "items": [
    {
      "item_number": "문항 번호 문자열 (공통과목은 '1'~'22', 선택과목이 있는 경우 '확률과 통계 23', '미적분 23', '사회·문화 1', '생명과학Ⅰ 1' 또는 '1'~'20' 형식으로 표기)",
      "points": 4,
      "question_type": "문항 형태 (예: '5지선다형', '5지선다형 (<보기> 합답형)', '단답형')",
      "stem_summary": "발문 핵심 요약 및 주요 수식 ($...$ LaTeX 표기, 1문장)",
      "content_domain": {
        "major": "대분류 (제시된 교육과정 평가틀의 대분류명과 정확히 일치)",
        "middle": "중분류 (제시된 교육과정 평가틀의 중분류명과 정확히 일치)",
        "topic": "소분류 / 핵심 개념",
        "achievement_standard": "교육과정 성취기준 요약",
        "rationale": "내용영역 분류 근거 (1문장)"
      },
      "behavioral_domain": {
        "primary": "행동영역 (제시된 평가틀의 행동영역 name과 정확히 일치하는 단일 행동영역 1개만 기재)",
        "rationale": "요구되는 핵심 인지 과정 및 행동영역 분류 근거 (1문장)"
      },
      "evaluation": {
        "intent_and_key_idea": "출제 의도 및 핵심 발상 (1~2문장)",
        "bottleneck_and_distractors": "수험생 체감 난도 요인·주요 오답 함정 또는 풀이 시 유의점 (1문장)"
      }
    }
  ]
}
"""


def get_active_content_domains(
    subject_framework: Dict[str, Any],
    curriculum_id: str,
    selected_elective: str = "",
) -> List[Dict[str, Any]]:
    by_curr = subject_framework.get("content_domains_by_curriculum", {})
    domains = (
        by_curr[curriculum_id]
        if curriculum_id in by_curr and isinstance(by_curr[curriculum_id], list)
        else subject_framework.get("content_domains", [])
    )
    if (
        selected_elective
        and selected_elective not in ("ALL_ELECTIVES", "COMMON_ONLY", "")
        and curriculum_id == "2015"
    ):
        subj_id = subject_framework.get("id", "")
        if subj_id in ("social", "science"):
            matched = [d for d in domains if selected_elective in d.get("major", "")]
            if matched:
                return matched
    return domains


def build_system_prompt(
    common_guidelines: Dict[str, Any],
    subject_framework: Dict[str, Any],
    curriculum_id: str = "2015",
    grade_id: str = "grade3",
    target_range: str = "",
    custom_instruction: str = "",
    selected_elective: str = "",
) -> str:
    # Auto-map curriculum from grade if not explicitly overridden
    if grade_id == "grade3":
        curriculum_id = "2015"
    elif grade_id in ("grade1", "grade2"):
        curriculum_id = "2022"

    curriculums_map = common_guidelines.get("curriculums", {})
    curr_info = curriculums_map.get(
        curriculum_id,
        {
            "id": curriculum_id,
            "name": f"{curriculum_id} 개정 교육과정",
            "description": "",
        },
    )

    grades_map = common_guidelines.get("grade_levels", {})
    grade_info = grades_map.get(
        grade_id,
        {
            "id": grade_id,
            "name": "고3 · N수생 (2015 개정)",
            "difficulty_calibration": "",
            "scope_check_rule": "",
        },
    )

    active_content_domains = get_active_content_domains(
        subject_framework, curriculum_id, selected_elective
    )
    content_str = json.dumps(active_content_domains, ensure_ascii=False)
    behavior_str = json.dumps(
        subject_framework.get("behavioral_domains", []), ensure_ascii=False
    )

    prompt = f"""당신은 대한민국 한국교육과정평가원(KICE) 수능 및 전국연합학력평가 출제·검토 위원장입니다.
제공된 시험 문항 데이터를 판독하여 지정된 [대상 학년 및 자동 적용 교육과정]에 맞추어 빠짐없이 문항 분류 및 평가를 수행하십시오.

📌 [분석 기준]
1. 대상 학년 및 적용 교육과정: {grade_info.get('name')} → {curr_info.get('name')} ({curr_info.get('badge', '')})
   - 교육과정 설명: {curr_info.get('description', '')}
   - 이수 범위 점검: {grade_info.get('scope_check_rule', '')}

📌 [분류 및 난이도 평가 핵심 원칙]
1. **단일 행동영역 분류**: KICE 이원목적분류표 기준에 따라 각 문항의 `behavioral_domain.primary`에는 아래 제시된 [{subject_framework.get('name')} 행동영역 체계] 중 **가장 핵심이 되는 단일 행동영역 1개만** 정확히 선택하여 기입하십시오(부 행동영역은 두지 않음).
2. **문항별 상/중/하 등급 및 예상 정답률 산정 생략**: 개별 문항마다 상/중/하 등급이나 예상 정답률을 매기지 마십시오. 대신 `overall_evaluation.overall_difficulty`에서 **시험 전체의 체감 난이도 총평**을 서술하고, `overall_evaluation.challenging_items` 배열에 **이 시험에서 가장 어렵거나 변별력이 높은 주요 고난도 문항(3~6개 내외)과 그 이유**를 구체적으로 분석하십시오.
3. **문항 수 및 선택과목 번호 부여 규칙**:
   - 전달된 데이터에 포함된 **모든 문항을 단 한 문항도 누락하지 말고** 번호 순서대로 분류하십시오.
   - 국어·수학 선택과목(예: 확률과 통계 23~30번, 미적분 23~30번, 기하 23~30번, 화법과 작문 35~45번, 언어와 매체 35~45번)이 함께 들어있는 경우 번호 충돌을 막기 위해 `item_number`를 `"확률과 통계 23"`, `"미적분 23"`과 같이 표기하십시오.
   - 사회탐구·과학탐구 선택과목(과목당 1~20번, 50점 만점)은 단일 선택과목 시험지이면 `"1"`~`"20"`으로, 여러 선택과목이 합쳐진 시험지이면 `"생활과 윤리 1"`, `"생명과학Ⅰ 1"`과 같이 과목명을 포함하여 표기하십시오.
   - 각 문항에 표시된 배점([2점], [3점], [4점])을 정확히 `points`에 반영하십시오.

### [{subject_framework.get('name')} - {curr_info.get('name')} 내용영역 체계]: {content_str}
### [{subject_framework.get('name')} 행동영역 체계]: {behavior_str}
"""
    if target_range.strip():
        prompt += f"\n[분석 대상 문항 범위 지정]: {target_range.strip()} (지정된 범위의 문항만 빠짐없이 분석하십시오.)\n"
    else:
        prompt += "\n[분석 대상 문항]: 제공된 데이터의 모든 문항을 번호 순서대로 하나도 빠짐없이 분석하십시오.\n"

    if custom_instruction.strip():
        prompt += f"\n[사용자 추가 지시사항]: {custom_instruction.strip()}\n"

    prompt += "\n" + RESPONSE_SCHEMA_DESCRIPTION
    return prompt


def parse_llm_json_output(raw_output: str) -> Dict[str, Any]:
    if not raw_output or not raw_output.strip():
        raise RuntimeError("AI 모델로부터 빈 응답이 반환되었습니다.")

    cleaned = raw_output.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned).strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(cleaned[start : end + 1])
        raise RuntimeError(
            f"AI 응답을 JSON으로 변환하는 데 실패했습니다. 응답 일부: {cleaned[:300]}"
        )


def call_codex_cli_analysis(
    model_name: str,
    system_prompt: str,
    exam_title: str,
    raw_text: str,
    media_parts: List[Dict[str, str]],
    workspace_dir: str,
) -> Dict[str, Any]:
    codex_bin = find_cli_binary("codex")
    if not codex_bin:
        raise RuntimeError(
            "현재 PC에서 Codex CLI 프로그램을 찾을 수 없습니다. 상단 AI 연결 방식을 'API Key 직접 입력(Gemini/OpenAI/Claude)' 또는 '웹 브라우저 AI 복붙 모드'로 선택해 주세요."
        )

    raw_text = decode_kice_pua_text(raw_text or "")
    tmp_dir = tempfile.mkdtemp(prefix="kice_codex_", dir=workspace_dir)
    try:
        image_files: List[str] = []
        for idx, media in enumerate(media_parts):
            mime = media.get("mime_type", "")
            b64 = media.get("data_base64", "")
            if not b64:
                continue
            if mime.startswith("image/"):
                ext = mime.split("/")[-1].replace("jpeg", "jpg")
                img_path = os.path.join(tmp_dir, f"page_{idx+1}.{ext}")
                with open(img_path, "wb") as f:
                    f.write(base64.b64decode(b64))
                image_files.append(img_path)

        if not image_files and not (raw_text and raw_text.strip()):
            raise RuntimeError(
                "분석할 문항 이미지나 추출된 텍스트가 전달되지 않았습니다."
            )

        output_path = os.path.join(tmp_dir, "last_message.json")

        full_prompt = (
            f"{system_prompt}\n\n"
            f"========================================\n"
            f"[분석 요청 시험 제목]: {exam_title}\n"
            f"[분석 일자]: {datetime.date.today().isoformat()}\n\n"
        )
        if raw_text and raw_text.strip():
            full_prompt += f"[추출된 시험 문항 텍스트 및 수식 데이터]\n{raw_text.strip()}\n\n"
        if image_files:
            full_prompt += f"(첨부된 시험지/문항 이미지 {len(image_files)}장을 정밀 판독하여 문항을 분류·평가하십시오.)\n\n"
        full_prompt += (
            "중요 지침: 어떠한 파일 탐색이나 명령 실행도 하지 말고, 제공된 데이터만 보고 "
            "즉시 순수 JSON 객체(`{`로 시작하여 `}`로 끝나는 JSON)만 출력하십시오."
        )

        cmd = [
            codex_bin,
            "exec",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--ephemeral",
            "-s",
            "read-only",
            "-c",
            'model_reasoning_effort="low"',
            "-o",
            output_path,
        ]
        if model_name and model_name not in ("default", "codex-default", ""):
            cmd.extend(["-m", model_name])
        for img_p in image_files[:10]:
            cmd.extend(["-i", img_p])
        cmd.append("-")

        proc = subprocess.run(
            cmd,
            input=full_prompt,
            text=True,
            capture_output=True,
            env=get_augmented_env(),
            cwd=tmp_dir,
            timeout=180,
        )

        raw_output = ""
        if os.path.exists(output_path):
            with open(output_path, "r", encoding="utf-8", errors="ignore") as f:
                raw_output = f.read().strip()

        if not raw_output:
            raw_output = (proc.stdout or "").strip()

        if proc.returncode != 0 and not raw_output:
            err_detail = (proc.stderr or proc.stdout or "").strip()
            raise RuntimeError(
                f"Codex CLI 실행 오류 (코드 {proc.returncode}): {err_detail[:500]}"
            )

        return parse_llm_json_output(raw_output)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def call_claude_cli_analysis(
    model_name: str,
    system_prompt: str,
    exam_title: str,
    raw_text: str,
    media_parts: List[Dict[str, str]],
    workspace_dir: str,
) -> Dict[str, Any]:
    claude_bin = find_cli_binary("claude")
    if not claude_bin:
        raise RuntimeError(
            "현재 PC에서 Claude Code CLI 프로그램을 찾을 수 없습니다. 상단 AI 연결 방식을 'API Key 직접 입력(Gemini/OpenAI/Claude)' 또는 '웹 브라우저 AI 복붙 모드'로 선택해 주세요."
        )

    raw_text = decode_kice_pua_text(raw_text or "")
    tmp_dir = tempfile.mkdtemp(prefix="kice_claude_", dir=workspace_dir)
    try:
        saved_files: List[str] = []
        for idx, media in enumerate(media_parts):
            mime = media.get("mime_type", "")
            b64 = media.get("data_base64", "")
            if not b64:
                continue
            ext = (
                "pdf"
                if mime == "application/pdf"
                else mime.split("/")[-1].replace("jpeg", "jpg")
            )
            fpath = os.path.join(tmp_dir, f"attachment_{idx+1}.{ext}")
            with open(fpath, "wb") as f:
                f.write(base64.b64decode(b64))
            saved_files.append(fpath)

        user_prompt = f"시험 제목: {exam_title}\n분석 일자: {datetime.date.today().isoformat()}\n\n"
        if raw_text and raw_text.strip():
            user_prompt += f"[추출된 시험 문항 텍스트 및 수식 데이터]\n{raw_text.strip()}\n\n"
        if saved_files and not (raw_text and len(raw_text.strip()) > 200):
            files_list_str = "\n".join(f"- {p}" for p in saved_files[:8])
            user_prompt += f"[첨부된 시험지/문항 이미지 파일 경로 (Read 도구로 확인)]:\n{files_list_str}\n\n"

        user_prompt += (
            "위 시험 문항들을 KICE 수능 출제 지침 및 지정된 교육과정·대상 학년 기준에 따라 분석하여 "
            "오직 순수 JSON 객체(`{`로 시작하고 `}`로 끝나는 유효한 JSON)만 출력하십시오."
        )

        cmd = [
            claude_bin,
            "-p",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--system-prompt",
            system_prompt,
        ]
        if saved_files and not (raw_text and len(raw_text.strip()) > 200):
            cmd.extend(["--allowedTools", "Read", "--add-dir", tmp_dir])
        else:
            cmd.extend(["--tools", ""])
        if model_name and model_name not in ("default", "claude-default", ""):
            cmd.extend(["--model", model_name])

        proc = subprocess.run(
            cmd,
            input=user_prompt,
            text=True,
            capture_output=True,
            env=get_augmented_env(),
            cwd=tmp_dir,
            timeout=180,
        )

        raw_output = (proc.stdout or "").strip()
        if proc.returncode != 0 and not raw_output:
            err_detail = (proc.stderr or proc.stdout or "").strip()
            raise RuntimeError(
                f"Claude Code CLI 실행 오류 (코드 {proc.returncode}): {err_detail[:500]}"
            )

        return parse_llm_json_output(raw_output)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def call_gemini_analysis(
    api_key: str,
    model_name: str,
    system_prompt: str,
    exam_title: str,
    raw_text: str,
    media_parts: List[Dict[str, str]],
) -> Dict[str, Any]:
    if not api_key or not api_key.strip():
        raise ValueError(
            "Gemini API Key가 입력되지 않았습니다. 상단 API Key 입력란에 키를 입력하거나 다른 연결 모드를 선택해 주세요."
        )

    raw_text = decode_kice_pua_text(raw_text or "")
    api_key = api_key.strip()
    primary_model = model_name.strip() if model_name else "gemini-3.5-flash"
    if primary_model == "gemini-2.5-flash":
        primary_model = "gemini-3.5-flash"

    candidate_models = [primary_model]
    for fb in ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.8-flash"]:
        if fb not in candidate_models:
            candidate_models.append(fb)

    user_parts: List[Dict[str, Any]] = []

    for idx, media in enumerate(media_parts):
        mime_type = media.get("mime_type", "image/png")
        b64_data = media.get("data_base64", "")
        fname = media.get("name", f"attachment_{idx+1}")
        if b64_data:
            user_parts.append({"text": f"[첨부 파일 {idx+1}: {fname} ({mime_type})]"})
            user_parts.append(
                {
                    "inline_data": {
                        "mime_type": mime_type,
                        "data": b64_data,
                    }
                }
            )

    text_prompt = f"시험 제목: {exam_title or '수능/모의고사 문항 분석'}\n"
    text_prompt += f"분석 일자: {datetime.date.today().isoformat()}\n\n"
    if raw_text and raw_text.strip():
        text_prompt += f"[추출/입력된 시험 문항 텍스트 및 수식 데이터]\n{raw_text.strip()}\n\n"
    text_prompt += "위 시험 자료의 각 문항을 KICE 수능 출제 지침에 따라 내용영역, 단일 행동영역, 문항별 평가 및 시험 전체 난이도 총평으로 분류하여 지정된 JSON 형식으로 출력하십시오."

    user_parts.append({"text": text_prompt})

    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": user_parts}],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
        },
    }

    req_data = json.dumps(payload).encode("utf-8")
    last_err = None
    resp_json = None

    for cur_model in candidate_models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{cur_model}:generateContent?key={api_key}"
        req = urllib.request.Request(
            url,
            data=req_data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                resp_body = resp.read().decode("utf-8")
                resp_json = json.loads(resp_body)
                break
        except urllib.error.HTTPError as e:
            err_text = e.read().decode("utf-8", errors="ignore")
            try:
                err_obj = json.loads(err_text)
                msg = err_obj.get("error", {}).get("message", err_text)
            except Exception:
                msg = err_text
            last_err = f"Gemini API 호출 오류 ({cur_model}, HTTP {e.code}): {msg}"
            if e.code in (404, 503):
                continue
            raise RuntimeError(last_err)
        except urllib.error.URLError as e:
            raise RuntimeError(f"네트워크 연결 오류: {e.reason}")

    if resp_json is None:
        raise RuntimeError(last_err or "Gemini API 호출에 실패했습니다.")

    candidates = resp_json.get("candidates", [])
    if not candidates:
        raise RuntimeError("Gemini API로부터 유효한 응답 후보(candidates)를 받지 못했습니다.")

    parts = candidates[0].get("content", {}).get("parts", [])
    raw_output = "".join(p.get("text", "") for p in parts).strip()

    return parse_llm_json_output(raw_output)


def call_openai_api_analysis(
    api_key: str,
    model_name: str,
    system_prompt: str,
    exam_title: str,
    raw_text: str,
    media_parts: List[Dict[str, str]],
) -> Dict[str, Any]:
    """
    Direct OpenAI API call (works on any PC without installing Codex CLI).
    """
    if not api_key or not api_key.strip():
        raise ValueError(
            "OpenAI API Key(sk-...)가 입력되지 않았습니다. 상단 API Key 입력란에 키를 입력해 주세요."
        )

    raw_text = decode_kice_pua_text(raw_text or "")
    api_key = api_key.strip()
    model_id = model_name.strip() if model_name else "gpt-4o"

    user_content: List[Dict[str, Any]] = []
    text_prompt = (
        f"시험 제목: {exam_title or '수능/모의고사 문항 분석'}\n"
        f"분석 일자: {datetime.date.today().isoformat()}\n\n"
    )
    if raw_text and raw_text.strip():
        text_prompt += f"[추출/입력된 시험 문항 텍스트 및 수식 데이터]\n{raw_text.strip()}\n\n"
    text_prompt += "위 시험 자료의 각 문항을 KICE 수능 출제 지침에 따라 내용영역, 단일 행동영역, 문항별 평가 및 시험 전체 난이도 총평으로 분류하여 순수 JSON 객체만 출력하십시오."
    user_content.append({"type": "text", "text": text_prompt})

    for media in media_parts[:10]:
        mime_type = media.get("mime_type", "image/jpeg")
        b64_data = media.get("data_base64", "")
        if b64_data and mime_type.startswith("image/"):
            user_content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime_type};base64,{b64_data}"},
                }
            )

    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            resp_json = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_text = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"OpenAI API 호출 오류 (HTTP {e.code}): {err_text[:400]}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"네트워크 연결 오류: {e.reason}")

    choices = resp_json.get("choices", [])
    if not choices:
        raise RuntimeError("OpenAI API로부터 응답을 받지 못했습니다.")
    raw_output = choices[0].get("message", {}).get("content", "").strip()
    return parse_llm_json_output(raw_output)


def call_anthropic_api_analysis(
    api_key: str,
    model_name: str,
    system_prompt: str,
    exam_title: str,
    raw_text: str,
    media_parts: List[Dict[str, str]],
) -> Dict[str, Any]:
    """
    Direct Anthropic Claude API call (works on any PC without installing Claude Code CLI).
    """
    if not api_key or not api_key.strip():
        raise ValueError(
            "Anthropic Claude API Key(sk-ant-...)가 입력되지 않았습니다. 상단 API Key 입력란에 키를 입력해 주세요."
        )

    raw_text = decode_kice_pua_text(raw_text or "")
    api_key = api_key.strip()
    model_id = model_name.strip() if model_name else "claude-sonnet-4-20250514"

    user_content: List[Dict[str, Any]] = []
    for media in media_parts[:10]:
        mime_type = media.get("mime_type", "image/jpeg")
        b64_data = media.get("data_base64", "")
        if b64_data and mime_type.startswith("image/"):
            user_content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": mime_type,
                        "data": b64_data,
                    },
                }
            )

    text_prompt = (
        f"시험 제목: {exam_title or '수능/모의고사 문항 분석'}\n"
        f"분석 일자: {datetime.date.today().isoformat()}\n\n"
    )
    if raw_text and raw_text.strip():
        text_prompt += f"[추출/입력된 시험 문항 텍스트 및 수식 데이터]\n{raw_text.strip()}\n\n"
    text_prompt += "위 시험 자료의 각 문항을 KICE 수능 출제 지침에 따라 내용영역, 단일 행동영역, 문항별 평가 및 시험 전체 난이도 총평으로 분류하여 순수 JSON 객체만 출력하십시오."
    user_content.append({"type": "text", "text": text_prompt})

    payload = {
        "model": model_id,
        "max_tokens": 8192,
        "temperature": 0.2,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_content}],
    }

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            resp_json = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_text = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Claude API 호출 오류 (HTTP {e.code}): {err_text[:400]}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"네트워크 연결 오류: {e.reason}")

    content_blocks = resp_json.get("content", [])
    raw_output = "".join(
        b.get("text", "") for b in content_blocks if b.get("type") == "text"
    ).strip()
    return parse_llm_json_output(raw_output)
