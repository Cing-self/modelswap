import { describe, it, expect } from 'vitest';

const {
  AUTO_CREATE_PLATFORMS,
  ZHIPU_CREATE_TEXTS,
  ZHIPU_CONFIRM_TEXTS,
  extractKeyFromCaptures,
  normalizeActionText,
  scoreActionCandidate,
  resolveActionCandidate,
  isValidZhipuApiKey,
  classifyXiaomiTokenPlanIcon,
} =
  await import('../src/web/api/auto-create');

describe('normalizeActionText', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeActionText('  Create   API Key  ')).toBe('create api key');
  });

  it('handles CJK text and full-width spaces', () => {
    expect(normalizeActionText('创建　API　Key')).toBe('创建 api key');
    expect(normalizeActionText('新建 API Key')).toBe('新建 api key');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeActionText(null)).toBe('');
    expect(normalizeActionText(undefined)).toBe('');
    expect(normalizeActionText('')).toBe('');
  });
});

describe('scoreActionCandidate (English)', () => {
  const strong = ['Create API key', 'Create Key', 'Add', 'New API key'];

  it('scores exact strong phrases highly', () => {
    for (const text of strong) {
      expect(scoreActionCandidate({ text, visible: true })).toBeGreaterThanOrEqual(70);
    }
    expect(scoreActionCandidate({ text: 'Create API key', visible: true })).toBe(100);
  });

  it('scores case-insensitive matches', () => {
    expect(scoreActionCandidate({ text: 'CREATE API KEY', visible: true })).toBe(100);
  });

  it('gives partial credit for phrases contained in longer labels', () => {
    expect(scoreActionCandidate({ text: 'Create new API key', visible: true })).toBeGreaterThanOrEqual(70);
    expect(scoreActionCandidate({ text: 'Add API key', visible: true })).toBeGreaterThanOrEqual(70);
  });

  it('ariaLabel and title matches are weaker but still pass', () => {
    const aria = scoreActionCandidate({ text: 'OK', ariaLabel: 'Create API key', visible: true });
    const title = scoreActionCandidate({ text: 'OK', title: 'Create Key', visible: true });
    expect(aria).toBeGreaterThanOrEqual(70);
    expect(title).toBeGreaterThanOrEqual(70);
  });

  it('selectorMatch increases the score', () => {
    const plain = scoreActionCandidate({ text: 'Create API key', visible: true });
    const matched = scoreActionCandidate({ text: 'Create API key', visible: true, selectorMatch: true });
    expect(matched).toBeGreaterThan(plain);
  });

  it('zero score without any create signal', () => {
    expect(scoreActionCandidate({ text: 'OK', visible: true })).toBe(0);
    expect(scoreActionCandidate({ text: '', visible: true })).toBe(0);
    expect(scoreActionCandidate({})).toBe(0);
  });
});

describe('scoreActionCandidate (Simplified Chinese)', () => {
  it('scores exact strong phrases highly', () => {
    for (const text of ['创建 API 密钥', '新建 API Key', '确定']) {
      expect(scoreActionCandidate({ text, visible: true })).toBeGreaterThanOrEqual(70);
    }
    expect(scoreActionCandidate({ text: '创建 API 密钥', visible: true })).toBe(100);
  });

  it('gives partial credit to contained strong phrases', () => {
    expect(scoreActionCandidate({ text: '创建 API 密钥管理', visible: true })).toBeGreaterThanOrEqual(70);
    expect(scoreActionCandidate({ text: '请完成新建 API Key 并确认', visible: true })).toBeGreaterThanOrEqual(70);
  });

  it('ariaLabel/title matches contribute', () => {
    const aria = scoreActionCandidate({ text: 'OK', ariaLabel: '新建 API Key', visible: true });
    expect(aria).toBeGreaterThanOrEqual(70);
  });

  it('generic 创建/新建 alone must not pass', () => {
    for (const text of ['创建', '新建', '创建密钥', '新建密钥']) {
      expect(scoreActionCandidate({ text, visible: true })).toBe(0);
    }
  });
});

describe('scoreActionCandidate (dangerous candidates)', () => {
  const dangerous = [
    'Delete API key', 'Remove', 'Revoke key', 'Reset', 'Regenerate',
    '删除', '移除 API Key', '撤销', '重置', '重新生成', '确定删除',
  ];

  it('rejects destructive words even with strong create phrases present', () => {
    for (const text of dangerous) {
      expect(scoreActionCandidate({ text, visible: true })).toBe(0);
    }
  });

  it('rejects when a destructive word appears only in aria/title', () => {
    expect(scoreActionCandidate({ text: 'Create API key', ariaLabel: 'Reset', visible: true })).toBe(0);
    expect(scoreActionCandidate({ text: 'Create API key', title: '撤销', visible: true })).toBe(0);
  });

  it('rejects disabled or invisible candidates', () => {
    expect(scoreActionCandidate({ text: 'Create API key', visible: true, disabled: true })).toBe(0);
    expect(scoreActionCandidate({ text: 'Create API key', visible: false })).toBe(0);
  });
});

describe('resolveActionCandidate', () => {
  it('returns the winning candidate for clear English matches', () => {
    const candidate = { text: 'Create API key', visible: true };
    expect(resolveActionCandidate([candidate, { text: 'Delete API key', visible: true }])).toBe(candidate);
  });

  it('returns the winning candidate for clean Chinese matches', () => {
    const candidate = { text: '创建 API 密钥', visible: true };
    expect(resolveActionCandidate([candidate])).toBe(candidate);
    expect(resolveActionCandidate([{ text: 'OK', visible: true }, candidate])).toBe(candidate);
  });

  it('returns null when every candidate is low confidence', () => {
    expect(resolveActionCandidate([{ text: 'OK', visible: true }, { text: 'Create', visible: true }])).toBeNull();
    expect(resolveActionCandidate([{ text: '创建', visible: true }])).toBeNull();
  });

  it('returns null for dangerous-only candidate sets', () => {
    expect(resolveActionCandidate([{ text: 'Delete API key', visible: true }])).toBeNull();
    expect(resolveActionCandidate([{ text: '重置', visible: true }])).toBeNull();
    expect(resolveActionCandidate([{ text: 'Create API key', visible: true, disabled: true }])).toBeNull();
  });

  it('returns null when the top two are within the safety margin', () => {
    const a = { text: 'Create API key', visible: true };
    const b = { text: '创建 API 密钥', visible: true };
    expect(resolveActionCandidate([a, b])).toBeNull();
    expect(resolveActionCandidate([a, { text: 'Create API key', visible: true, ariaLabel: 'Create API key' }])).toBeNull();
  });

  it('resolves when the top two are far enough apart', () => {
    const a = { text: 'Create API key', visible: true };
    const b = { text: 'OK', ariaLabel: 'Create API key', visible: true };
    const winner = resolveActionCandidate([a, b]);
    expect(winner).toBe(a);
    expect(resolveActionCandidate([b, a])).toBe(a);
  });

  it('returns null for empty or invalid input', () => {
    expect(resolveActionCandidate([])).toBeNull();
    expect(resolveActionCandidate(undefined)).toBeNull();
    expect(resolveActionCandidate(null)).toBeNull();
  });
});

describe('scoreActionCandidate (configured platform phrases)', () => {
  it('scores exact configured English phrases and ignores non-configured ones', () => {
    const opts = { phrases: ['Create API Key', 'Add Key'] };
    expect(scoreActionCandidate({ text: 'Create API Key', visible: true }, opts)).toBe(100);
    expect(scoreActionCandidate({ text: 'Add Key', visible: true }, opts)).toBe(100);
    expect(scoreActionCandidate({ text: 'Create Key', visible: true }, opts)).toBe(0);
    const contained = scoreActionCandidate({ text: 'Create API Key button', visible: true }, opts);
    expect(contained).toBeGreaterThanOrEqual(70);
    expect(contained).toBeLessThan(100);
  });

  it('scores exact configured Chinese phrases with contained phrases lower', () => {
    const opts = { phrases: ['创建 API 密钥', '新建 API Key'] };
    expect(scoreActionCandidate({ text: '创建 API 密钥', visible: true }, opts)).toBe(100);
    expect(scoreActionCandidate({ text: '新建 API Key', visible: true }, opts)).toBe(100);
    expect(scoreActionCandidate({ text: '创建 API 密钥管理页面', visible: true }, opts)).toBe(75);
    expect(scoreActionCandidate({ text: '请新建 API Key 后继续', visible: true }, opts)).toBe(75);
    expect(scoreActionCandidate({ text: '未配置', visible: true }, opts)).toBe(0);
  });

  it('falls back to safe default phrases when options.phrases is absent', () => {
    expect(scoreActionCandidate({ text: '确定', visible: true })).toBe(100);
    expect(scoreActionCandidate({ text: 'New API key', visible: true })).toBe(100);
  });
});

describe('scoreActionCandidate (generic inside verified scope)', () => {
  it('allows a configured generic phrase only inside a verified scope or selector', () => {
    const opts = { phrases: ['创建', 'Add'], allowGenericInsideScope: true };
    expect(scoreActionCandidate({ text: '创建', visible: true }, opts)).toBe(0);
    const inScope = scoreActionCandidate({ text: '创建', visible: true, inVerifiedScope: true }, opts);
    expect(inScope).toBeGreaterThanOrEqual(70);
    const selector = scoreActionCandidate({ text: '创建', visible: true, selectorMatch: true }, opts);
    expect(selector).toBeGreaterThanOrEqual(70);
    expect(scoreActionCandidate({ text: 'Add', visible: true }, opts)).toBe(100);
  });

  it('keeps generic phrases gated off without allowGenericInsideScope', () => {
    const opts = { phrases: ['创建', '新建'] };
    expect(scoreActionCandidate({ text: '创建', visible: true, inVerifiedScope: true }, opts)).toBe(0);
    // Selector evidence is a separate stable signal (see the selector-evidence
    // suite below) — a bare in-scope generic phrase without it stays gated off.
    expect(scoreActionCandidate({ text: '新建', visible: true, inVerifiedScope: true }, opts)).toBe(0);
  });

  it('never lets destructive terms pass, even inside a verified scope', () => {
    const opts = { phrases: ['创建', '重置'], allowGenericInsideScope: true };
    expect(scoreActionCandidate({ text: '重置', visible: true, inVerifiedScope: true }, opts)).toBe(0);
    expect(scoreActionCandidate({ text: '创建', ariaLabel: '重置', visible: true, inVerifiedScope: true }, opts)).toBe(0);
  });
});

describe('resolveActionCandidate (options)', () => {
  it('prefers the selector-matched candidate over a text-only tie', () => {
    const opts = { phrases: ['确定', '确认'] };
    const plain = { text: '确定', visible: true, inVerifiedScope: true };
    const matched = { text: '确定', visible: true, inVerifiedScope: true, selectorMatch: true };
    expect(resolveActionCandidate([plain, matched], opts)).toBe(matched);
  });

  it('fails closed on ambiguity between equal candidates', () => {
    const opts = { phrases: ['确定', '确认'] };
    const a = { text: '确定', visible: true, inVerifiedScope: true };
    const b = { text: '确定', visible: true, inVerifiedScope: true };
    expect(resolveActionCandidate([a, b], opts)).toBeNull();

    const generic = { phrases: ['创建', '新建'], allowGenericInsideScope: true };
    expect(resolveActionCandidate([
      { text: '创建', visible: true, inVerifiedScope: true },
      { text: '新建', visible: true, inVerifiedScope: true },
    ], generic)).toBeNull();
  });

  it('resolves a single scope-only generic candidate but never a bare one', () => {
    const opts = { phrases: ['创建'], allowGenericInsideScope: true };
    const confirmBtn = { text: '创建', visible: true, inVerifiedScope: true };
    expect(resolveActionCandidate([{ text: 'OK', visible: true, inVerifiedScope: true }, confirmBtn], opts)).toBe(confirmBtn);
    expect(resolveActionCandidate([{ text: '创建', visible: true }], opts)).toBeNull();
  });

  it('lets a configured specific phrase win over an in-scope generic one', () => {
    const opts = { phrases: ['确定', '新建'], allowGenericInsideScope: true };
    const specific = { text: '确定', visible: true, inVerifiedScope: true };
    const generic = { text: '新建', visible: true, inVerifiedScope: true };
    expect(resolveActionCandidate([generic, specific], opts)).toBe(specific);
  });

  it('honours threshold and margin overrides', () => {
    const opts = { phrases: ['Create'], allowGenericInsideScope: true };
    const inScope = { text: 'Create', visible: true, inVerifiedScope: true };
    expect(resolveActionCandidate([inScope], opts)).toBe(inScope);
    expect(resolveActionCandidate([inScope], { ...opts, threshold: 95 })).toBeNull();

    const a = { text: '确定', visible: true, inVerifiedScope: true };
    const b = { text: '确认', visible: true, inVerifiedScope: true };
    expect(resolveActionCandidate([a, b], { phrases: ['确定', '确认'], margin: 0 })).not.toBeNull();
  });

  it('preserves confirmAfterNameInput via a below-name score bonus', () => {
    const opts = { phrases: ['确定'], belowNameInputBonus: true };
    const above = { text: '确定', visible: true, inVerifiedScope: true, belowNameInput: false };
    const below = { text: '确定', visible: true, inVerifiedScope: true, belowNameInput: true };
    expect(resolveActionCandidate([above, below], opts)).toBe(below);
    expect(resolveActionCandidate([above, below], { phrases: ['确定'] })).toBeNull();
  });
});

describe('scoreActionCandidate / resolveActionCandidate (stable selector evidence)', () => {
  it('accepts a single selector-only candidate with a safe base score of 90', () => {
    const only = { text: '', selectorMatch: true, visible: true };
    expect(scoreActionCandidate(only)).toBe(90);
    expect(scoreActionCandidate({ selectorMatch: true, visible: true })).toBe(90);
    expect(resolveActionCandidate([{ text: 'OK', visible: true }, only])).toBe(only);
    expect(resolveActionCandidate([only])).toBe(only);
  });

  it('only grants the selector base to visible enabled candidates', () => {
    expect(scoreActionCandidate({ text: '', selectorMatch: true, disabled: true })).toBe(0);
    expect(scoreActionCandidate({ text: '', selectorMatch: true, visible: false })).toBe(0);
  });

  it('rejects destructive labels even when selector-matched', () => {
    expect(scoreActionCandidate({ text: '删除', selectorMatch: true, visible: true })).toBe(0);
    expect(scoreActionCandidate({ text: '重置', title: '提交', selectorMatch: true, visible: true })).toBe(0);
    expect(scoreActionCandidate({ text: '确定', ariaLabel: '删除', selectorMatch: true, visible: true })).toBe(0);
    expect(resolveActionCandidate([{ text: '重置', selectorMatch: true, visible: true }])).toBeNull();
  });

  it('keeps two selector-only candidates ambiguous via the safety margin', () => {
    const a = { text: '', selectorMatch: true, visible: true };
    const b = { text: '', selectorMatch: true, visible: true };
    expect(scoreActionCandidate(a)).toBe(90);
    expect(scoreActionCandidate(b)).toBe(90);
    expect(resolveActionCandidate([a, b])).toBeNull();
  });

  it('lets phrase or bonus evidence break a selector-only tie', () => {
    const only = { text: '', selectorMatch: true, visible: true };
    const phrase = { text: '确定', selectorMatch: true, visible: true };
    expect(resolveActionCandidate([only, phrase])).toBe(phrase);
  });
});

describe('isValidZhipuApiKey', () => {
  it('accepts a full 32-hex-dot-alnum key', () => {
    expect(isValidZhipuApiKey('53f6f0c2a72a4c8e893a9b48c1d8f3bd.i2IC1jQfoptP1xOe')).toBe(true);
  });

  it('accepts a secret tail of exactly 6 ASCII alnums', () => {
    expect(isValidZhipuApiKey('53f6f0c2a72a4c8e893a9b48c1d8f3bd.aBcD12')).toBe(true);
  });

  it('rejects a bare 32-hex id without the secret tail', () => {
    expect(isValidZhipuApiKey('53f6f0c2a72a4c8e893a9b48c1d8f3bd')).toBe(false);
  });

  it('rejects masked/elided values containing asterisks or ellipses', () => {
    expect(isValidZhipuApiKey('53f6...ctd.i2IC****')).toBe(false);
    expect(isValidZhipuApiKey('53f6f0c2a72a4c8e893a9b48c1d8f3bd.i2IC***')).toBe(false);
    expect(isValidZhipuApiKey('53f6f0c2a72a4c8e893a9b48c1d8f3bd.i2IC…')).toBe(false);
    expect(isValidZhipuApiKey('53f6f0c2a72a4c8e893a9b48c1d8f3bd.i2IC...')).toBe(false);
  });

  it('rejects malformed shapes and non-strings', () => {
    expect(isValidZhipuApiKey('53F6F0C2A72A4C8E893A9B48C1D8F3BD.i2IC1jQf')).toBe(false);
    expect(isValidZhipuApiKey('53f6f0c2a72a4c8e893a9b48c1d8f3bd.abc')).toBe(false);
    expect(isValidZhipuApiKey('53f6f0c2a72a4c8e893a9b48c1d8f3bd.')).toBe(false);
    expect(isValidZhipuApiKey('')).toBe(false);
    expect(isValidZhipuApiKey(null)).toBe(false);
    expect(isValidZhipuApiKey(undefined)).toBe(false);
  });
});

describe('MiniMax response extraction', () => {
  it('extracts a token from the backend creation response', () => {
    const token = `sk-api-${'a'.repeat(32)}`;
    expect(extractKeyFromCaptures([{
      method: 'POST',
      responseStatus: 200,
      url: 'https://www.minimaxi.com/backend/token',
      responsePreview: JSON.stringify({ data: { token } }),
    }], 'minimax')).toBe(token);
  });
});

describe('classifyXiaomiTokenPlanIcon', () => {
  it('classifies the 20x20 two-path icon as copy', () => {
    expect(classifyXiaomiTokenPlanIcon({ viewBox: '0 0 20 20', pathCount: 2 })).toBe('copy');
  });

  it('classifies the 18x18 single-path icon as reset', () => {
    expect(classifyXiaomiTokenPlanIcon({ viewBox: '0 0 18 18', pathCount: 1 })).toBe('reset');
  });

  it('normalizes whitespace in the viewBox', () => {
    expect(classifyXiaomiTokenPlanIcon({ viewBox: '0 0  20 20', pathCount: 2 })).toBe('copy');
    expect(classifyXiaomiTokenPlanIcon({ viewBox: '  0 0 18 18 ', pathCount: 1 })).toBe('reset');
  });

  it('returns unknown for any other shape', () => {
    expect(classifyXiaomiTokenPlanIcon({ viewBox: '0 0 20 20', pathCount: 1 })).toBe('unknown');
    expect(classifyXiaomiTokenPlanIcon({ viewBox: '0 0 18 18', pathCount: 2 })).toBe('unknown');
    expect(classifyXiaomiTokenPlanIcon({ viewBox: '0 0 24 24', pathCount: 2 })).toBe('unknown');
    expect(classifyXiaomiTokenPlanIcon({ viewBox: '0 0 20 20', pathCount: 3 })).toBe('unknown');
    expect(classifyXiaomiTokenPlanIcon({ viewBox: '', pathCount: 2 })).toBe('unknown');
    expect(classifyXiaomiTokenPlanIcon({ viewBox: undefined, pathCount: 0 })).toBe('unknown');
    expect(classifyXiaomiTokenPlanIcon({})).toBe('unknown');
  });
});

describe('representative bilingual platform wiring', () => {
  const platform = (id: string) => AUTO_CREATE_PLATFORMS.find((item: { id: string }) => item.id === id);

  it('wires Anthropic create and confirm actions in English and Chinese', () => {
    const anthropic = platform('anthropic');
    expect(anthropic.createTexts).toEqual(expect.arrayContaining(['Create key', '创建密钥']));
    expect(anthropic.confirmTexts).toEqual(expect.arrayContaining(['Add', '添加']));
  });

  it('wires ordinary and Token Plan Xiaomi actions bilingually', () => {
    const xiaomi = platform('xiaomi');
    const tokenPlan = platform('xiaomi-coding');
    expect(xiaomi.createTexts).toEqual(expect.arrayContaining(['Create API Key', '创建 API Key']));
    expect(xiaomi.confirmTexts).toEqual(expect.arrayContaining(['Confirm', '确认']));
    expect(tokenPlan.createTexts).toEqual(expect.arrayContaining(['Create API Key', '创建 API Key']));
    expect(tokenPlan.postCreateCopyTexts).toEqual(expect.arrayContaining(['Copy', '复制']));
  });

  it('keeps GLM create/confirm labels bilingual and API-key specific', () => {
    expect(ZHIPU_CREATE_TEXTS).toEqual(expect.arrayContaining(['新建API Key', 'Create API Key']));
    expect(ZHIPU_CREATE_TEXTS).not.toEqual(expect.arrayContaining(['新建', 'Add']));
    expect(ZHIPU_CONFIRM_TEXTS).toEqual(expect.arrayContaining(['确定', 'Confirm']));
  });

  it('accepts only a complete GLM id.secret capture', () => {
    const full = '53f6f0c2a72a4c8e893a9b48c1d8f3bd.i2IC1jQfoptP1xOe';
    const bare = '53f6f0c2a72a4c8e893a9b48c1d8f3bd';
    expect(extractKeyFromCaptures([{ responsePreview: JSON.stringify({ api_key: full }) }], 'zhipu')).toBe(full);
    expect(extractKeyFromCaptures([{ responsePreview: JSON.stringify({ api_key: bare }) }], 'zhipu')).toBeNull();
    expect(extractKeyFromCaptures([{ responsePreview: JSON.stringify({ api_key: `${bare}.******` }) }], 'zhipu')).toBeNull();
  });
});
