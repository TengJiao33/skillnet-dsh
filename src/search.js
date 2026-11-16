// Query orchestration only: retrieval remains the official hosted SkillNet SDK.
function searchFailure(error, mode) {
  const message = String(error?.message || error);
  const label = mode === 'vector' ? '语义检索' : '关键词检索';
  const status = Number(error?.status || error?.statusCode || message.match(/\b([45]\d\d)\s+(?:Client|Server)\s+Error\b/i)?.[1]);
  if ([401, 403].includes(status)) return `${label}服务拒绝访问，请检查访问权限。`;
  if (status === 429) return `${label}请求过于频繁，请稍后重试。`;
  if ([408, 504].includes(status) || /time.?out|timed out|超时/i.test(message)) return `${label}响应超时，请稍后重试。`;
  if ([500, 502, 503].includes(status)) return `${label}服务暂时不可用，请稍后重试。`;
  if (/connection|connect|network|offline|ENOTFOUND|ECONN|网络|连接/i.test(message)) return `无法连接${label}服务，请检查网络后重试。`;
  return `${label}未完成，请稍后重试。`;
}

export function createSearch(run, hostModel) {
  return async (args, execution = {}) => {
    const q = typeof args.q === 'string' ? args.q.trim() : '';
    if (!q || q.length > 4000) throw new Error('请输入不超过 4000 字的检索任务。');
    const mode = args.mode || 'auto';
    if (!['auto', 'keyword', 'vector'].includes(mode)) throw new Error('未知的检索方式。');
    if (args.sort_by === 'recent' && mode !== 'keyword') throw new Error('按最近更新排序请使用关键词检索。');
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
    const filters = { category: args.category, min_stars: args.min_stars || 0, sort_by: args.sort_by || 'relevance' };
    const signal = execution.signal;
    const filter = skills => skills.filter(skill => Number(skill.stars || 0) >= filters.min_stars);
    if (mode !== 'auto') {
      let result;
      try { result = await run({ action: 'search', q, mode, limit: mode === 'vector' ? Math.min(50, limit * 2) : limit, page: args.page || 1, threshold: args.threshold ?? 0.8, ...filters }, signal); }
      catch (error) { signal?.throwIfAborted(); throw new Error(searchFailure(error, mode), { cause: error }); }
      if (mode === 'vector') { result.skills = filter(result.skills); if (filters.sort_by === 'stars') result.skills.sort((a, b) => Number(b.stars || 0) - Number(a.stars || 0)); result.skills = result.skills.slice(0, limit); result.limit = limit; }
      return result;
    }
    const batches = [], warnings = [];
    const recallLimit = args.includeCandidates ? 50 : Math.min(50, limit * 2);
    const lookup = q.match(/^([A-Za-z][A-Za-z0-9.+#_-]*)(?:\s*(?:处理|工具|技能|开发|管理))?$/u)?.[1];
    const sourceKey = skill => String(skill.skill_url).replace('/blob/', '/tree/').replace(/\/SKILL\.md\/?$/i, '').replace(/\/$/, '');
    const enough = () => new Set(batches.flatMap(batch => batch.skills.map(sourceKey))).size >= limit;
    let sequence = 0, semanticFailed = false;
    const retrieve = async (query, kind, threshold, sort = filters.sort_by, ranked = true) => {
      signal?.throwIfAborted();
      const order = sequence++;
      try {
        const result = await run({ action: 'search', q: query, mode: kind, threshold, limit: recallLimit, page: 1, ...filters, sort_by: sort }, signal);
        const skills = filter(result.skills);
        batches.push({ skills, query, kind, threshold, order, ranked });
        return skills.length;
      } catch (error) {
        signal?.throwIfAborted();
        if (kind === 'vector') semanticFailed = true;
        warnings.push(searchFailure(error, kind));
        return null;
      }
    };
    const chinese = /[\u3400-\u9fff]/u.test(q);
    // Short skill/format lookups have a reliable literal query. Recall popular
    // sources as candidates too; their star-sorted rank is not a relevance score.
    if (lookup) {
      if (filters.sort_by === 'stars') await retrieve(lookup, 'keyword', undefined, 'stars');
      else await Promise.all([
        retrieve(lookup, 'keyword', undefined, 'relevance'),
        retrieve(lookup, 'keyword', undefined, 'stars', false),
      ]);
    }
    if (!enough()) {
      const count = await retrieve(q, 'vector', 0.8);
      if (count !== null && !enough()) await retrieve(q, 'vector', 0.65);
    }
    if (!enough() && (!lookup || lookup !== q)) await retrieve(q, 'keyword');
    if (!enough() && chinese && hostModel && !semanticFailed) {
      try {
        const host = await hostModel.capture(execution, args.sessionId);
        const answer = await hostModel.invoke(host, { method: 'chat', max_turns: 1,
          system: 'Translate a skill-search task into one concise English search query. Preserve all file formats, tool names, constraints and intended actions. Do not add capabilities. Return only JSON: {"query":"..."}.', prompt: q }, AbortSignal.any([AbortSignal.timeout(40_000), ...(signal ? [signal] : [])]));
        const parsed = JSON.parse(answer.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
        if (typeof parsed.query !== 'string' || !parsed.query.trim() || parsed.query.length > 4000) throw new Error('检索改写格式无效。');
        await retrieve(parsed.query.trim(), 'vector', 0.65);
      } catch (error) { signal?.throwIfAborted(); warnings.push('英文补充检索未完成。'); }
    }
    if (!batches.length) throw new Error(`SkillNet 检索失败：${warnings[0] || '服务不可用。'}`);
    // Fuse ranks, never collapse distinct same-name skills or replace source attribution.
    const values = new Map();
    batches.sort((a, b) => a.order - b.order);
    for (const batch of batches) for (const [rank, skill] of batch.skills.entries()) {
      const key = sourceKey(skill);
      const entry = values.get(key) || { skill, score: 0, order: values.size };
      if (batch.ranked) entry.score += 1 / (60 + rank);
      values.set(key, entry);
    }
    const matchLevel = skill => {
      if (!lookup) return 0;
      const key = lookup.toLowerCase().replace(/[_\s]+/g, '-'), name = String(skill.skill_name || '').toLowerCase().replace(/[_\s]+/g, '-');
      if (name === key) return 0;
      if (name.startsWith(key + '-') || name.endsWith('-' + key) || name.includes('-' + key + '-')) return 1;
      return String(skill.skill_description || '').toLowerCase().includes(key) ? 2 : 3;
    };
    const merged = [...values.values()].sort((a, b) => {
      const levelA = matchLevel(a.skill), levelB = matchLevel(b.skill);
      const stars = Number(b.skill.stars || 0) - Number(a.skill.stars || 0);
      return levelA - levelB || (lookup && levelA <= 1 ? stars : 0) || b.score - a.score || stars || a.order - b.order;
    }).map(item => item.skill);
    if (filters.sort_by === 'stars') merged.sort((a, b) => Number(b.stars || 0) - Number(a.stars || 0));
    return { query: q, mode, page: 1, limit, skills: merged.slice(0, limit),
      ...(args.includeCandidates ? { candidates: merged, candidateCount: merged.length } : {}),
      queries: batches.map(batch => ({ q: batch.query, mode: batch.kind, threshold: batch.threshold })), warnings: [...new Set(warnings)] };
  };
}
