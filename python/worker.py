"""Isolated model jobs and a reusable read-only SDK library reader."""

import contextlib
import importlib.metadata
import os
import json
from pathlib import Path
import sys
import tempfile


def chinese_message(message):
    translations = {
        'Enter an absolute folder path.': '请输入目录的绝对路径。',
        'The selected path is not a directory.': '所选路径不是目录。',
        'A library can contain at most 5,000 skills.': '单个技能库最多支持 5,000 项技能。',
        'Skill sources exceed 20 MB. Choose a smaller library.': '技能源码总大小超过 20 MB，请选择较小的技能库。',
        'Cannot load analysis snapshot; run skillnet analyze again.': '无法加载分析快照，请重新建图。',
        'Analysis exceeds 5,000 skills or 20,000 relationships.': '分析结果超过 5,000 项技能或 20,000 条关系的限制。',
        'The analysis folder and skill library have no skills in common.': '分析目录与当前技能库不匹配。',
        'Analysis must contain unique, nonempty skill identities.': '分析结果中的技能标识必须唯一且非空。',
        'Analysis relation references an unknown skill.': '分析关系引用了不存在的技能。',
        'A relationship must connect two different skills.': '关系必须连接两个不同的技能。',
        'SKILL.md must start with YAML frontmatter (---).': 'SKILL.md 必须以 YAML 元数据区（---）开头。',
        'Unclosed YAML frontmatter.': 'YAML 元数据区未闭合。',
        'Invalid YAML frontmatter.': 'YAML 元数据格式不正确。',
        'Frontmatter must be a YAML mapping.': '元数据区必须使用 YAML 键值格式。',
        'name must be 1–64 lowercase letters/digits with single separating hyphens.': '技能名称应为 1 至 64 个小写字母或数字，可用单个连字符分隔。',
        'name must match the skill directory name.': '技能名称必须与技能目录名一致。',
        'Downloaded skill is invalid: ': '技能未通过结构校验：',
        'description must be a nonempty string of at most 1024 characters.': '技能描述不能为空，且不能超过 1,024 个字符。',
        'dsh truncates catalog descriptions beyond 500 characters.': 'DSH 目录中的技能描述只显示前 500 个字符。',
        'Portable metadata uses string keys and values; vendor metadata may be ignored.': '可移植元数据需使用文本键值，其他格式可能被忽略。',
        'Consider moving conditional detail into references; SKILL.md exceeds 500 lines.': 'SKILL.md 已超过 500 行，建议将详细说明移入参考文件。',
        'Connection error.': '无法连接模型服务，请检查接口地址和网络。',
        'Request timed out.': '模型服务请求超时，请稍后重试。',
        'Skill source exceeds the size limit:': '技能源码超过大小限制：',
        'Empty skill source:': '技能源码为空：',
        'Skill name must be a string:': '技能名称必须是文本：',
    }
    for original, translated in translations.items():
        message = message.replace(original, translated)
    return message


def execute(request):
    from skillnet_ai import SkillNetClient
    from skillnet_ai.core.validation import parse_frontmatter, validate_skill

    from skillnet_ai.core.config import ENVIRONMENT, local_checks, resolve_settings
    for key, value in request.get("_settings", {}).items():
        if key in ENVIRONMENT and value:
            os.environ[ENVIRONMENT[key]] = value
    action = request.get("action")
    if action == "status":
        return {"sdk_version": importlib.metadata.version("skillnet-ai")}
    if action == "settings":
        settings = resolve_settings()
        return {"fields": settings.public(), "checks": local_checks(settings)}
    if action == "local-library":
        from skillnet_ai.web.library import read_library
        data = read_library(request["sourcePath"], request.get("indexPath"))
        if data.get('analysisError'):
            data['analysisError'] = chinese_message(data['analysisError'])
        data['warnings'] = [chinese_message(item) for item in data['warnings']]
        return data
    client = SkillNetClient()
    if action == 'analysis-step':
        from conversation_analysis import execute as analysis_step
        return analysis_step(request, client)
    if action in ('analyze', 'route') and request.get('retrievalMode', 'model') not in ('model', 'vector'):
        raise ValueError('请选择仅使用模型或向量检索模式。')
    if action == "analyze":
        from skillnet_ai import AnalysisOptions
        options = AnalysisOptions(max_workers=request.get("max_workers", 2), timeout=120, json_mode=client.settings.json_mode if client.settings.json_mode != "auto" else "on")
        if request.get('_host_model'):
            from host_adapter import analyze
            result = analyze(request, options)
        elif request.get('retrievalMode', 'model') == 'model':
            from model_mode import analyze
            from skillnet_ai.core.config import model_endpoint
            result = analyze(request['sourcePath'], request.get('indexPath'), endpoint=model_endpoint(client.settings, 'analysis'), options=options)
        else:
            result = client.analyze(request["sourcePath"], output_dir=request.get("indexPath"), options=options)
        return {"index_dir": str(result.index_dir), "skill_count": result.skill_count, "relation_counts": result.relation_counts, "cache_hits": result.cache_hits, "retrieval_mode": request.get('retrievalMode', 'model')}
    if action == "route":
        if request.get('retrievalMode', 'model') == 'vector':
            from skillnet_ai.router.index import load_snapshot
            _, graph = load_snapshot(Path(request['indexPath']))
            if not graph.embedding_model:
                raise ValueError('当前图谱不含向量索引，请启用向量检索后重新建图。')
        if request.get('_host_model'):
            from host_adapter import route
            return route(request, client)
        from skillnet_ai import RouteOptions
        if request.get('retrievalMode', 'model') == 'model':
            from model_mode import route
            from skillnet_ai.core.config import model_endpoint
            return route(request, endpoint=model_endpoint(client.settings, 'explorer'), options=RouteOptions(timeout=300), backend=request.get('backend') or client.settings.explorer_backend)
        result = client.route(request["query"], index_dir=request["indexPath"], k=request.get("k", 5), backend=request.get("backend") or client.settings.explorer_backend, options=RouteOptions(timeout=300))
        return result.model_dump(mode="json")
    if action == "create":
        if request.get('_host_model'):
            from host_adapter import create
            return create(request, lambda path: describe(Path(path)))
        kwargs = {"input_type": request.get("input_type", "prompt"), "output_dir": request["output_dir"]}
        for key in ("prompt", "trajectory_content", "github_url", "office_file"):
            if request.get(key):
                kwargs[key] = request[key]
        try:
            paths = client.create(**kwargs)
            if not paths:
                raise ValueError('未生成技能草稿，请检查输入内容和模型返回后重试。')
            return {"drafts": [{"path": path, **describe(Path(path))} for path in paths]}
        except Exception as exc:
            partial = getattr(exc, "created_paths", [])
            if not partial:
                raise
            from skillnet_ai.core.config import redact
            return {"drafts": [{"path": path, **describe(Path(path))} for path in partial], "warning": chinese_message(redact(str(exc)))}
    if action == "evaluate":
        if request.get('_host_model'):
            from host_adapter import evaluate
            return evaluate(request)
        return client.evaluate(request["path"], max_workers=2, cache_dir=request["cache_dir"])
    if action in ("search", "discover"):
        browsing = action == "discover"
        query = "" if browsing else request.get("q", "")
        if not isinstance(query, str) or not browsing and not query.strip():
            raise ValueError("请输入搜索内容。")
        mode = "keyword" if browsing else request.get("mode", "keyword")
        limit = 12 if browsing else request.get("limit", 5)
        results = client.search(
            q=query.strip(),
            mode=mode,
            limit=limit,
            sort_by="stars" if browsing else request.get("sort_by", "relevance"),
            threshold=request.get("threshold", 0.8),
            category=request.get("category") or None,
            page=request.get("page", 1),
            min_stars=request.get("min_stars", 0),
        )
        return {
            "query": query.strip(),
            "mode": mode,
            "page": request.get("page", 1),
            "limit": limit,
            "skills": [item.model_dump(mode="json") for item in results],
            **({"browse": True} if browsing else {}),
        }
    if action == "inspect":
        from github_download import download_skill

        url = request.get("url")
        if not isinstance(url, str) or not url:
            raise ValueError("请选择技能来源链接。")
        # target_dir is supplied only by the host's owned staging service.
        if request.get("target_dir"):
            root = Path(download_skill(client, url, request["target_dir"]))
            return describe(root, url)
        with tempfile.TemporaryDirectory(prefix="dsh-skillnet-preview-") as temporary:
            root = Path(download_skill(client, url, temporary))
            return describe(root, url)
    if action == "check":
        return describe(Path(request["path"]))
    if action == "file":
        root = Path(request["path"]).resolve()
        relative = request.get("file", "")
        file = (root / relative).resolve()
        if not relative or file == root or not file.is_relative_to(root) or not file.is_file():
            raise ValueError("请选择技能包内的文件。")
        with file.open("rb") as stream:
            raw = stream.read(256 * 1024 + 1)
        truncated = len(raw) > 256 * 1024
        try:
            text = raw[:256 * 1024].decode("utf-8-sig")
            if "\x00" in text:
                raise UnicodeError()
        except UnicodeError:
            return {"file": relative, "binary": True, "text": "", "truncated": truncated}
        return {"file": relative, "binary": False, "text": text, "truncated": truncated}
    raise ValueError("未知的 SkillNet 操作。")


def describe(root, url=None):
    from skillnet_ai.core.validation import parse_frontmatter, validate_skill

    validation = validate_skill(root)
    for key in ('errors', 'warnings'):
        validation[key] = [chinese_message(message) for message in validation[key]]
    source = (root / "SKILL.md").read_text(encoding="utf-8-sig")
    return {
        "url": url,
        "name": root.name,
        "source": source,
        "metadata": parse_frontmatter(source),
        "files": sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()),
        "validation": validation,
    }


def respond(line, library_reader=False):
    try:
        request = json.loads(line)
        if not isinstance(request, dict):
            raise ValueError("请求参数必须是 JSON 对象。")
        if library_reader:
            if request.get('action') != 'local-library':
                raise ValueError('这个进程仅支持读取技能库。')
            request = {key: request[key] for key in ('action', 'sourcePath', 'indexPath') if key in request}
        with contextlib.redirect_stdout(sys.stderr):
            data = execute(request)
        result = {"ok": True, "data": data, "error": None}
    except Exception as exc:
        from skillnet_ai.core.config import redact

        result = {
            "ok": False,
            "data": None,
            "error": {"type": type(exc).__name__, "message": chinese_message(redact(str(exc)))},
        }
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["ok"] else 1


def main():
    if '--library-reader' in sys.argv[1:]:
        for line in sys.stdin:
            respond(line, library_reader=True)
        return 0
    return respond(sys.stdin.readline())


if __name__ == "__main__":
    raise SystemExit(main())
