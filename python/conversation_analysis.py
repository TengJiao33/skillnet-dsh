"""Durable conversation analysis steps using SkillNet 0.1.5 algorithms."""
import json
import os
import sqlite3
import tempfile
from pathlib import Path

from skillnet_ai import analyzer as sdk
from skillnet_ai.core.models import AnalysisOptions, AnalyzedSkill, GraphSnapshot, RelationJudgment, SkillProfile, SkillSource
from skillnet_ai.core.prompts import PROFILE_PROMPT, PROFILE_VERSION, RELATION_VERSION
from skillnet_ai.core.validation import validate_profile
from skillnet_ai.router.index import build_bm25, publish
from skillnet_ai.router.wiki import materialize_wiki, numbered


OUTPUT_LOCALE = 'zh-CN'
OUTPUT_LANGUAGE_GUIDE = (
    '即使技能源码是英文，技能画像、使用场景、关系说明和无关系的理由也请用简体中文撰写。'
    '保持技能标识、工具名、API 名、命令和文件名原样，按 schema 保留字段名、枚举值和证据行号。'
)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.replace(temporary, path)


def pointer(index):
    path = index / 'CURRENT'
    if path.exists():
        return path.read_text(encoding='utf-8')
    flat = index / 'graph.json'
    return f'flat:{flat.stat().st_mtime_ns}' if flat.exists() else None


def configuration(request, client, options=None):
    from host_adapter import host_client
    from skillnet_ai.core.config import model_endpoint

    mode = request.get('retrievalMode', 'model')
    if mode not in ('model', 'vector'):
        raise ValueError('请选择仅使用模型或向量检索模式。')
    if options is None:
        options = AnalysisOptions(timeout=120, json_mode=client.settings.json_mode if client.settings.json_mode != 'auto' else 'on')
    selection = request.get('modelSelection')
    settings = host_client({'_host_model': selection}).settings if selection else client.settings
    endpoint = model_endpoint(settings, 'analysis')
    embedding = model_endpoint(client.settings, 'embedding') if mode == 'vector' else None
    config = {'mode': mode, 'model_key': [endpoint.base_url, endpoint.model, options.json_mode, options.reasoning_effort],
              'embedding_key': [embedding.base_url, embedding.model] if embedding else None,
              'profile_version': PROFILE_VERSION, 'relation_version': RELATION_VERSION,
              'candidate_limit': options.candidate_limit, 'output_locale': OUTPUT_LOCALE}
    return options, embedding, config


def profile_cache_key(model_key, source):
    return [*model_key, PROFILE_VERSION, OUTPUT_LOCALE, source.skill_id, source.content_hash]


def relation_cache_key(model_key, first, second):
    return [*model_key, PROFILE_VERSION, RELATION_VERSION, OUTPUT_LOCALE,
            first.skill_id, first.content_hash, second.skill_id, second.content_hash,
            first.profile.model_dump(), second.profile.model_dump()]


def plan(request, client):
    """Read changes and validated cache entries without starting or publishing a run."""
    from skillnet_ai.core.library import load_snapshot, validate_snapshot_evidence

    source_path, index = Path(request['sourcePath']).resolve(), Path(request['indexPath']).resolve()
    options, embedding, config = configuration(request, client)
    sources = sdk.read_skills(source_path)
    snapshot, graph = None, None
    if (index / 'CURRENT').exists():
        snapshot, graph = load_snapshot(index)
        validate_snapshot_evidence(graph)
    previous = {s.skill_id: s for s in graph.skills} if graph else {}
    current = {s.skill_id: s for s in sources}
    added, removed = current.keys() - previous.keys(), previous.keys() - current.keys()
    modified = {key for key in current.keys() & previous.keys() if current[key].content_hash != previous[key].content_hash}
    result = {'added': len(added), 'modified': len(modified), 'removed': len(removed),
              'unchanged': len(current) - len(added) - len(modified), 'total': len(sources),
              'reusableProfiles': 0, 'pendingProfiles': len(sources), 'upToDate': False}
    cache_path = index / 'cache.sqlite'
    connection = sqlite3.connect(cache_path.as_uri() + '?mode=ro', uri=True) if cache_path.is_file() else None
    try:
        def cached(namespace, key):
            if connection is None:
                return None
            row = connection.execute('SELECT value FROM results WHERE namespace=? AND key=?',
                                     (namespace, json.dumps(key, sort_keys=True))).fetchone()
            return row[0] if row else None

        skills = []
        for source in sources:
            value = cached('profile', profile_cache_key(config['model_key'], source))
            if value is None:
                continue
            profile = SkillProfile.model_validate_json(value)
            validate_profile(profile, source.source)
            skills.append(AnalyzedSkill(**source.model_dump(), profile=profile))
        result['reusableProfiles'] = len(skills)
        result['pendingProfiles'] -= len(skills)
        changes = [f'{label} {result[key]} 项' for key, label in [('added', '新增'), ('modified', '修改'), ('removed', '删除')] if result[key]]
        result['summary'] = '，'.join([*changes, f'复用 {len(skills)} 项画像', *([f'待分析 {result["pendingProfiles"]} 项'] if result['pendingProfiles'] else [])])
        if graph is None or added or removed or modified:
            return result
        if any(source.path != previous[source.skill_id].path for source in sources):
            return result
        if graph.embedding_model != (embedding.model if embedding else '') or graph.embedding_base_url != (embedding.base_url if embedding else ''):
            return result
        if embedding and not (snapshot / 'embeddings.npz').is_file():
            return result
        try:
            published_config = json.loads((snapshot / 'analysis-config.json').read_text(encoding='utf-8'))
        except (FileNotFoundError, ValueError):
            published_config = None
        if published_config is not None:
            result['upToDate'] = published_config == config
            if result['upToDate']:
                result.update(reusableProfiles=len(sources), pendingProfiles=0, summary=f'复用 {len(sources)} 项画像')
            return result
        # Older snapshots have no build configuration. Prove compatibility from
        # exact SDK cache keys and the current candidate judgments, never guess
        # the model from a graph that carries no inference-model metadata.
        if len(skills) != len(sources) or any(s.model_dump() != previous[s.skill_id].model_dump() for s in skills):
            return result
        by_id = {s.skill_id: s for s in skills}
        with tempfile.TemporaryDirectory(prefix='skillnet-update-check-') as temporary:
            bm25 = Path(temporary) / 'bm25.sqlite'
            build_bm25(skills, bm25)
            if embedding:
                texts = sdk.embedding_texts(skills)
                vectors = [cached('embedding', [embedding.base_url, embedding.model, text.text]) for text in texts]
                if any(value is None for value in vectors):
                    return result
                pairs = sdk.candidate_pairs(skills, texts, sdk.normalize([json.loads(value) for value in vectors]), bm25, options.candidate_limit)
            else:
                from model_mode import candidate_pairs
                pairs = candidate_pairs(skills, bm25, options.candidate_limit)
            relations = []
            for pair in pairs:
                first, second = by_id[pair.first], by_id[pair.second]
                value = cached('relation', relation_cache_key(config['model_key'], first, second))
                if value is None:
                    return result
                relations.extend(sdk.normalize_relations(RelationJudgment.model_validate_json(value), first, second))
        canonical = lambda values: sorted(json.dumps(value.model_dump(), sort_keys=True) for value in values)
        result['upToDate'] = canonical(relations) == canonical(graph.relations)
        return result
    finally:
        if connection is not None:
            connection.close()


def execute(request, client):
    from skillnet_ai.web.library import read_library

    state_path = Path(request['runPath']) / 'analysis.json'
    source_path, index = Path(request['sourcePath']).resolve(), Path(request['indexPath']).resolve()
    options, embedding, config = configuration(request, client)
    mode, model_key, embedding_key = config['mode'], config['model_key'], config['embedding_key']
    if index == source_path or index in source_path.parents:
        raise ValueError('分析目录不能替换技能库或其上级目录。')
    read_library(str(source_path))
    current = sdk.read_skills(source_path)
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding='utf-8'))
        if state['model_key'] != model_key or state['mode'] != mode or state.get('embedding_key') != embedding_key:
            raise ValueError('模型或建图模式已改变。请恢复原设置继续，或新开建图对话。')
        if state['status'] == 'completed':
            return {'status': 'completed', 'result': state['result']}
        if state.get('analysis_config', config) != config:
            raise ValueError('建图配置已改变，请重新点击建图；已校验缓存与已有图谱保留。')
        sources = [SkillSource.model_validate(s) for s in state['sources']]
        if [(s.skill_id, s.content_hash) for s in current] != [(s.skill_id, s.content_hash) for s in sources]:
            raise ValueError('技能库源码已改变，请重新点击建图；已校验缓存与已有图谱保留。')
    else:
        if request.get('stepId'):
            raise ValueError('请先领取分析步骤。')
        sources = current
        index.mkdir(parents=True, exist_ok=True)
        state = {'status': 'active', 'mode': mode, 'model_key': model_key, 'embedding_key': embedding_key, 'analysis_config': config,
                 'sources': [s.model_dump(mode='json') for s in sources],
                 'profiles': {}, 'judgments': {}, 'pairs': None, 'pending': None,
                 'profile_hits': 0, 'relation_hits': 0, 'embedding_hits': 0,
                 'previous_pointer': pointer(index),
                 'stage': tempfile.mkdtemp(prefix='snapshot-', dir=index)}
        save(state_path, state)
    cache = sdk.ModelCache(index / 'cache.sqlite')
    by_source = {s.skill_id: s for s in sources}

    def profile_key(source):
        return profile_cache_key(model_key, source)

    def analyzed():
        return [AnalyzedSkill(**s.model_dump(), profile=SkillProfile.model_validate(state['profiles'][s.skill_id])) for s in sources]

    def relation_data(pair):
        by_id = {s.skill_id: s for s in analyzed()}
        first, second = by_id[pair['first']], by_id[pair['second']]
        key = relation_cache_key(model_key, first, second)
        return first, second, key

    def inline_profile_schema(schema, max_line):
        schema = json.loads(json.dumps(schema))
        defs = schema.pop('$defs', None) or {}

        def resolve(node):
            if isinstance(node, list):
                return [resolve(item) for item in node]
            if not isinstance(node, dict):
                return node
            ref = node.get('$ref')
            if isinstance(ref, str) and ref.startswith('#/$defs/'):
                name = ref.split('/', 2)[-1]
                if name in defs:
                    merged = {**resolve(defs[name]), **{k: v for k, v in node.items() if k != '$ref'}}
                    return resolve(merged)
            return {k: resolve(v) for k, v in node.items()}

        resolved = resolve(schema)
        # Propagate the source line bound onto every Citation.line field.
        def bound_lines(node):
            if isinstance(node, list):
                for item in node:
                    bound_lines(item)
            elif isinstance(node, dict):
                if node.get('title') == 'Citation' and isinstance(node.get('properties'), dict) and 'line' in node['properties']:
                    node['properties']['line']['maximum'] = max_line
                for value in node.values():
                    bound_lines(value)

        bound_lines(resolved)
        return resolved

    def check_relation_lines(judgment, first, second):
        by_id = {first.skill_id: first, second.skill_id: second}
        if judgment.decision.outcome == 'none':
            return
        for edge in judgment.decision.relations:
            if {edge.source, edge.target} != set(by_id):
                raise ValueError(f'关系端点必须分别是「{first.skill_id}」和「{second.skill_id}」，当前提交的是 {edge.source} -> {edge.target}。')
            for context in edge.contexts:
                for side, skill_id, citations in (('source_evidence', edge.source, context.source_evidence), ('target_evidence', edge.target, context.target_evidence)):
                    total = len(by_id[skill_id].source.splitlines())
                    bad = [c.line for c in citations if c.line > total]
                    if bad:
                        raise ValueError(f'关系 {edge.source} -> {edge.target} 中 {side}（对应技能「{skill_id}」，源码共 {total} 行）引用了越界行号 {bad}。两份源码各自从第 1 行编号，请核对后重交。')

    def task(pending):
        if pending['kind'] == 'profile':
            source = by_source[pending['skillId']]
            line_count = len(source.source.splitlines())
            guide = (
                f'当前步骤：提炼技能「{source.skill_id}」的能力画像（源码共 {line_count} 行）。'
                '请按 system 中的 SkillNet 规范提取字段，并将符合 schema 的 JSON 对象作为 result 参数传给 skillnet_analyze_submit 提交，不要只在聊天文本里输出 JSON。'
                '注意：所有带 evidence 的字段（例如 capability，以及 when_to_use、inputs、outputs、constraints、tools 和 scenarios.before/after 中的每一项）'
                '都必须写成 {"text": "一句话概括", "evidence": [{"line": 行号}]} 的对象格式，不要简写为字符串；行号必须在 1 到 '
                f'{line_count} 之间。{OUTPUT_LANGUAGE_GUIDE}'
            )
            return {**pending, 'system': PROFILE_PROMPT, 'guide': guide,
                    'payload': {'skill_id': source.skill_id, 'source': numbered(source.source)},
                    'schema': inline_profile_schema(SkillProfile.model_json_schema(), line_count)}
        pair = state['pairs'][pending['pairIndex']]
        first, second, _ = relation_data(pair)
        first_lines = len(first.source.splitlines())
        second_lines = len(second.source.splitlines())
        guide = (
            f'当前步骤：判断「{first.skill_id}」（源码 {first_lines} 行）与「{second.skill_id}」（源码 {second_lines} 行）之间是否存在可组合或相似关系。'
            '请按 system 中的 SkillNet 规范判断，并将符合 schema 的 JSON 对象作为 result 参数传给 skillnet_analyze_submit 提交，不要只在聊天文本里输出 JSON。'
            '请直接填写 decision。无关系填 outcome="none" 和 reason，有关系填 outcome="related" 和 relations。'
            '注意：两份源码各自独立从第 1 行编号，source_evidence 必须对应 source 指定的技能，target_evidence 必须对应 target 指定的技能。'
            f'{OUTPUT_LANGUAGE_GUIDE}'
        )
        from prompts import RELATION_SINGLE_SYSTEM
        return {**pending, 'system': RELATION_SINGLE_SYSTEM, 'guide': guide,
                'payload': {'skills': [{'skill_id': s.skill_id, 'profile': s.profile.model_dump(), 'source': numbered(s.source)} for s in (first, second)],
                            'retrieval_hints': pair['hints']},
                'schema': sdk.relation_schema(first, second)}

    def waiting(error=None):
        save(state_path, state)
        return {'status': 'needs_correction' if error else 'awaiting_result',
                'progress': {'profiles': len(state['profiles']), 'skills': len(sources),
                             'relations': len(state['judgments']), 'candidates': len(state['pairs']) if state['pairs'] is not None else None},
                'task': task(state['pending']), **({'error': error} if error else {})}

    if request.get('stepId'):
        pending = state['pending']
        # A reply lost after checkpointing can safely be submitted again.
        done_ids = {f'profile:{s}' for s in state['profiles']} | {f'relation:{i}' for i in state['judgments']}
        if request['stepId'] not in done_ids:
            if not pending or request['stepId'] != pending['stepId']:
                raise ValueError('步骤已过期，请重新领取当前步骤。')
            raw_result = request.get('result')
            if isinstance(raw_result, str):
                try:
                    raw_result = json.loads(raw_result)
                except ValueError:
                    return waiting({'message': 'result 不是合法的 JSON 对象，请检查引号、逗号和括号后以 JSON 对象格式重新提交。'})
            from pydantic import ValidationError
            try:
                if pending['kind'] == 'profile':
                    source = by_source[pending['skillId']]
                    value = SkillProfile.model_validate(raw_result)
                    try:
                        validate_profile(value, source.source)
                    except ValueError as exc:
                        total_lines = len(source.source.splitlines())
                        raise ValueError(f'技能「{source.skill_id}」（源码共 {total_lines} 行）{exc}') from None
                    cache.put('profile', profile_key(source), value.model_dump_json())
                    state['profiles'][source.skill_id] = value.model_dump()
                else:
                    first, second, key = relation_data(state['pairs'][pending['pairIndex']])
                    # Strip only the protocol field; validate all SDK fields as before.
                    if isinstance(raw_result, dict):
                        raw_result = {k: v for k, v in raw_result.items() if k != 'brief'}
                    value = RelationJudgment.model_validate(raw_result)
                    check_relation_lines(value, first, second)
                    edges = sdk.normalize_relations(value, first, second)
                    if value.decision.outcome == 'related':
                        value.decision.relations = edges
                    cache.put('relation', key, value.model_dump_json())
                    state['judgments'][str(pending['pairIndex'])] = value.model_dump()
            except ValidationError as error:
                issues = error.errors(include_input=False, include_url=False, include_context=False)
                has_string_object = any(item.get('type') in ('dict_type', 'model_type') for item in issues)
                hint = '部分对象字段被写成了字符串或非对象类型，请补全为 {"text": "...", "evidence": [{"line": 行号}]} 或 schema 要求的对象格式。' if has_string_object else ''
                return waiting({'message': f'结果结构未通过校验，请按反馈修正当前步骤。{hint}',
                                'issues': issues})
            except ValueError as error:
                return waiting({'message': str(error)})
            state['pending'] = None
            # Persist acceptance before doing any subsequent indexing/network work.
            save(state_path, state)
    if state['pending']:
        return waiting()

    for source in sources:
        if source.skill_id in state['profiles']:
            continue
        cached = cache.get('profile', profile_key(source))
        if cached is None:
            state['pending'] = {'stepId': f'profile:{source.skill_id}', 'kind': 'profile', 'skillId': source.skill_id}
            return waiting()
        profile = SkillProfile.model_validate_json(cached)
        validate_profile(profile, source.source)
        state['profiles'][source.skill_id] = profile.model_dump()
        state['profile_hits'] += 1
        save(state_path, state)

    skills = analyzed()
    stage = Path(state['stage'])
    if state['pairs'] is None:
        # Can be repeated after interruption; only CURRENT publishes a graph.
        (stage / 'bm25.sqlite').unlink(missing_ok=True)
        build_bm25(skills, stage / 'bm25.sqlite')
        if embedding:
            import numpy as np
            texts, matrix, hits = sdk.build_vectors(embedding, skills, cache, timeout=options.timeout,
                                                  retries=options.request_retries, batch_size=options.embedding_batch_size)
            pairs = sdk.candidate_pairs(skills, texts, matrix, stage / 'bm25.sqlite', options.candidate_limit)
            np.savez(stage / 'embeddings.npz', ids=np.asarray([s.skill_id for s in skills]), vectors=matrix[:len(skills)])
            state['embedding_hits'] = hits
        else:
            from model_mode import candidate_pairs
            pairs = candidate_pairs(skills, stage / 'bm25.sqlite', options.candidate_limit)
        state['pairs'] = [{'first': p.first, 'second': p.second, 'hints': p.hints} for p in pairs]
        save(state_path, state)
    for i, pair in enumerate(state['pairs']):
        if str(i) in state['judgments']:
            continue
        first, second, key = relation_data(pair)
        cached = cache.get('relation', key)
        if cached is None:
            state['pending'] = {'stepId': f'relation:{i}', 'kind': 'relation', 'pairIndex': i}
            return waiting()
        judgment = RelationJudgment.model_validate_json(cached)
        sdk.normalize_relations(judgment, first, second)
        state['judgments'][str(i)] = judgment.model_dump()
        state['relation_hits'] += 1
        save(state_path, state)

    relations = []
    for i, pair in enumerate(state['pairs']):
        first, second, _ = relation_data(pair)
        relations.extend(sdk.normalize_relations(RelationJudgment.model_validate(state['judgments'][str(i)]), first, second))
    graph = GraphSnapshot(embedding_model=embedding.model if embedding else '', embedding_base_url=embedding.base_url if embedding else '', skills=skills, relations=relations)
    (stage / 'graph.json').write_text(graph.model_dump_json(indent=2), encoding='utf-8')
    if state.get('analysis_config') == config:
        save(stage / 'analysis-config.json', config)
    materialize_wiki(stage / 'wiki', skills, relations)
    # Reject publication over a newer graph, including after a plugin restart.
    if pointer(index) not in (state['previous_pointer'], stage.name + '\n'):
        raise ValueError('已有更新的图谱发布，请新开建图对话；本次校验缓存保留。')
    fresh = sdk.read_skills(source_path)
    if [(s.skill_id, s.content_hash) for s in fresh] != [(s.skill_id, s.content_hash) for s in sources]:
        raise ValueError('技能库源码已改变，未发布图谱。请重新点击建图。')
    publish(index, stage)
    state['status'] = 'completed'
    state['result'] = {'index_dir': str(index), 'skill_count': len(skills), 'retrieval_mode': mode,
                       'relation_counts': {kind: sum(e.type == kind for e in relations) for kind in ('compose_with', 'similar_to')},
                       'cache_hits': {'profiles': state['profile_hits'], 'relations': state['relation_hits'], 'embeddings': state['embedding_hits']}}
    save(state_path, state)
    return {'status': 'completed', 'result': state['result']}
