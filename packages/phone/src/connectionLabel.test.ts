import { describe, expect, it } from 'vitest';
import { formatOnlineConnectionLabel } from './connectionLabel';

describe('formatOnlineConnectionLabel', () => {
  it('无采样时保持原标签', () => {
    expect(formatOnlineConnectionLabel('direct', null)).toBe('已连接 · 直连');
    expect(formatOnlineConnectionLabel('relay', null)).toBe('已连接 · 中继');
  });

  it('有采样时接在直连/中继后面', () => {
    expect(formatOnlineConnectionLabel('direct', 32)).toBe('已连接 · 直连 · 32ms');
    expect(formatOnlineConnectionLabel('relay', 180.4)).toBe('已连接 · 中继 · 180ms');
  });

  it('不足 1ms 显示 <1ms', () => {
    expect(formatOnlineConnectionLabel('direct', 0.2)).toBe('已连接 · 直连 · <1ms');
  });

  it('中继走原生 QUIC 时显式标注 QUIC，直连不受影响', () => {
    expect(formatOnlineConnectionLabel('relay', 42, 'quic')).toBe('已连接 · 中继 · QUIC · 42ms');
    expect(formatOnlineConnectionLabel('relay', null, 'quic')).toBe('已连接 · 中继 · QUIC');
    expect(formatOnlineConnectionLabel('relay', 42, 'ws')).toBe('已连接 · 中继 · 42ms');
    expect(formatOnlineConnectionLabel('direct', 8, 'quic')).toBe('已连接 · 直连 · 8ms');
  });
});
