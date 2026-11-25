"""Embedding-free candidate selection and routing for SkillNet 0.1.5."""

import json
import re
import tempfile
from collections import Counter, defaultdict
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
