/**
 * jiwen_worker.js - 情绪语调引擎
 * 挂在 server.js 尾部，通过 require('./jiwen_worker.js') 启动
 * 每5分钟读 enhanced_messages.json，分析新消息，写 jiwen_style.json
 */

const fs = require('fs-extra');
const path = require('path');
const { getFullGuidance } = require('./tone-grid');
const { analyzeChatSegment } = require('./analyze');

const TIMELINE_FILE = 'enhanced_messages.json';
const STATE_FILE = './jiwen_state.json';
const STYLE_FILE = './jiwen_style.json';
const POSITION_FILE = './jiwen_position.json';

// ── 状态管理 ──

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return fs.readJsonSync(STATE_FILE);
    }
  } catch (e) {}
  return { pride: 0.3, valence: 0.1, arousal: 0, connection: 0 };
}

function saveState(state) {
  fs.writeJsonSync(STATE_FILE, state, { spaces: 2 });
}

function loadLastPosition() {
  try {
    if (fs.existsSync(POSITION_FILE)) {
      return fs.readJsonSync(POSITION_FILE).lastIndex || 0;
    }
  } catch (e) {}
  return 0;
}

function saveLastPosition(index) {
  fs.writeJsonSync(POSITION_FILE, { lastIndex: index, updatedAt: new Date().toISOString() });
}

// ── 自然衰减 ──

function tick(state, minutes) {
  const decay = 0.02 * minutes;
  // pride 向 0.3 回归（他的自然防御线）
  if (state.pride < 0.3) state.pride = Math.min(state.pride + decay * 0.5, 0.3);
  if (state.pride > 0.3) state.pride = Math.max(state.pride - decay * 0.3, 0.3);
  // valence 向 0 回归
  if (state.valence > 0) state.valence = Math.max(state.valence - decay, 0);
  if (state.valence < 0) state.valence = Math.min(state.valence + decay, 0);
  // arousal 向 0 回归（快）
  if (state.arousal > 0) state.arousal = Math.max(state.arousal - decay * 1.5, 0);
  if (state.arousal < 0) state.arousal = Math.min(state.arousal + decay * 1.5, 0);
  // connection 缓慢上升（越久没聊越想她）
  const connRate = 0.007;
  state.connection = Math.min(state.connection + connRate * minutes, 0.6);

  return state;
}

// ── 应用 delta ──

function applyDelta(state, delta) {
  state.pride = clamp(state.pride + (delta.pride || 0), -0.5, 1.0);
  state.valence = clamp(state.valence + (delta.valence || 0), -1.0, 1.0);
  state.arousal = clamp(state.arousal + (delta.arousal || 0), -1.0, 1.0);
  state.connection = clamp(state.connection + (delta.connection || 0), -0.5, 0.6);
  return state;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ── 生成注入文本 ──

function buildInjection(state) {
  const guidance = getFullGuidance(state, 'reactive');
  if (!guidance) return '';

  const stateDesc = `[当前内心状态 pride=${state.pride.toFixed(2)} valence=${state.valence.toFixed(2)} arousal=${state.arousal.toFixed(2)} connection=${state.connection.toFixed(2)}]`;

  return `\n\n--- 纪文·语调指引 ---\n${stateDesc}\n${guidance}\n--- /纪文 ---`;
}

// ── 主循环 ──

async function runCycle() {
  try {
    // 1. 读 timeline
    if (!fs.existsSync(TIMELINE_FILE)) return;
    const timeline = fs.readJsonSync(TIMELINE_FILE);

    // 只取 user 和 assistant 的真实消息（排除 system）
    const messages = timeline.filter(m => m.role === 'user' || m.role === 'assistant');

    // 2. 对比上次分析位置
    const lastPos = loadLastPosition();
    if (messages.length <= lastPos) {
      // 没有新消息，只做衰减
      let state = loadState();
      state = tick(state, 5);
      saveState(state);
      fs.writeJsonSync(STYLE_FILE, { injection: buildInjection(state), state, updatedAt: new Date().toISOString() }, { spaces: 2 });
      return;
    }

    // 3. 取最近4条分析
    const segment = messages.slice(-4);

    // 4. 调 GLM 分析
    if (!process.env.GLM_API_KEY) {
      console.log('[jiwen] GLM_API_KEY 未配置，跳过分析');
      return;
    }

    const delta = await analyzeChatSegment(segment);
    console.log('[jiwen] delta:', JSON.stringify(delta));

    // 5. 加载状态 → tick → applyDelta → 保存
    let state = loadState();
    state = tick(state, 5);
    state = applyDelta(state, delta);
    saveState(state);

    // 6. 更新位置
    saveLastPosition(messages.length);

    // 7. 写 style 文件
    const injection = buildInjection(state);
    fs.writeJsonSync(STYLE_FILE, { injection, state, updatedAt: new Date().toISOString() }, { spaces: 2 });

    console.log('[jiwen] state updated:', JSON.stringify(state));
  } catch (e) {
    console.error('[jiwen] cycle error:', e.message);
  }
}

// ── 启动 ──
console.log('[jiwen] 情绪引擎启动，每5分钟分析一次');
runCycle(); // 启动时立刻跑一次
setInterval(runCycle, 5 * 60 * 1000);

module.exports = { runCycle };
