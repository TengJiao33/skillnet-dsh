"""Embedding-free workflows for SkillNet 0.1.5.

Analysis orchestration is adapted from the MIT-licensed SDK analyzer. Its
prompts, structured schemas, evidence validation and successful-result cache
are reused unchanged; only vector candidate retrieval is replaced.
"""

import json
import re
import shutil
import tempfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def candidate_pairs(skills, bm25_path, limit):
    from skillnet_ai.analyzer import CandidatePair
    from skillnet_ai.router.index import profile_text, search_bm25

    hits = defaultdict(set)

    def add(first, second, hint):
        if first != second:
            hits[tuple(sorted((first, second)))].add(hint)

    if len(skills) <= limit + 1:
        for i, first in enumerate(skills):
            for second in skills[i + 1:]:
                add(first.skill_id, second.skill_id, 'direct comparison')
    else:
        for skill in skills:
            for other in [s for s in search_bm25(bm25_path, profile_text(skill), limit + 1)
                          if s != skill.skill_id][:limit]:
                add(skill.skill_id, other, 'lexical capability retrieval')
            # Retain lexical handoff candidates as well as capability matches.
            outputs = [*skill.profile.outputs, *(f for s in skill.profile.scenarios for f in s.after)]
            query = ' '.join(f.text for f in outputs)
            if query:
                for other in [s for s in search_bm25(bm25_path, query, limit + 1)
                              if s != skill.skill_id][:limit]:
                    add(skill.skill_id, other, 'lexical handoff retrieval')

    counts = Counter(s.name for s in skills)
    aliases = {s.skill_id: s.skill_id for s in skills}
    aliases.update({s.name: s.skill_id for s in skills
                    if counts[s.name] == 1 and (s.name not in aliases or aliases[s.name] == s.skill_id)})
    for skill in skills:
        for name in set(re.findall(r'`([^`\n]+)`', skill.source)) & aliases.keys():
            add(skill.skill_id, aliases[name], f'explicit reference in {skill.skill_id}: {name}')
    return [CandidatePair(a, b, tuple(sorted(hints))) for (a, b), hints in sorted(hits.items())]


def analyze(source_path, output_dir, *, endpoint, options):
    from skillnet_ai import analyzer as sdk
    from skillnet_ai.core.models import AnalysisResult, AnalyzedSkill, GraphSnapshot, RelationJudgment, SkillProfile
    from skillnet_ai.core.prompts import PROFILE_PROMPT, PROFILE_VERSION, RELATION_PROMPT, RELATION_VERSION
    from skillnet_ai.core.validation import validate_profile
    from skillnet_ai.router.index import build_bm25, publish
    from skillnet_ai.router.wiki import materialize_wiki, numbered

    source_path = Path(source_path).resolve()
    output_dir = Path(output_dir or source_path / '.skillnet').resolve()
    sources = sdk.read_skills(source_path)
    if output_dir == source_path or output_dir in source_path.parents:
        raise ValueError('分析目录不能替换技能库或其上级目录。')
    output_dir.mkdir(parents=True, exist_ok=True)
    cache = sdk.ModelCache(output_dir / 'cache.sqlite')
    stage = Path(tempfile.mkdtemp(prefix='snapshot-', dir=output_dir))
    model_key = [endpoint.base_url, endpoint.model, options.json_mode, options.reasoning_effort]

    def extract(source):
        key = [*model_key, PROFILE_VERSION, source.skill_id, source.content_hash]
        cached = cache.get('profile', key)
        profile = SkillProfile.model_validate_json(cached) if cached is not None else sdk.structured_call(
            endpoint, options, PROFILE_PROMPT,
            {'skill_id': source.skill_id, 'source': numbered(source.source)}, SkillProfile)
        validate_profile(profile, source.source)
        if cached is None:
            cache.put('profile', key, profile.model_dump_json())
        return AnalyzedSkill(**source.model_dump(), profile=profile), cached is not None

    try:
        with ThreadPoolExecutor(max_workers=options.max_workers) as pool:
            extracted = list(pool.map(extract, sources))
        skills = [s for s, _ in extracted]
        build_bm25(skills, stage / 'bm25.sqlite')
        pairs = candidate_pairs(skills, stage / 'bm25.sqlite', options.candidate_limit)
        by_id = {s.skill_id: s for s in skills}

        def judge(pair):
            first, second = by_id[pair.first], by_id[pair.second]
            key = [*model_key, PROFILE_VERSION, RELATION_VERSION,
                   first.skill_id, first.content_hash, second.skill_id, second.content_hash,
                   first.profile.model_dump(), second.profile.model_dump()]
            cached = cache.get('relation', key)
            judgment = RelationJudgment.model_validate_json(cached) if cached is not None else sdk.structured_call(
                endpoint, options, RELATION_PROMPT,
                {'skills': [{'skill_id': s.skill_id, 'profile': s.profile.model_dump(),
                             'source': numbered(s.source)} for s in (first, second)],
                 'retrieval_hints': pair.hints}, RelationJudgment,
                output_schema=sdk.relation_schema(first, second))
            edges = sdk.normalize_relations(judgment, first, second)
            if cached is None:
                if judgment.decision.outcome == 'related':
                    judgment.decision.relations = edges
                cache.put('relation', key, judgment.model_dump_json())
            return edges, cached is not None

        with ThreadPoolExecutor(max_workers=options.max_workers) as pool:
            judgments = list(pool.map(judge, pairs))
        relations = [edge for edges, _ in judgments for edge in edges]
        # Empty embedding metadata explicitly denotes a graph without vectors.
        # Never write placeholder embeddings or let vector routing consume it.
        graph = GraphSnapshot(embedding_model='', embedding_base_url='', skills=skills, relations=relations)
        (stage / 'graph.json').write_text(graph.model_dump_json(indent=2), encoding='utf-8')
        materialize_wiki(stage / 'wiki', skills, relations)
        publish(output_dir, stage)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return AnalysisResult(index_dir=output_dir, skill_count=len(skills),
                          relation_counts={kind: sum(e.type == kind for e in relations)
                                           for kind in ('compose_with', 'similar_to')},
                          cache_hits={'profiles': sum(hit for _, hit in extracted), 'embeddings': 0,
                                      'relations': sum(hit for _, hit in judgments)})


def route(request, *, endpoint, options, backend):
    """Explore current source packages, including libraries with no graph yet."""
    from skillnet_ai.analyzer import read_skills
    from skillnet_ai.core.validation import parse_frontmatter
    from skillnet_ai.router.router import explore
    from skillnet_ai.router.wiki import numbered, page_name, source_page
    from skillnet_ai.web.library import read_library

    query = request['query']
    k = request.get('k', 5)
    if not isinstance(query, str) or not query.strip():
        raise ValueError('请输入路由任务。')
    if isinstance(k, bool) or not isinstance(k, int) or not 1 <= k <= 20:
        raise ValueError('路由数量应为 1 至 20。')
    # Apply the same source size/count and path checks as the SDK browser.
    read_library(request['sourcePath'])
    sources = read_skills(Path(request['sourcePath']).resolve())
    with tempfile.TemporaryDirectory(prefix='skillnet-model-route-') as temporary:
        root = Path(temporary)
        (root / 'cards').mkdir()
        (root / 'sources').mkdir()
        catalog = []
        for skill in sources:
            metadata = parse_frontmatter(skill.source)
            card = f'cards/{page_name(skill.skill_id)}.md'
            entry = {'skill_id': skill.skill_id, 'name': skill.name,
                     'description': metadata.get('description', ''),
                     'card': card, 'source': source_page(skill.skill_id)}
            catalog.append(entry)
            # Metadata is source data, not an invented analyzed profile.
            (root / card).write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding='utf-8')
            (root / source_page(skill.skill_id)).write_text(numbered(skill.source), encoding='utf-8')
        header = '# Task Wiki\n\nCurrent skill sources; no analyzed relationships are supplied.\n'
        if len(catalog) <= 64:
            index = header + '\n' + json.dumps(catalog, ensure_ascii=False, indent=2)
        else:
            pages = []
            for offset in range(0, len(catalog), 64):
                name = f'catalog-{offset // 64 + 1}.json'
                chunk = catalog[offset:offset + 64]
                (root / name).write_text(json.dumps(chunk, ensure_ascii=False, indent=2), encoding='utf-8')
                pages.append({'page': name, 'skills': [s['skill_id'] for s in chunk]})
            index = header + '\nCatalog pages:\n' + json.dumps(pages, ensure_ascii=False, indent=2)
        (root / 'index.md').write_text(index, encoding='utf-8')
        (root / 'relations.json').write_text('[]', encoding='utf-8')
        result = explore(root, query, sources, k, endpoint, options, backend).model_dump(mode='json')
    # Bind handoff to exactly the current source set, even without an index.
    result['source_versions'] = {s.skill_id: s.content_hash for s in sources}
    return result
