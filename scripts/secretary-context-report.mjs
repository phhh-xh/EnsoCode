#!/usr/bin/env node
// 只读分析秘书会话 jsonl 的上下文体量、缓存成本拆分、工具输出体积，并支持分代 + TTL 回放模拟。
// 用法：node scripts/secretary-context-report.mjs [file1.jsonl ...] [--sessions-dir <dir>] [--simulate cap=200000,ttl=1h] [--json]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_5M_TTL_MS = 5 * 60_000;
export const DEFAULT_1H_TTL_MS = 60 * 60_000;
export const WRITE_MULTIPLIER_5M = 1.25;
export const WRITE_MULTIPLIER_1H = 2.0;
export const READ_MULTIPLIER = 0.1;
export const SIM_NEW_GEN_BASE_TOKENS = 35_000;
export const SIM_FLUSH_OUTPUT_TOKENS = 3_000;

export function isAnthropicRequest(message) {
  const api = typeof message?.api === 'string' ? message.api.toLowerCase() : '';
  const provider = typeof message?.provider === 'string' ? message.provider.toLowerCase() : '';
  const model = typeof message?.model === 'string' ? message.model.toLowerCase() : '';
  if (api === 'anthropic-messages') return true;
  if (provider.includes('anthropic') || provider.includes('claude')) return true;
  if (model.includes('claude')) return true;
  return false;
}

function parseTimestamp(entry, message) {
  if (typeof message?.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  if (typeof entry?.timestamp === 'string') {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function usageNum(usage, key) {
  const value = usage?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') total += part.text.length;
    else if (part.type === 'thinking' && typeof part.thinking === 'string') {
      total += part.thinking.length;
    } else if (part.type === 'toolCall') {
      total += JSON.stringify(part.arguments ?? '').length;
    }
  }
  return total;
}

function extractEntry(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function parseSessionHeader(filePath) {
  try {
    const text = readFileSync(filePath, 'utf8');
    const newline = text.indexOf('\n');
    const firstLine = newline >= 0 ? text.slice(0, newline) : text;
    const entry = extractEntry(firstLine);
    if (entry?.type === 'session') return entry;
  } catch {}
  return null;
}

export function parseSimulateArg(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let cap = 200_000;
  let ttl = '1h';
  for (const part of raw.split(',')) {
    const [key, value] = part.split('=').map((item) => item.trim());
    if (!key || !value) continue;
    if (key === 'cap') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) cap = Math.floor(parsed);
    } else if (key === 'ttl') {
      if (value === '5m' || value === '1h') ttl = value;
    }
  }
  return { cap, ttl };
}

export function parseSessionJsonl(text, options = {}) {
  const ttlMs = options.ttl === '1h' ? DEFAULT_1H_TTL_MS : DEFAULT_5M_TTL_MS;
  const writeMultiplier = options.ttl === '1h' ? WRITE_MULTIPLIER_1H : WRITE_MULTIPLIER_5M;
  const requests = [];
  const toolStats = new Map();
  let generations = 0;
  let sessionHeader = null;
  let pendingCompaction = false;
  let lastClaudeModel = null;
  let lastClaudeTime = null;
  let totalRequests = 0;
  let sessionUpdateChars = 0;

  for (const line of text.split('\n')) {
    const entry = extractEntry(line);
    if (!entry) continue;
    if (entry.type === 'session') {
      sessionHeader = entry;
      continue;
    }
    if (entry.type === 'compaction') {
      pendingCompaction = true;
      continue;
    }
    if (entry.type === 'custom_message' && entry.customType === 'secretary-brief') {
      generations += 1;
      continue;
    }
    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue;
    const message = entry.message;

    if (message.role === 'user') {
      const body =
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter((part) => part?.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('')
            : '';
      if (body.includes('<session-updates>')) sessionUpdateChars += body.length;
      continue;
    }

    if (message.role === 'toolResult') {
      const toolName =
        typeof message.toolName === 'string' && message.toolName.trim()
          ? message.toolName.trim()
          : 'unknown';
      const chars = contentChars(message.content);
      const current = toolStats.get(toolName) ?? { count: 0, chars: 0 };
      current.count += 1;
      current.chars += chars;
      toolStats.set(toolName, current);
      continue;
    }

    if (message.role !== 'assistant' || !message.usage || typeof message.usage !== 'object') {
      continue;
    }

    totalRequests += 1;
    const input = usageNum(message.usage, 'input');
    const output = usageNum(message.usage, 'output');
    const cacheRead = usageNum(message.usage, 'cacheRead');
    const cacheWrite = usageNum(message.usage, 'cacheWrite');
    const contextTokens = input + cacheRead + cacheWrite;
    const timestamp = parseTimestamp(entry, message);
    const model = typeof message.model === 'string' ? message.model : '';
    const anthropic = isAnthropicRequest(message);

    if (!anthropic) continue;

    let category = 'hot';
    if (pendingCompaction) {
      category = 'post-compaction';
      pendingCompaction = false;
    } else if (lastClaudeModel !== null && model && model !== lastClaudeModel) {
      category = 'model-switch';
    } else if (lastClaudeTime === null || (timestamp > 0 && timestamp - lastClaudeTime > ttlMs)) {
      category = 'cold';
    } else if (cacheRead === 0 && cacheWrite > 0) {
      category = 'cold';
    }

    const equivalentTokens = input + cacheRead * READ_MULTIPLIER + cacheWrite * writeMultiplier;
    const deltaTokens =
      requests.length > 0
        ? Math.max(0, contextTokens - requests[requests.length - 1].contextTokens)
        : contextTokens;

    requests.push({
      timestamp,
      model,
      category,
      input,
      output,
      cacheRead,
      cacheWrite,
      contextTokens,
      deltaTokens,
      equivalentTokens,
    });

    if (model) lastClaudeModel = model;
    if (timestamp > 0) lastClaudeTime = timestamp;
  }

  return {
    header: sessionHeader,
    totalRequests,
    claudeRequests: requests,
    toolStats,
    sessionUpdateChars,
    generations,
  };
}

export function simulateGenerations(claudeRequests, config) {
  const cap = config.cap;
  const ttlMs = config.ttl === '1h' ? DEFAULT_1H_TTL_MS : DEFAULT_5M_TTL_MS;
  const writeMultiplier = config.ttl === '1h' ? WRITE_MULTIPLIER_1H : WRITE_MULTIPLIER_5M;

  let currentContext = 0;
  let lastTime = null;
  let lastModel = null;
  let totalEquivalent = 0;
  let rotations = 0;
  const byCategory = {
    hot: { count: 0, equivalent: 0 },
    cold: { count: 0, equivalent: 0 },
    'model-switch': { count: 0, equivalent: 0 },
    'post-compaction': { count: 0, equivalent: 0 },
    flush: { count: 0, equivalent: 0 },
  };

  for (const request of claudeRequests) {
    const isCold =
      lastTime === null ||
      (request.timestamp > 0 && lastTime > 0 && request.timestamp - lastTime > ttlMs);
    const isSwitch = lastModel !== null && request.model && request.model !== lastModel;
    const isPostCompaction = request.category === 'post-compaction';

    const growth =
      currentContext === 0
        ? Math.min(request.contextTokens, SIM_NEW_GEN_BASE_TOKENS)
        : Math.max(0, request.deltaTokens || request.input + request.cacheWrite);

    const nextContext = currentContext === 0 ? growth : currentContext + growth;

    let cost = 0;
    let bucket = 'hot';
    if (isPostCompaction) {
      bucket = 'post-compaction';
      cost = nextContext * writeMultiplier;
    } else if (isSwitch) {
      bucket = 'model-switch';
      cost = nextContext * writeMultiplier;
    } else if (isCold) {
      bucket = 'cold';
      cost = nextContext * writeMultiplier;
    } else {
      bucket = 'hot';
      const cached = Math.min(currentContext, nextContext);
      const written = Math.max(0, nextContext - cached);
      cost = cached * READ_MULTIPLIER + written * writeMultiplier;
    }

    byCategory[bucket].count += 1;
    byCategory[bucket].equivalent += cost;
    totalEquivalent += cost;
    currentContext = nextContext;

    if (request.timestamp > 0) lastTime = request.timestamp;
    if (request.model) lastModel = request.model;

    if (currentContext > cap) {
      // 热缓存下执行一次静默 flush，随后切到新一代
      const flushCost = currentContext * READ_MULTIPLIER + SIM_FLUSH_OUTPUT_TOKENS;
      byCategory.flush.count += 1;
      byCategory.flush.equivalent += flushCost;
      totalEquivalent += flushCost;
      rotations += 1;
      currentContext = SIM_NEW_GEN_BASE_TOKENS;
    }
  }

  return {
    cap,
    ttl: config.ttl,
    rotations,
    totalEquivalent,
    byCategory,
  };
}

export function analyzeFiles(files, options = {}) {
  const allClaude = [];
  const mergedTools = new Map();
  let totalRequests = 0;
  let generations = 0;
  let sessionUpdateChars = 0;

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const parsed = parseSessionJsonl(text, options);
    totalRequests += parsed.totalRequests;
    generations += parsed.generations;
    sessionUpdateChars += parsed.sessionUpdateChars;
    for (const req of parsed.claudeRequests) allClaude.push(req);
    for (const [name, stat] of parsed.toolStats) {
      const current = mergedTools.get(name) ?? { count: 0, chars: 0 };
      current.count += stat.count;
      current.chars += stat.chars;
      mergedTools.set(name, current);
    }
  }

  const count = allClaude.length;
  let sumContext = 0;
  let maxContext = 0;
  let totalEquivalent = 0;
  const breakdown = {
    hot: { count: 0, equivalent: 0, share: 0 },
    cold: { count: 0, equivalent: 0, share: 0 },
    'model-switch': { count: 0, equivalent: 0, share: 0 },
    'post-compaction': { count: 0, equivalent: 0, share: 0 },
  };

  for (const req of allClaude) {
    sumContext += req.contextTokens;
    if (req.contextTokens > maxContext) maxContext = req.contextTokens;
    totalEquivalent += req.equivalentTokens;
    const bucket = breakdown[req.category] ?? breakdown.hot;
    bucket.count += 1;
    bucket.equivalent += req.equivalentTokens;
  }

  for (const bucket of Object.values(breakdown)) {
    bucket.share = totalEquivalent > 0 ? bucket.equivalent / totalEquivalent : 0;
  }

  const tools = [...mergedTools.entries()]
    .map(([name, stat]) => ({
      name,
      count: stat.count,
      chars: stat.chars,
      avgChars: stat.count > 0 ? Math.round(stat.chars / stat.count) : 0,
    }))
    .sort((a, b) => b.chars - a.chars);

  const report = {
    files,
    totalRequests,
    claudeRequests: count,
    avgContextTokens: count > 0 ? Math.round(sumContext / count) : 0,
    maxContextTokens: maxContext,
    totalEquivalentTokens: Math.round(totalEquivalent),
    breakdown,
    generations,
    sessionUpdateChars,
    tools,
  };

  if (options.simulate) {
    report.simulation = simulateGenerations(allClaude, options.simulate);
  }

  return report;
}

export function defaultSessionsDir() {
  if (process.env.ENSO_USER_DATA_DIR) {
    return path.join(process.env.ENSO_USER_DATA_DIR, 'agent', 'sessions');
  }
  const home = os.homedir();
  const candidates =
    process.platform === 'darwin'
      ? [
          path.join(home, 'Library', 'Application Support', 'EnsoCode', 'agent', 'sessions'),
          path.join(home, 'Library', 'Application Support', 'enso-code', 'agent', 'sessions'),
        ]
      : process.platform === 'win32'
        ? [path.join(process.env.APPDATA ?? home, 'EnsoCode', 'agent', 'sessions')]
        : [path.join(home, '.config', 'EnsoCode', 'agent', 'sessions')];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0];
}

export function discoverSecretarySessions(sessionsDir) {
  if (!sessionsDir || !existsSync(sessionsDir)) return [];
  const matched = [];
  for (const entry of readdirSync(sessionsDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const fullPath = path.join(sessionsDir, entry);
    const header = parseSessionHeader(fullPath);
    if (typeof header?.cwd === 'string' && header.cwd.toLowerCase().includes('secretary')) {
      matched.push(fullPath);
    }
  }
  return matched.sort();
}

function formatMillions(tokens) {
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatPct(ratio) {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatReport(report) {
  const lines = [
    `Files: ${report.files.length}`,
    `Requests: total=${report.totalRequests}, claude=${report.claudeRequests}`,
    `Context: avg=${report.avgContextTokens.toLocaleString()}, max=${report.maxContextTokens.toLocaleString()}`,
    `Equivalent input tokens: ${formatMillions(report.totalEquivalentTokens)} (${report.totalEquivalentTokens.toLocaleString()})`,
    `Generations (secretary-brief): ${report.generations}`,
    '',
    'Breakdown:',
    ...Object.entries(report.breakdown).map(
      ([name, item]) =>
        `  ${name.padEnd(16)} count=${String(item.count).padEnd(6)} eq=${formatMillions(item.equivalent).padEnd(9)} share=${formatPct(item.share)}`
    ),
    '',
    `Tool results (session-updates=${report.sessionUpdateChars.toLocaleString()} chars):`,
    ...report.tools
      .slice(0, 15)
      .map(
        (tool) =>
          `  ${tool.name.padEnd(22)} count=${String(tool.count).padEnd(6)} chars=${tool.chars.toLocaleString().padEnd(11)} avg=${tool.avgChars.toLocaleString()}`
      ),
  ];

  if (report.simulation) {
    lines.push(
      '',
      `Simulation (cap=${report.simulation.cap}, ttl=${report.simulation.ttl}):`,
      `  rotations=${report.simulation.rotations}  eq=${formatMillions(report.simulation.totalEquivalent)} (${Math.round(report.simulation.totalEquivalent).toLocaleString()})`
    );
  }
  return lines.join('\n');
}

export function parseCliArgs(argv) {
  const files = [];
  let sessionsDir = null;
  let simulate = null;
  let json = false;
  let ttl = '5m';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--sessions-dir' && argv[i + 1]) {
      sessionsDir = argv[++i];
    } else if (arg === '--simulate' && argv[i + 1]) {
      simulate = parseSimulateArg(argv[++i]);
    } else if (arg.startsWith('--simulate=')) {
      simulate = parseSimulateArg(arg.slice('--simulate='.length));
    } else if (arg === '--ttl' && argv[i + 1]) {
      ttl = argv[++i] === '1h' ? '1h' : '5m';
    } else if (!arg.startsWith('-')) {
      files.push(arg);
    }
  }
  return { files, sessionsDir, simulate, json, ttl };
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const files =
    args.files.length > 0
      ? args.files
      : discoverSecretarySessions(args.sessionsDir ?? defaultSessionsDir());

  if (files.length === 0) {
    console.error('No secretary session jsonl files found.');
    process.exitCode = 1;
    return;
  }

  const report = analyzeFiles(files, { ttl: args.ttl, simulate: args.simulate });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
