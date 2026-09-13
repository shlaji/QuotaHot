/**
 * 内置的模型清单，只作**兜底**使用。
 *
 * 正常情况下下拉框里的选项是按账户向上游问来的（见 server/catalog.ts），
 * 这份清单只在没有对应账户、或者目录接口查不通时顶上，免得下拉框变成空的。
 * 它从来都不是白名单——配置依然接受任意字符串，新模型可以直接手输 ID。
 */
import type { ModelOption, SendProvider } from './types.js';

export type { ModelOption };

export const MODEL_OPTIONS: Record<SendProvider, ModelOption[]> = {
  claude: [
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    { id: 'claude-fable-5', label: 'Claude Fable 5' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  ],
  codex: [
    { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { id: 'gpt-5', label: 'GPT-5' },
  ],
};

/** 判断某个 ID 是否在已列出的选项中，也就是下拉框能否直接展示它。 */
export function isKnownModel(provider: SendProvider, id: string): boolean {
  return MODEL_OPTIONS[provider].some((m) => m.id === id);
}
