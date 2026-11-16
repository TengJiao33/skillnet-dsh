import postcss from 'postcss';

// Original CSS remains the light theme. Mirror its cascade under dark mode,
// replacing palette values while retaining shorthand resets and geometry.
const palette = new Map();
const colors = (token, values) => values.split(/\s+/).forEach(value => palette.set(value, `var(--sn-${token})`));
colors('canvas', '#f8fafb');
colors('surface', '#fff white');
colors('surface-muted', '#f1f5f7 #f7f9fa #f3f7f8 #f0f7f7 #fbfcfd #fcfdfd #f6f8f9 #f4f8f9 #f4f8f7');
colors('hover', '#f8fbfa #f9fcfb #f7faf9 #f3faf7 #f8fcfa #f6faf8');
colors('accent-bg', '#c9eee4 #f0f9f6 #ecf6f3 #e6f5e7 #e7f5f0 #edf7ec #e9f6f0 #eef7f4 #f0f8f5 #e4f4ef #e6f4ef');
colors('accent', '#078b6b #067a5f #0c9877 #078869 #0b8c70 #0b8e70 #146b5d #20836e #14745d #347d6e #087b61 #16866d #0d765f #244a40 #139c7b #164d41 #17a47f #158d72 #0f9b78 #168e72 #68bfa7 #2c947f');
colors('accent-soft', '#67b9a4 #54aa94 #7db6a6 #6aa995 #88adb0 #81a9a5');
colors('similar', '#a9a2c9 #7666a6 #8569aa #684397');
colors('similar-bg', '#f0edfa');
colors('text', '#18344a #263c4b #355266 #344d5f #385667 #203544 #3e5969 #3e5963 #405b68 #455e6c #223d4c #315467 #274556 #2e4a5b #18364b #314c5c #19394a #284757 #274354 #345365 #223744 #294d50 #4b6573');
colors('text-secondary', '#657887 #60798a #68826f #526a78 #607483 #526b78 #647786 #536a78 #5b6f7d #506775 #4e6671 #6d8390 #617987 #547080 #607888 #6b8694 #657e8a #6b8290 #496474 #536d79 #6b7d89 #5b7280 #526d7a #718894 #5a786e #637780 #65857b #6a7e84');
colors('text-tertiary', '#83929c #a3b5bd #8ea0ac #91a1a9 #a4b4bb #a4b2b9 #9dafb7 #9caeb8 #9caab2');
colors('node', '#87b1bf #89aab7 #88a8b5');
colors('edge', '#adc0c6');
colors('border', '#e8edf1 #e3ebef #e5ebee #dfe8ed #e4eaee #edf1f3 #e1e8ec #eff2f4 #e8edf0 #e9eef0 #e6edf0 #dfe9ec #dcece7 #e7eef0 #dce6e9 #dfe8ec #e9eef1 #e7edef #e1e9ed #b9d9cf #dceae5 #e5ecee #dbe7e9 #d9e5e9 #e0e9ed #b8dcd0 #e5ecef');
colors('accent-border', '#8cc9b9 #95cdbd #a7d0c3');
colors('error', '#a7503c');
colors('error-bg', '#fff6f3');
colors('error-border', '#f1cfc6');
colors('warning', '#765c18');
colors('warning-bg', '#fff9e9');
colors('warning-border', '#ead7a4');
colors('scrollbar', '#d3e1e3');

export function themeCSS(source) {
  const root = postcss.parse(source);
  root.walkDecls(decl => {
    if (decl.prop === 'color-scheme') { decl.value = 'inherit'; return; }
    decl.value = decl.value.replace(/#[\da-f]{3,8}\b|rgba?\([^)]*\)|\bwhite\b|\bblack\b/gi, value => {
      if (value === '#fff' && decl.prop === 'color') return 'var(--sn-button-label)';
      if (/^rgba?\(/.test(value)) return value.includes('255, 255, 255') ? 'var(--sn-header)' : 'var(--sn-shadow)';
      const token = palette.get(value.toLowerCase());
      if (!token) throw new Error(`Unmapped SkillNet color: ${value}`);
      return token;
    });
  });
  root.walkRules(rule => {
    if (!rule.nodes.length) { rule.remove(); return; }
    rule.selectors = rule.selectors.map(selector => `:where(body[data-ds-dark-theme]) ${selector}`);
  });
  root.walkAtRules(rule => { if (rule.nodes && !rule.nodes.length) rule.remove(); });
  return root.toString();
}
