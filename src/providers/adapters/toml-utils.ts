// Shared TOML editing helpers for the additive (multi-site) adapters that
// write into an agent's own config.toml (kimi-code, grok). All helpers are
// line-oriented and only touch the targeted tables/keys, so unrelated
// sections (the agent's own settings, other sites' entries) stay intact.

export function sanitizeTomlKey(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function tomlString(value: string): string {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Render a string->string map as a TOML inline table, e.g.
// `{ "User-Agent" = "opencode/1.18.15" }` for `custom_headers` / `http_headers`.
export function tomlInlineTable(headers: Record<string, string>): string {
  const pairs = Object.entries(headers).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`);
  return `{ ${pairs.join(", ")} }`;
}

export function normalizeToml(toml: string): string {
  return toml.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// Upsert (or insert) `key = value` into the `[tableName]` table. Keys of other
// tables and top-level keys are untouched.
export function upsertTableKey(toml: string, tableName: string, key: string, value: string): string {
  const source = toml.split("\n");
  const headerRegex = new RegExp(`^\\s*\\[${escapeRegex(tableName)}\\]\\s*(?:#.*)?$`);
  const keyRegex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);

  for (let i = 0; i < source.length; i++) {
    if (!headerRegex.test(source[i])) continue;
    let tableEnd = i + 1;
    while (tableEnd < source.length && !/^\s*\[/.test(source[tableEnd])) tableEnd++;
    for (let j = i + 1; j < tableEnd; j++) {
      if (keyRegex.test(source[j])) {
        source[j] = `${key} = ${value}`;
        return source.join("\n");
      }
    }
    source.splice(tableEnd, 0, `${key} = ${value}`);
    return normalizeToml(source.join("\n"));
  }

  return `${toml.trimEnd()}\n\n[${tableName}]\n${key} = ${value}\n`;
}

export function upsertTopLevelTomlKey(toml: string, key: string, value: string): string {
  const lines = toml.split("\n");
  let tableStart = lines.findIndex(line => line.trim().startsWith("["));
  if (tableStart === -1) tableStart = lines.length;

  for (let i = 0; i < tableStart; i++) {
    if (new RegExp(`^\\s*${escapeRegex(key)}\\s*=`).test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return lines.join("\n");
    }
  }

  lines.splice(tableStart, 0, `${key} = ${value}`);
  return normalizeToml(lines.join("\n"));
}

export function getTopLevelTomlValue(toml: string, key: string): string | null {
  const regex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*"([^"]*)"`);
  for (const line of toml.split("\n")) {
    const m = line.match(regex);
    if (m) return m[1];
  }
  return null;
}

export function removeTopLevelTomlKey(toml: string, key: string): string {
  const regex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  const out = toml.split("\n").filter(line => !regex.test(line));
  return normalizeToml(out.join("\n"));
}

// Get the value of `key` inside the `[tableName]` table (null when absent).
export function getTableKeyValue(toml: string, tableName: string, key: string): string | null {
  const source = toml.split("\n");
  const headerRegex = new RegExp(`^\\s*\\[${escapeRegex(tableName)}\\]\\s*(?:#.*)?$`);
  const keyRegex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*"([^"]*)"`);
  let inTable = false;
  for (const line of source) {
    if (/^\s*\[/.test(line)) inTable = headerRegex.test(line);
    else if (inTable) {
      const m = line.match(keyRegex);
      if (m) return m[1];
    }
  }
  return null;
}

// Remove `key` (and its line) from inside the `[tableName]` table.
export function removeTableKey(toml: string, tableName: string, key: string): string {
  const source = toml.split("\n");
  const headerRegex = new RegExp(`^\\s*\\[${escapeRegex(tableName)}\\]\\s*(?:#.*)?$`);
  const keyRegex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  const out: string[] = [];
  let inTable = false;
  for (const line of source) {
    if (/^\s*\[/.test(line)) inTable = headerRegex.test(line);
    if (inTable && keyRegex.test(line)) continue;
    out.push(line);
  }
  return normalizeToml(out.join("\n"));
}

// Upsert (or insert) a `[tableName]` table whose body is `lines`.
export function upsertTomlTable(toml: string, tableName: string, lines: string[]): string {
  const header = `[${tableName}]`;
  const tableLines = [header, ...lines];
  const sourceLines = toml.split("\n");
  const headerRegex = new RegExp(`^\\s*\\[${escapeRegex(tableName)}\\]\\s*(?:#.*)?$`);
  const tableStart = sourceLines.findIndex(line => headerRegex.test(line));

  if (tableStart >= 0) {
    let tableEnd = tableStart + 1;
    while (tableEnd < sourceLines.length && !/^\s*\[/.test(sourceLines[tableEnd])) {
      tableEnd++;
    }

    const before = sourceLines.slice(0, tableStart);
    const after = sourceLines.slice(tableEnd);
    while (before.length && before[before.length - 1].trim() === "") before.pop();
    while (after.length && after[0].trim() === "") after.shift();

    return [
      ...before,
      ...(before.length ? [""] : []),
      ...tableLines,
      ...(after.length ? ["", ...after] : [""]),
    ].join("\n");
  }

  return `${toml.trimEnd()}\n\n${tableLines.join("\n")}\n`;
}

// Strip every table whose header matches one of `patterns` (whole tables,
// including their bodies). Everything else is preserved verbatim.
export function stripMatchingTables(toml: string, patterns: RegExp[]): string {
  const source = toml.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of source) {
    if (skipping) {
      if (/^\s*\[/.test(line)) skipping = false;
      else continue;
    }
    if (patterns.some(re => re.test(line))) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return normalizeToml(out.join("\n"));
}