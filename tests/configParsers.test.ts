import { describe, expect, it } from 'vitest';
import { parseTomlValue, tryParseToml } from '../src/web/frontend/src/components/shared/configParsers';

describe('tryParseToml', () => {
  it('parses sections, dotted keys, and typed values', () => {
    const out = tryParseToml([
      '[model]',
      'name = "grok-4"',
      'enabled = true',
      'retries = 3',
      '[model.providers.openai]',
      'base_url = "https://api.openai.com"',
      'keys = ["a", "b"]',
    ].join('\n'));
    expect(out).toEqual({
      model: {
        name: 'grok-4',
        enabled: true,
        retries: 3,
        providers: { openai: { base_url: 'https://api.openai.com', keys: ['a', 'b'] } },
      },
    });
  });

  it('handles inline tables and comments', () => {
    const out = tryParseToml('meta = { a = 1, b = "x" } # trailing comment');
    expect(out).toEqual({ meta: { a: 1, b: 'x' } });
  });

  it('parses arrays of tables', () => {
    const out = tryParseToml([
      '[[apps]]',
      'name = "one"',
      '[[apps]]',
      'name = "two"',
    ].join('\n'));
    expect(out).toEqual({ apps: [{ name: 'one' }, { name: 'two' }] });
  });

  it('returns undefined on malformed input', () => {
    expect(tryParseToml('this is not toml')).toBeUndefined();
    expect(tryParseToml('key = "unterminated')).toBeUndefined();
  });
});

describe('parseTomlValue', () => {
  it('parses scalars and collections', () => {
    expect(parseTomlValue('"hi\\n\\tthere"')).toBe('hi\n\tthere');
    expect(parseTomlValue("'raw \\n'")).toBe('raw \\n');
    expect(parseTomlValue('true')).toBe(true);
    expect(parseTomlValue('42')).toBe(42);
    expect(parseTomlValue('3.14')).toBe(3.14);
    expect(parseTomlValue('["a", 1, false]')).toEqual(['a', 1, false]);
    expect(parseTomlValue('{ x = 1, y = "z" }')).toEqual({ x: 1, y: 'z' });
    expect(parseTomlValue('2024-01-01')).toBe('2024-01-01');
  });
});