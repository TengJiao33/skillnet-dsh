// DSH local skills and the native loader belong to Agent preset scopes, not
// necessarily to the host's unscoped registry. Cold UI reads lease the default
// preset, following the official SessionSkillCatalog implementation.
export function nativeSkills(ctx) {
  async function read(method, name, options = {}) {
    const presets = ctx.get('agentPresets');
    const registry = options.scope && presets?.serviceFor(options.scope, 'skills') || ctx.skills;
    if (options.scope || !presets) return method === 'get' ? registry.get(name, options) : registry.snapshot(options);
    const lease = await presets.acquireScope();
    try {
      const view = { ...options, scope: lease.key };
      return method === 'get' ? await registry.get(name, view) : await registry.snapshot(view);
    } finally { await lease[Symbol.asyncDispose](); }
  }
  return { get: (name, options) => read('get', name, options), snapshot: options => read('snapshot', undefined, options) };
}
