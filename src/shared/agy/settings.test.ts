import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '../types/llm';
import {
  AGY_DEFAULT_MODEL_ID,
  AGY_DEFAULT_MODEL_NAME,
  AGY_PROVIDER_ID,
  AGY_PROVIDER_NAME,
} from './constants';
import { agySettingsProvider, parseAgySettings, withAgyProvider } from './settings';
import { EMPTY_AGY_SETTINGS } from './types';

describe('parseAgySettings', () => {
  it('treats agy as not added on a fresh install', () => {
    expect(parseAgySettings(undefined).added).toBe(false);
    expect(EMPTY_AGY_SETTINGS.added).toBe(false);
  });

  it('keeps agy for settings saved before the added flag existed', () => {
    // 这些用户的服务商列表里一直有 agy cli；升级不能让它凭空消失
    expect(parseAgySettings({ binaryPath: '', skipPermissions: false }).added).toBe(true);
  });

  it('honours an explicit removal', () => {
    expect(
      parseAgySettings({ added: false, binaryPath: '/opt/agy', skipPermissions: true })
    ).toEqual({ added: false, binaryPath: '/opt/agy', skipPermissions: true });
  });
});

describe('withAgyProvider', () => {
  const api: ModelProvider = {
    id: 'api',
    name: 'API',
    api: 'openai-completions',
    apiKey: 'k',
    baseUrl: 'https://example.test',
    enabled: true,
    models: [],
  };

  it('lists agy cli only while it is added', () => {
    expect(
      withAgyProvider([api], { ...EMPTY_AGY_SETTINGS, added: true }, []).map((p) => p.id)
    ).toEqual(['api', AGY_PROVIDER_ID]);
    expect(withAgyProvider([api], EMPTY_AGY_SETTINGS, []).map((p) => p.id)).toEqual(['api']);
  });

  it('does not bring agy back from probed models after removal', () => {
    const models = [{ id: 'gemini-3-pro', name: 'Gemini 3 Pro' }];
    expect(
      withAgyProvider([], { added: false, binaryPath: '', skipPermissions: false }, models)
    ).toEqual([]);
  });
});

describe('agySettingsProvider', () => {
  it('offers only the default model before agy has been probed', () => {
    expect(agySettingsProvider([]).models.map((model) => model.id)).toEqual([AGY_DEFAULT_MODEL_ID]);
  });

  it('labels the default model 默认 rather than the provider name', () => {
    const provider = agySettingsProvider([]);
    expect(provider.name).toBe(AGY_PROVIDER_NAME);
    expect(provider.models[0]).toEqual({ id: 'default', label: AGY_DEFAULT_MODEL_NAME });
    expect(AGY_DEFAULT_MODEL_NAME).toBe('默认');
  });

  it('keeps the default model next to the probed ones, as the worker catalog does', () => {
    // 选择器在探测前选了 agy-cli/default，Main 探测后仍要认得它，否则会话起不来、也切不过去
    const ids = agySettingsProvider([
      { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ]).models.map((model) => model.id);
    expect(ids).toEqual([AGY_DEFAULT_MODEL_ID, 'gemini-4-hydrogen', 'gemini-3.8-flash']);
  });
});
