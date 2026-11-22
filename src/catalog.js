// Keep catalog retrieval and ranking intact; hide only confirmed missing sources.
export function createCatalog(run, now = Date.now) {
  const cache = new Map();
  return async (request, signal) => {
    const result = await run(request, signal);
    const skills = result.skills;
    const urls = [...new Set(skills.map(skill => skill.skill_url))];
    const unknown = urls.filter(url => !cache.has(url) || cache.get(url).expiresAt <= now());
    const states = new Map(urls.filter(url => !unknown.includes(url)).map(url => [url, cache.get(url).status]));
    if (unknown.length) {
      try {
        const checks = await run({ action: 'source-status', urls: unknown }, signal);
        signal?.throwIfAborted();
        for (const check of checks) {
          if (!unknown.includes(check.url) || !['available', 'missing'].includes(check.status)) continue;
          states.set(check.url, check.status);
          cache.delete(check.url);
          cache.set(check.url, { status: check.status, expiresAt: now() + 300_000 });
        }
        while (cache.size > 2000) cache.delete(cache.keys().next().value);
      } catch (error) {
        signal?.throwIfAborted();
        // An unavailable checker is not evidence that a skill has disappeared.
      }
    }
    signal?.throwIfAborted();
    const visible = skills.filter(skill => states.get(skill.skill_url) !== 'missing');
    return { ...result, skills: visible, filteredCount: skills.length - visible.length,
      ...(result.mode === 'keyword' ? { hasMore: skills.length >= result.limit } : {}) };
  };
}
