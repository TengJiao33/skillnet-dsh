"""Durable, user-driven analysis steps using SkillNet 0.1.5 algorithms.

No model is called here. The native conversation receives the SDK prompt and
submits a typed result; only validated results enter the original model cache.
"""
import json
import os
import tempfile
from pathlib import Path

from skillnet_ai import analyzer as sdk
from skillnet_ai.core.models import AnalysisOptions, AnalyzedSkill, GraphSnapshot, RelationJudgment, SkillProfile, SkillSource
from skillnet_ai.core.prompts import PROFILE_PROMPT, PROFILE_VERSION, RELATION_PROMPT, RELATION_VERSION
from skillnet_ai.core.validation import validate_profile
from skillnet_ai.router.index import build_bm25, publish
from skillnet_ai.router.wiki import materialize_wiki, numbered


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


def execute(request, client):
    from host_adapter import host_client
    from skillnet_ai.core.config import model_endpoint
    from skillnet_ai.web.library import read_library

    state_path = Path(request['runPath']) / 'analysis.json'
    source_path, index = Path(request['sourcePath']).resolve(), Path(request['indexPath']).resolve()
    mode = request.get('retrievalMode', 'model')
    if mode not in ('model', 'vector'):
        raise ValueError('请选择仅使用模型或向量检索模式。')
    if index == source_path or index in source_path.parents:
        raise ValueError('分析目录不能替换技能库或其上级目录。')
    options = AnalysisOptions(timeout=120, json_mode=client.settings.json_mode if client.settings.json_mode != 'auto' else 'on')
    endpoint = model_endpoint(host_client({'_host_model': request['modelSelection']}).settings, 'analysis')
    model_key = [endpoint.base_url, endpoint.model, options.json_mode, options.reasoning_effort]
    # Preserve the SDK's explicit vector configuration validation. No fallback.
    embedding = model_endpoint(client.settings, 'embedding') if mode == 'vector' else None
    embedding_key = [embedding.base_url, embedding.model] if embedding else None
    read_library(str(source_path))
    current = sdk.read_skills(source_path)
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding='utf-8'))
        if state['model_key'] != model_key or state['mode'] != mode or state.get('embedding_key') != embedding_key:
            raise ValueError('模型或建图模式已改变。请恢复原设置继续，或新开建图对话。')
        if state['status'] == 'completed':
            return {'status': 'completed', 'result': state['result']}
        sources = [SkillSource.model_validate(s) for s in state['sources']]
        if [(s.skill_id, s.content_hash) for s in current] != [(s.skill_id, s.content_hash) for s in sources]:
            raise ValueError('技能库源码已改变，请重新点击建图；已校验缓存与已有图谱保留。')
    else:
        if request.get('stepId'):
            raise ValueError('请先领取分析步骤。')
        sources = current
        index.mkdir(parents=True, exist_ok=True)
        state = {'status': 'active', 'mode': mode, 'model_key': model_key, 'embedding_key': embedding_key,
                 'sources': [s.model_dump(mode='json') for s in sources],
                 'profiles': {}, 'judgments': {}, 'pairs': None, 'pending': None,
                 'profile_hits': 0, 'relation_hits': 0, 'embedding_hits': 0,
                 'previous_pointer': pointer(index),
                 'stage': tempfile.mkdtemp(prefix='snapshot-', dir=index)}
        save(state_path, state)
    cache = sdk.ModelCache(index / 'cache.sqlite')
    by_source = {s.skill_id: s for s in sources}

    def profile_key(source):
        return [*model_key, PROFILE_VERSION, source.skill_id, source.content_hash]

    def analyzed():
        return [AnalyzedSkill(**s.model_dump(), profile=SkillProfile.model_validate(state['profiles'][s.skill_id])) for s in sources]

    def relation_data(pair):
        by_id = {s.skill_id: s for s in analyzed()}
        first, second = by_id[pair['first']], by_id[pair['second']]
        key = [*model_key, PROFILE_VERSION, RELATION_VERSION,
               first.skill_id, first.content_hash, second.skill_id, second.content_hash,
               first.profile.model_dump(), second.profile.model_dump()]
        return first, second, key

    def task(pending):
        if pending['kind'] == 'profile':
            source = by_source[pending['skillId']]
            return {**pending, 'system': PROFILE_PROMPT,
                    'payload': {'skill_id': source.skill_id, 'source': numbered(source.source)},
                    'schema': SkillProfile.model_json_schema()}
        pair = state['pairs'][pending['pairIndex']]
        first, second, _ = relation_data(pair)
        return {**pending, 'system': RELATION_PROMPT,
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
            from pydantic import ValidationError
            try:
                if pending['kind'] == 'profile':
                    source = by_source[pending['skillId']]
                    value = SkillProfile.model_validate(request['result'])
                    validate_profile(value, source.source)
                    cache.put('profile', profile_key(source), value.model_dump_json())
                    state['profiles'][source.skill_id] = value.model_dump()
                else:
                    first, second, key = relation_data(state['pairs'][pending['pairIndex']])
                    value = RelationJudgment.model_validate(request['result'])
                    edges = sdk.normalize_relations(value, first, second)
                    if value.decision.outcome == 'related':
                        value.decision.relations = edges
                    cache.put('relation', key, value.model_dump_json())
                    state['judgments'][str(pending['pairIndex'])] = value.model_dump()
            except ValidationError as error:
                return waiting({'message': '结果结构未通过原始校验，请按反馈纠正当前步骤。',
                                'issues': error.errors(include_input=False, include_url=False, include_context=False)})
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
