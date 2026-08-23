import { AgentAdapter, ProviderType } from "./types";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { OpenCodeAdapter } from "./adapters/opencode";
import { OpenClawAdapter } from "./adapters/openclaw";
import { WorkBuddyAdapter } from "./adapters/workbuddy";
import { ZCodeAdapter } from "./adapters/zcode";
import { HermesAdapter } from "./adapters/hermes";
import { KimiCodeAdapter } from "./adapters/kimi-code";
import { GrokAdapter } from "./adapters/grok";
import { MimoCodeAdapter } from "./adapters/mimo-code";

const adapters: AgentAdapter[] = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new OpenCodeAdapter(),
  new OpenClawAdapter(),
  new WorkBuddyAdapter(),
  new ZCodeAdapter(),
  new HermesAdapter(),
  new KimiCodeAdapter(),
  new GrokAdapter(),
  new MimoCodeAdapter(),
];

export function getAdapters(): AgentAdapter[] {
  return adapters;
}

export function getAdapter(id: string): AgentAdapter | undefined {
  return adapters.find(a => a.id === id);
}

export function getAdaptersByType(type: ProviderType): AgentAdapter[] {
  return adapters.filter(a => a.supportedTypes.includes(type));
}
