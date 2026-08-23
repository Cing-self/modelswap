// Pure parsing helpers for the config-file tree preview. Kept free of React
// so they can be unit-tested directly.

// Split a string on a separator while respecting quotes and nesting depth
// (used for TOML arrays and inline tables).
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let inStr = false;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === quote && s[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function stripTomlComment(v: string): string {
  let inStr = false;
  let quote = '';
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (inStr) {
      if (ch === quote && v[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
    if (ch === '#') return v.slice(0, i).trim();
  }
  return v.trim();
}

function unquoteKey(k: string): string {
  const t = k.trim();
  return (t.startsWith('"') && t.endsWith('"') && t.length >= 2)
    ? t.slice(1, -1)
    : t;
}

export function parseTomlValue(v: string): unknown | undefined {
  if (v.startsWith('"')) {
    if (v.length < 2 || !v.endsWith('"')) return undefined;
    return v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'")) return undefined;
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) return undefined;
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    const arr: unknown[] = [];
    for (const p of splitTopLevel(inner, ',')) {
      const val = parseTomlValue(p.trim());
      if (val === undefined) return undefined;
      arr.push(val);
    }
    return arr;
  }
  if (v.startsWith('{')) {
    if (!v.endsWith('}')) return undefined;
    const inner = v.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    if (!inner) return obj;
    for (const part of splitTopLevel(inner, ',')) {
      const eq = part.indexOf('=');
      if (eq < 1) return undefined;
      const val = parseTomlValue(part.slice(eq + 1).trim());
      if (val === undefined) return undefined;
      obj[unquoteKey(part.slice(0, eq))] = val;
    }
    return obj;
  }
  return v;
}

function setTomlNested(root: Record<string, unknown>, dottedKey: string, val: unknown): void {
  const parts = dottedKey.split('.').map(unquoteKey);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = val;
}

// Minimal TOML parser: comments, [table]/[[array-of-tables]] headers, dotted
// keys, basic/literal strings, numbers, booleans, arrays, inline tables.
// Unsupported constructs (multi-line strings, dates) degrade to strings.
export function tryParseToml(text: string): Record<string, unknown> | undefined {
  const root: Record<string, unknown> = {};
  let table = root;
  let sawValue = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const isAot = line.startsWith('[[') && line.endsWith(']]');
      if (line.startsWith('[[') !== line.endsWith(']]')) return undefined;
      const path = (isAot ? line.slice(2, -2) : line.slice(1, -1)).split('.').map(unquoteKey);
      table = root;
      for (let i = 0; i < path.length; i++) {
        const key = path[i];
        const cur = table[key];
        if (i === path.length - 1 && isAot) {
          if (!Array.isArray(cur)) table[key] = [];
          const arr = table[key] as Record<string, unknown>[];
          arr.push({});
          table = arr[arr.length - 1];
        } else {
          if (!cur || typeof cur !== 'object' || Array.isArray(cur)) table[key] = {};
          table = table[key] as Record<string, unknown>;
        }
      }
      sawValue = true;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 1) return undefined;
    const key = line.slice(0, eq);
    const val = parseTomlValue(stripTomlComment(line.slice(eq + 1)));
    if (val === undefined) return undefined;
    setTomlNested(table, key, val);
    sawValue = true;
  }
  return sawValue ? root : undefined;
}