import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeFiles,
  discoverSecretarySessions,
  parseSimulateArg,
  READ_MULTIPLIER,
  WRITE_MULTIPLIER_5M,
} from './secretary-context-report.mjs';

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'enso-secretary-report-'));
}

test('classifies hot, cold wake, model switch, and post-compaction requests with equivalent costs', () => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, 'session.jsonl');
    const t0 = Date.parse('2026-11-28T00:00:00.000Z');
    const lines = [
      { type: 'session', version: 3, id: 's1', cwd: '/tmp/secretaries/default' },
      {
        type: 'custom_message',
        customType: 'secretary-brief',
        content: 'brief',
        display: false,
      },
      // 第 1 条：首次冷唤醒（10k 写 + 100 普通输入）
      {
        type: 'message',
        timestamp: new Date(t0).toISOString(),
        message: {
          role: 'assistant',
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          timestamp: t0,
          usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 10_000 },
        },
      },
      // 第 2 条：1 分钟后热请求（10k 读 + 2k 写 + 50 普通输入）
      {
        type: 'message',
        timestamp: new Date(t0 + 60_000).toISOString(),
        message: {
          role: 'assistant',
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          timestamp: t0 + 60_000,
          usage: { input: 50, output: 100, cacheRead: 10_000, cacheWrite: 2_000 },
        },
      },
      // 工具输出统计
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'repo_status',
          content: [{ type: 'text', text: 'x'.repeat(500) }],
        },
      },
      // 第 3 条：10 分钟后冷唤醒（超过 5m TTL）
      {
        type: 'message',
        timestamp: new Date(t0 + 11 * 60_000).toISOString(),
        message: {
          role: 'assistant',
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          timestamp: t0 + 11 * 60_000,
          usage: { input: 20, output: 80, cacheRead: 0, cacheWrite: 12_500 },
        },
      },
      // 第 4 条：1 分钟后切换模型
      {
        type: 'message',
        timestamp: new Date(t0 + 12 * 60_000).toISOString(),
        message: {
          role: 'assistant',
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-opus-4-5',
          timestamp: t0 + 12 * 60_000,
          usage: { input: 30, output: 90, cacheRead: 0, cacheWrite: 13_000 },
        },
      },
    ];
    writeFileSync(file, `${lines.map((item) => JSON.stringify(item)).join('\n')}\n`);

    const report = analyzeFiles([file], { ttl: '5m' });
    assert.equal(report.totalRequests, 4);
    assert.equal(report.claudeRequests, 4);
    assert.equal(report.generations, 1);
    assert.equal(report.breakdown.cold.count, 2);
    assert.equal(report.breakdown.hot.count, 1);
    assert.equal(report.breakdown['model-switch'].count, 1);

    const expectedHot = 50 + 10_000 * READ_MULTIPLIER + 2_000 * WRITE_MULTIPLIER_5M;
    const expectedCold = 100 + 10_000 * WRITE_MULTIPLIER_5M + (20 + 12_500 * WRITE_MULTIPLIER_5M);
    const expectedSwitch = 30 + 13_000 * WRITE_MULTIPLIER_5M;
    assert.equal(report.breakdown.hot.equivalent, expectedHot);
    assert.equal(report.breakdown.cold.equivalent, expectedCold);
    assert.equal(report.breakdown['model-switch'].equivalent, expectedSwitch);
    assert.equal(
      report.totalEquivalentTokens,
      Math.round(expectedHot + expectedCold + expectedSwitch)
    );
    assert.deepEqual(report.tools, [{ name: 'repo_status', count: 1, chars: 500, avgChars: 500 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovers secretary sessions by header cwd and simulates capped generations', () => {
  const dir = makeTempDir();
  try {
    const secFile = path.join(dir, 'sec.jsonl');
    const otherFile = path.join(dir, 'other.jsonl');
    const t0 = Date.parse('2026-11-28T01:00:00.000Z');
    writeFileSync(
      otherFile,
      `${JSON.stringify({ type: 'session', version: 3, id: 'o1', cwd: '/tmp/my-app' })}\n`
    );
    const secLines = [
      { type: 'session', version: 3, id: 's2', cwd: '/tmp/data/secretary/home' },
      {
        type: 'message',
        message: {
          role: 'assistant',
          api: 'anthropic-messages',
          model: 'claude-sonnet-4-5',
          timestamp: t0,
          usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 120_000 },
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          api: 'anthropic-messages',
          model: 'claude-sonnet-4-5',
          timestamp: t0 + 30_000,
          usage: { input: 1_000, output: 100, cacheRead: 120_000, cacheWrite: 190_000 },
        },
      },
    ];
    writeFileSync(secFile, `${secLines.map((item) => JSON.stringify(item)).join('\n')}\n`);

    const discovered = discoverSecretarySessions(dir);
    assert.deepEqual(discovered, [secFile]);

    const sim = parseSimulateArg('cap=200000,ttl=1h');
    assert.deepEqual(sim, { cap: 200_000, ttl: '1h' });
    const report = analyzeFiles(discovered, { simulate: sim });
    assert.equal(report.simulation.rotations, 1);
    assert.equal(report.simulation.byCategory.flush.count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
