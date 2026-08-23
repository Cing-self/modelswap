import claude from './claude.png';
import chatgpt from './chatgpt.png';
import workbuddy from './workbuddy.png';
import zcode from './zcode.png';
import hermes from './hermes.png';
import kimiCode from './kimi-code.png';
import opencode from './opencode.png';
import openclaw from './openclaw.png';
import grok from './grok.png';
import mimoCode from './mimo-code.png';

const ICON_MAP: Record<string, string> = {
  'claude': claude,
  'codex': chatgpt,
  'workbuddy': workbuddy,
  'zcode': zcode,
  'hermes': hermes,
  'kimi-code': kimiCode,
  'opencode': opencode,
  'openclaw': openclaw,
  'grok': grok,
  'mimo-code': mimoCode,
};

export function getAgentIcon(agentId: string): string {
  return ICON_MAP[agentId] || '';
}

// Transparent monochrome icons that disappear on dark cards; CSS inverts them
// in dark mode (see .brand-icon-invert-dark in components.css).
const DARK_INVERT_AGENTS = new Set(['zcode']);

export function getAgentIconClass(agentId: string): string {
  return DARK_INVERT_AGENTS.has(agentId) ? 'brand-icon-invert-dark' : '';
}
