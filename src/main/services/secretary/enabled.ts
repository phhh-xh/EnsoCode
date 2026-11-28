import { readSettingsState } from '../../ipc/settings';

/** 实验开关：关闭时秘书 IPC、工具执行与会话 spawn 一律按 disabled 拒绝 */
export function secretaryEnabled(): boolean {
  return readSettingsState()?.secretaryEnabled === true;
}

/** 实验子开关（设置 → 实验功能 → 秘书）：关闭时停止触发新 flush 与换代，已有跨代历史照常可读 */
export function secretaryContextGenerationsEnabled(): boolean {
  const state = readSettingsState();
  return state?.secretaryEnabled === true && state?.secretaryContextGenerationsEnabled === true;
}
