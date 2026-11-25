"""Build SDK-compatible snapshots using either the DSH host or a configured API."""
import json
import shutil
import sqlite3
import tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, closing
from pathlib import Path
from threading import Lock
from time import monotonic

import numpy as np
from openai import APIStatusError, OpenAI
from skillnet_ai import analyzer as sdk
from skillnet_ai.core.config import model_endpoint
from skillnet_ai.core.library import load_snapshot
from skillnet_ai.core.models import AnalyzedSkill, GraphSnapshot, RelationJudgment, SkillProfile
from skillnet_ai.core.prompts import PROFILE_PROMPT
from skillnet_ai.router.index import build_bm25
from skillnet_ai.router.wiki import materialize_wiki, numbered

from conversation_analysis import (OUTPUT_LANGUAGE_GUIDE, configuration, pointer, profile_cache_key,
                                   relation_cache_key, save)
from host_adapter import (ANALYSIS_HOST_TIMEOUT_MS, RejectedOutput, check_phase_failures, host_result, prefill_relations,
                          structured_host_response)
from model_mode import candidate_pairs as lexical_pairs
from prompts import RELATION_BATCH_OBJECT_SYSTEM


def api_client(endpoint, timeout):
    return OpenAI(api_key=endpoint.api_key.get_secret_value(), base_url=endpoint.base_url,
                  timeout=timeout, max_retries=2)


def direct_inference(client, endpoint, json_mode):
    formats = {'auto': ['json_schema', 'json_object', None], 'on': ['json_schema'], 'off': [None]}[json_mode]
    lock = Lock()
    level = 0

    def infer(request):
        nonlocal level
        while True:
            with lock:
                current = level
            fmt = formats[current]
            system = request['system']
            params = {}
            if fmt:
                params['response_format'] = {'type': fmt}
                if request.get('format') == 'relation-lines':
                    _, row_schema = system.rsplit('\nJSON schema for each line:\n', 1)
                    row = json.loads(row_schema)
                    names = row['properties']['candidate']['enum']
                    schema = {'type': 'object', 'additionalProperties': False, 'required': ['decisions'],
                              '$defs': row['$defs'], 'properties': {'decisions': {
                                  'type': 'object', 'additionalProperties': False, 'required': names,
                                  'properties': {name: row['properties']['decision'] for name in names}}}}
                    system = RELATION_BATCH_OBJECT_SYSTEM + '\nJSON schema:\n' + json.dumps(schema, ensure_ascii=False)
                if fmt == 'json_schema':
                    schema = json.loads(system.rsplit('\nJSON schema:\n', 1)[1])
                    params['response_format']['json_schema'] = {'name': 'skillnet', 'schema': schema, 'strict': True}
            messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': request['prompt']}]
            try:
                result = client.chat.completions.create(model=endpoint.model, messages=messages, **params)
                break
            except APIStatusError as error:
                reason = str(error).lower()
                if not (current + 1 < len(formats) and fmt and error.status_code in (400, 422) and
                        any(key in reason for key in ('response_format', 'json_schema', 'json_object')) and
                        any(term in reason for term in ('unsupported', 'not support', 'not allowed'))):
                    raise
                with lock:
                    level = max(level, current + 1)
        choice = result.choices[0]
        if choice.finish_reason not in ('stop', 'length'):
            raise ValueError(f'模型未正常结束（{choice.finish_reason}）。')
        return {'content': choice.message.content or '', 'truncated': choice.finish_reason == 'length'}
    return infer


def build_vectors(skills, endpoint, cache, options):
    texts = sdk.embedding_texts(skills)
    inputs = [entry.text for entry in texts]
    prefix = [endpoint.base_url, endpoint.model]
    vectors = {}
    # Use the SDK key format, with one transaction per embedding batch.
    keys = {text: json.dumps([*prefix, text], sort_keys=True) for text in dict.fromkeys(inputs)}
    encoded = list(keys.values())
    with closing(sqlite3.connect(cache.path)) as conn:
        for offset in range(0, len(encoded), 128):
            chunk = encoded[offset:offset + 128]
            placeholders = ','.join('?' for _ in chunk)
            for key, value in conn.execute(
                    f"SELECT key, value FROM results WHERE namespace='embedding' AND key IN ({placeholders})", chunk):
                vectors[json.loads(key)[-1]] = json.loads(value)
    missing = [text for text in keys if text not in vectors]
    hits = sum(text in vectors for text in inputs)
    if missing:
        batches, batch, size = [], [], 0
        for text in missing:
            length = len(text.encode('utf-8'))
            if batch and (len(batch) >= options.embedding_batch_size or size + length > 64_000):
                batches.append(batch)
                batch, size = [], 0
            batch.append(text)
            size += length
        batches.append(batch)
        with api_client(endpoint, options.timeout) as client:
            def embed(batch):
                try:
                    result = client.embeddings.create(model=endpoint.model, input=batch)
                except APIStatusError as error:
                    oversized = error.status_code == 413 or (error.status_code == 400 and any(
                        term in str(error).lower() for term in ('too long', 'too large', 'batch size', 'token limit', 'maximum context')))
                    if not oversized or len(batch) == 1:
                        raise
                    mid = len(batch) // 2
                    return embed(batch[:mid]) + embed(batch[mid:])
                rows = sorted(result.data, key=lambda row: row.index)
                if [row.index for row in rows] != list(range(len(batch))):
                    raise ValueError('向量服务返回的序号与输入不一致。')
                sdk.normalize([row.embedding for row in rows])
                with closing(sqlite3.connect(cache.path)) as conn, conn:
                    conn.executemany("INSERT OR REPLACE INTO results VALUES ('embedding', ?, ?)",
                                     [(keys[text], json.dumps(row.embedding)) for text, row in zip(batch, rows, strict=True)])
                return [(text, row.embedding) for text, row in zip(batch, rows, strict=True)]
            with ThreadPoolExecutor(max_workers=4) as pool:
                for entries in pool.map(embed, batches):
                    vectors.update(entries)
    return texts, sdk.normalize([vectors[text] for text in inputs]), hits


def pending_review(index, expected, sources, model_key, stage):
    snapshot, graph = load_snapshot(index)
    if snapshot.name != expected:
        raise ValueError('图谱已有更新，请查看最新建图结果。')
    config = json.loads((snapshot / 'analysis-config.json').read_text(encoding='utf-8'))
    if config['model_key'] != model_key:
        raise ValueError('分析模型配置已改变，请恢复原模型配置后重试。')
    pending_profiles = config.pop('pending_profiles', {})
    hashes = {**pending_profiles, **{s.skill_id: s.content_hash for s in graph.skills}}
    paths = {s.skill_id: s.path for s in graph.skills}
    if hashes != {s.skill_id: s.content_hash for s in sources} or any(
            s.path != paths[s.skill_id] for s in sources if s.skill_id in paths):
        raise ValueError('技能源码已改变，请使用「更新图谱」。')
    pairs = [sdk.CandidatePair(a, b, ()) for a, b in config.pop('pending_pairs', [])]
    if not pairs:
        raise ValueError('当前图谱的候选已全部复核。')
    for filename in ['bm25.sqlite', *(['embeddings.npz'] if graph.embedding_model else [])]:
        shutil.copyfile(snapshot / filename, stage / filename)
    return graph, config, pending_profiles, pairs


def analyze(request, client, options):
    source = Path(request['sourcePath']).resolve()
    index = Path(request.get('indexPath') or source / '.skillnet').resolve()
    if index == source or index in source.parents:
        raise ValueError('分析目录不能替换技能库或其上级目录。')
    start = monotonic()
    selection = request.get('_host_model')
    retry_snapshot = request.get('retrySnapshot')
    settings = {**request, 'modelSelection': selection}
    if retry_snapshot:
        settings['retrievalMode'] = 'model'  # A targeted retry uses the published indexes.
    _, embedding, config = configuration(settings, client, options)
    model_key = config['model_key']
    previous = pointer(index)
    sources = sdk.read_skills(source)
    index.mkdir(parents=True, exist_ok=True)
    cache = sdk.ModelCache(index / 'cache.sqlite')
    stage = Path(tempfile.mkdtemp(prefix='snapshot-', dir=index))
    timings = {}
    try:
        with ExitStack() as stack:
            send = host_result
            if not selection:
                endpoint = model_endpoint(client.settings, 'analysis')
                connection = stack.enter_context(api_client(endpoint, options.timeout))
                send = direct_inference(connection, endpoint, client.settings.json_mode)

            calls = Counter()
            count_lock = Lock()

            def infer(payload):
                with count_lock:
                    calls[payload['phase']] += 1
                return send(payload)

            if retry_snapshot:
                graph, config, pending_profiles, pairs = pending_review(index, retry_snapshot, sources, model_key, stage)
                skills = graph.skills
                edges = list(graph.relations)
                profile_hits = embedding_hits = 0
                timings.update(profiles=0, retrieval=0)
            else:
                def profile(source):
                    key = profile_cache_key(model_key, source)
                    cached = cache.get('profile', key)
                    if cached is None:
                        value = structured_host_response(
                            PROFILE_PROMPT + '\n' + OUTPUT_LANGUAGE_GUIDE,
                            {'skill_id': source.skill_id, 'source': numbered(source.source)}, SkillProfile,
                            SkillProfile.model_json_schema(), ANALYSIS_HOST_TIMEOUT_MS, f'提取画像：{source.skill_id}',
                            lambda profile: sdk.validate_profile(profile, source.source), phase='profile', infer=infer)
                        cache.put('profile', key, value.model_dump_json())
                    else:
                        value = SkillProfile.model_validate_json(cached)
                        sdk.validate_profile(value, source.source)
                    return AnalyzedSkill(**source.model_dump(), profile=value), cached is not None

                extracted = []
                pending_profiles = {}
                failures = []
                with ThreadPoolExecutor(max_workers=options.max_workers) as pool:
                    jobs = [(source, pool.submit(profile, source)) for source in sources]
                    for item, job in jobs:
                        try:
                            extracted.append(job.result())
                        except RejectedOutput as error:
                            pending_profiles[item.skill_id] = item.content_hash
                            failures.append(str(error))
                if not extracted:
                    check_phase_failures(0, failures)
                skills = [skill for skill, _ in extracted]
                after_profiles = monotonic()
                timings['profiles'] = round(after_profiles - start, 3)
                bm25 = stage / 'bm25.sqlite'
                build_bm25(skills, bm25)
                embedding_hits = 0
                if embedding:
                    texts, matrix, embedding_hits = build_vectors(skills, embedding, cache, options)
                    pairs = sdk.candidate_pairs(skills, texts, matrix, bm25, options.candidate_limit)
                    np.savez(stage / 'embeddings.npz', ids=np.asarray([s.skill_id for s in skills]), vectors=matrix[:len(skills)])
                else:
                    pairs = lexical_pairs(skills, bm25, options.candidate_limit)
                after_candidates = monotonic()
                timings['retrieval'] = round(after_candidates - after_profiles, 3)
                profile_hits = sum(hit for _, hit in extracted)
                edges = []
                graph = GraphSnapshot(skills=skills, relations=[], embedding_model=embedding.model if embedding else '',
                                      embedding_base_url=embedding.base_url if embedding else '')
            relation_start = monotonic()
            timings['screen'] = 0
            pending = []
            judged = prefill_relations(cache, skills, pairs, model_key, options, allow_unresolved=True,
                                       pending_pairs=pending, infer=infer, retry_only=bool(retry_snapshot), report_progress=request.get('_progress', False))
            timings['relations'] = round(monotonic() - relation_start, 3)
        pending_set = set(map(tuple, pending))
        by_id = {s.skill_id: s for s in skills}
        for pair in pairs:
            if (pair.first, pair.second) in pending_set:
                continue
            first, second = by_id[pair.first], by_id[pair.second]
            record = cache.get('relation', relation_cache_key(model_key, first, second))
            edges.extend(sdk.normalize_relations(RelationJudgment.model_validate_json(record), first, second))
        if retry_snapshot and len(pending) == len(pairs):
            published_snapshot = retry_snapshot
            shutil.rmtree(stage)
        else:
            graph.relations = edges
            save(stage / 'graph.json', graph.model_dump(mode='json'))
            materialize_wiki(stage / 'wiki', skills, edges)
            save(stage / 'analysis-config.json', {**config, **({'pending_pairs': pending} if pending else {}),
                                                  **({'pending_profiles': pending_profiles} if pending_profiles else {})})
            published_snapshot = stage.name
        fresh = [(s.skill_id, s.content_hash, s.path) for s in sdk.read_skills(source)]
        if fresh != [(s.skill_id, s.content_hash, s.path) for s in sources]:
            raise ValueError('技能库源码已改变，未发布图谱。请重新点击建图。')
        if pointer(index) != previous:
            raise ValueError('已有更新的图谱发布，请重新建图。已校验缓存保留。')
        if published_snapshot == stage.name:
            sdk.publish(index, stage)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    timings['total'] = round(monotonic() - start, 3)
    counts = Counter(edge.type for edge in edges)
    return {'index_dir': str(index), 'snapshot': published_snapshot, 'skill_count': len(skills),
            **({'retried_candidates': len(pairs)} if retry_snapshot else {}),
            'relation_counts': {kind: counts[kind] for kind in ('compose_with', 'similar_to')},
            'cache_hits': {'profiles': profile_hits, 'embeddings': embedding_hits,
                           'relations': len(pairs) - judged - len(pending)},
            'pending_profiles': list(pending_profiles), 'candidate_pairs': len(pairs), 'screened_out': 0, 'pending_relations': len(pending), 'seconds': timings,
            'model_calls': dict(calls), 'retrieval_mode': config['mode']}
