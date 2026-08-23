export interface AgentMeta {
  id: string;
  name: string;
  supportedTypes: string[];
  command: string;
  launchType: string;
  appName?: string;
}

export const AGENTS_META: AgentMeta[] = [
  { id: 'claude', name: 'Claude Code', supportedTypes: ['anthropic'], command: 'claude', launchType: 'cli' },
  { id: 'codex', name: 'ChatGPT', supportedTypes: ['openai'], command: 'codex', launchType: 'cli' },
  { id: 'opencode', name: 'OpenCode', supportedTypes: ['anthropic', 'openai'], command: 'opencode', launchType: 'cli' },
  { id: 'openclaw', name: 'OpenClaw', supportedTypes: ['anthropic', 'openai'], command: 'openclaw', launchType: 'cli' },
  { id: 'workbuddy', name: 'WorkBuddy', supportedTypes: ['anthropic', 'openai'], command: 'workbuddy', launchType: 'app', appName: 'WorkBuddy' },
  { id: 'zcode', name: 'ZCode', supportedTypes: ['anthropic', 'openai'], command: 'zcode', launchType: 'app', appName: 'ZCode' },
  { id: 'hermes', name: 'Hermes', supportedTypes: ['anthropic', 'openai'], command: 'hermes', launchType: 'cli' },
  { id: 'kimi-code', name: 'Kimi Code', supportedTypes: ['openai'], command: 'kimi', launchType: 'cli' },
  { id: 'grok', name: 'Grok Build', supportedTypes: ['openai', 'anthropic'], command: 'grok', launchType: 'cli' },
  { id: 'mimo-code', name: 'MiMo Code', supportedTypes: ['openai', 'anthropic'], command: 'mimo', launchType: 'cli' },
];