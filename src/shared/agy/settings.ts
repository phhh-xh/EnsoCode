import type { ModelProvider } from '../types/llm';
import {
  AGY_DEFAULT_MODEL_ID,
  AGY_DEFAULT_MODEL_NAME,
  AGY_PROVIDER_ID,
  AGY_PROVIDER_NAME,
} from './constants';
import type { AgyModelOption, AgySettings } from './types';

export function parseAgySettings(value: unknown): AgySettings {
  const row =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { added?: unknown; binaryPath?: unknown; skipPermissions?: unknown })
      : undefined;
  return {
    // 没有 added 的旧对象来自 agy 还无条件列出的版本：这些用户一直看得到它，升级后保留
    added: row ? row.added !== false : false,
    binaryPath: typeof row?.binaryPath === 'string' ? row.binaryPath : '',
    skipPermissions: row?.skipPermissions === true,
  };
}

/** 与 worker 的 agyCatalog 一致：默认项（不设模型、用 agy 自己的默认）始终在，探测到的模型排在后面 */
export function agySettingsProvider(models: readonly AgyModelOption[]): ModelProvider {
  const list = models.some((model) => model.id === AGY_DEFAULT_MODEL_ID)
    ? models
    : [{ id: AGY_DEFAULT_MODEL_ID, name: AGY_DEFAULT_MODEL_NAME }, ...models];
  return {
    id: AGY_PROVIDER_ID,
    name: AGY_PROVIDER_NAME,
    api: 'openai-completions',
    apiKey: '',
    baseUrl: '',
    enabled: true,
    models: list.map((model) => ({ id: model.id, label: model.name })),
  };
}

/** Main 与 renderer 共用：只有用户添加了 agy cli 才把它并进服务商清单。 */
export function withAgyProvider(
  providers: ModelProvider[],
  agy: unknown,
  models: readonly AgyModelOption[]
): ModelProvider[] {
  if (!parseAgySettings(agy).added) return providers;
  if (providers.some((provider) => provider.id === AGY_PROVIDER_ID)) return providers;
  return [...providers, agySettingsProvider(models)];
}

/** 只能在会话里经 agy bridge 跑的 provider：标题、提交信息、代审、压缩这类一次性请求不能用。 */
export function isSessionOnlyProvider(provider: { id?: string }): boolean {
  return provider.id === AGY_PROVIDER_ID;
}
