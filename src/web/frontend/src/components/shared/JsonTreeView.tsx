import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useI18n } from '../../i18n';
import { parseTomlValue, tryParseToml } from './configParsers';

interface Props {
  value: string;
  fileName?: string;
}

const MAX_STRING_CHARS = 80;
const DEFAULT_OPEN_DEPTH = 2;
const MAX_VISIBLE_ITEMS = 200;

function truncate(s: string): string {
  if (s.length <= MAX_STRING_CHARS) return s;
  return `${s.slice(0, MAX_STRING_CHARS)}…`;
}

// Keys that hold secrets — render masked so accidental screenshots don't leak.
const SECRET_KEY = /api[-_]?key|secret|token|password|credential|authorization/i;

function formatString(s: string, secret: boolean): string {
  if (secret) return `"${s.slice(0, 3)}••••${s.slice(-3)}"`;
  return `"${truncate(s)}"`;
}

interface NodeProps {
  name?: string;
  value: unknown;
  depth: number;
}

function JsonNode({ name, value, depth }: NodeProps) {
  const { t } = useI18n();
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === 'object' && !isArray;
  const isCollapsible = isArray || isObject;

  // Default: objects/arrays nested deeper than DEFAULT_OPEN_DEPTH start
  // collapsed. Very large containers also collapse to keep the DOM light.
  const defaultOpen = !isCollapsible
    || (depth < DEFAULT_OPEN_DEPTH && !(isArray && (value as unknown[]).length > MAX_VISIBLE_ITEMS));
  const [open, setOpen] = useState(defaultOpen);

  if (!isCollapsible) {
    // Scalar leaf.
    let rendered: string;
    let cls = 'jtree-value';
    if (value === null) { rendered = 'null'; cls = 'jtree-null'; }
    else if (typeof value === 'boolean') { rendered = String(value); cls = 'jtree-bool'; }
    else if (typeof value === 'number') { rendered = String(value); cls = 'jtree-num'; }
    else if (typeof value === 'string') {
      rendered = formatString(value, name ? SECRET_KEY.test(name) : false);
      cls = 'jtree-str';
    } else {
      rendered = String(value);
    }
    return (
      <div className="jtree-row jtree-leaf" style={{ paddingLeft: depth * 18 }}>
        {name !== undefined && <span className="jtree-key">{name}: </span>}
        <span className={cls} title={typeof value === 'string' ? value : undefined}>{rendered}</span>
      </div>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const visible = entries.slice(0, MAX_VISIBLE_ITEMS);
  const overflow = entries.length - visible.length;
  const summary = `${entries.length} ${t('jtree.items')}`;
  const closeBracket = isArray ? ']' : '}';

  return (
    <div className="jtree-branch">
      <button
        type="button"
        className="jtree-toggle"
        style={{ paddingLeft: depth * 18 }}
        onClick={() => setOpen(o => !o)}
        title={open ? t('jtree.collapse') : t('jtree.expand')}
      >
        <span className={`jtree-caret${open ? ' open' : ''}`}><ChevronRight size={11} /></span>
        {name !== undefined && <span className="jtree-key">{name}: </span>}
        {isArray ? <span className="jtree-bracket">[</span> : <span className="jtree-bracket">{'{'}</span>}
        {!open && <><span className="jtree-summary">{summary}</span><span className="jtree-bracket">{closeBracket}</span></>}
      </button>
      {open && (
        <div className="jtree-children">
          {visible.map(([k, v]) => (
            <JsonNode key={k} name={k} value={v} depth={depth + 1} />
          ))}
          {overflow > 0 && (
            <div className="jtree-row jtree-more" style={{ paddingLeft: (depth + 1) * 18 }}>
              {t('jtree.more', { count: overflow })}
            </div>
          )}
          <div className="jtree-row jtree-bracket-close" style={{ paddingLeft: depth * 18 }}>
            <span className="jtree-bracket">{closeBracket}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Collapsible tree view. Tries JSON, then TOML; falls back to a plain <pre>
// when the content can't be parsed. .env files are always shown as raw text.
export default function JsonTreeView({ value, fileName }: Props) {
  const base = fileName?.split('/').pop() ?? '';
  const isEnvFile = /^\.env(\.|$)/i.test(base) || /\.env(\.\w+)?$/i.test(base);
  if (isEnvFile) {
    return <pre className="home-config-file-editor" spellCheck={false}>{value}</pre>;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = tryParseToml(value);
    if (parsed === undefined) {
      return <pre className="home-config-file-editor" spellCheck={false}>{value}</pre>;
    }
  }

  return (
    <div className="jtree">
      <JsonNode value={parsed} depth={0} />
    </div>
  );
}