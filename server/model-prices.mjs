/**
 * Public list-price helpers for admin model weight estimates.
 * Never uses or returns API keys.
 */

export const FLASH_YUAN_PER_MILLION = 3;

const FETCH_MS = 12000;

function fmtYuan(n) {
  const v = Math.round((Number(n) || 0) * 1000) / 1000;
  return String(v);
}

export function estimateYuanFromWeight(weight) {
  const w = Math.max(0, Number(weight) || 0);
  return Math.round(w * FLASH_YUAN_PER_MILLION * 1000) / 1000;
}

function blend11(input, output) {
  return Math.round(((Number(input) + Number(output)) / 2) * 1000) / 1000;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'FlowMateAdminPriceBot/1.0',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '|')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** DeepSeek official idle cache-miss input + idle output. */
async function fetchDeepseekPrices() {
  const url = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
  const html = await fetchText(url);
  const flash = html.includes('deepseek-v4-flash');
  const pro = html.includes('deepseek-v4-pro');
  if (!flash && !pro) return [];
  // Table columns: flash | pro for each price row.
  const missIdle = html.match(/百万tokens输入（缓存未命中）[\s\S]*?空闲时段<\/td><td>([\d.]+)元<\/td><td>([\d.]+)元<\/td>/);
  const outIdle = html.match(/百万tokens输出[\s\S]*?空闲时段<\/td><td>([\d.]+)元<\/td><td>([\d.]+)元<\/td>/);
  if (!missIdle || !outIdle) return [];
  const out = [];
  if (flash) {
    out.push({
      id: 'deepseek-v4-flash',
      provider: 'deepseek',
      input: Number(missIdle[1]),
      output: Number(outIdle[1]),
      url
    });
  }
  if (pro) {
    out.push({
      id: 'deepseek-v4-pro',
      provider: 'deepseek',
      input: Number(missIdle[2]),
      output: Number(outIdle[2]),
      url
    });
  }
  return out.filter((p) => Number.isFinite(p.input) && Number.isFinite(p.output));
}

/** Moonshot / Kimi markdown-rendered DocTable rows in page HTML. */
async function fetchMoonshotPrice(modelId) {
  const pages = {
    'kimi-k3': 'https://platform.kimi.com/docs/pricing/chat-k3',
    'kimi-k2.7-code': 'https://platform.kimi.com/docs/pricing/chat-k27-code',
    'kimi-k2.6': 'https://platform.kimi.com/docs/pricing/chat-k26'
  };
  const url = pages[modelId];
  if (!url) return null;
  const html = await fetchText(url);
  // Embedded DocTable: rows:[[`kimi-k3`,`1M tokens`,`¥2.00`,`¥20.00`,`¥100.00`,...]]
  // columns: model, unit, cacheHitInput, cacheMissInput, output
  const idEsc = modelId.replace(/\./g, '\\.');
  const re = new RegExp(
    `${idEsc}[^\\d¥]{0,40}1M tokens[^\\d¥]{0,20}¥([\\d.]+)[^\\d¥]{0,20}¥([\\d.]+)[^\\d¥]{0,20}¥([\\d.]+)`,
    'i'
  );
  const m = html.match(re);
  if (!m) return null;
  return {
    id: modelId,
    provider: 'moonshot',
    input: Number(m[2]),
    output: Number(m[3]),
    url
  };
}

/**
 * Aliyun Model Studio pricing page — take first mainland list price pair after model id.
 * Prefer 原价X元 when present (ignore limited-time discounts for list estimate).
 */
async function fetchBailianPrice(modelId) {
  const url = 'https://help.aliyun.com/zh/model-studio/model-pricing';
  const html = await fetchText(url);
  const idx = html.indexOf(modelId);
  if (idx < 0) return null;
  const window = stripTags(html.slice(idx, idx + 2500));
  const listPrices = [...window.matchAll(/原价\s*([\d.]+)\s*元/g)].map((m) => Number(m[1]));
  if (listPrices.length >= 2) {
    return { id: modelId, provider: 'bailian', input: listPrices[0], output: listPrices[1], url };
  }
  // deepseek on bailian: 闲时 1.5元 … 闲时 4.5元
  const idle = [...window.matchAll(/闲时\s*([\d.]+)\s*元/g)].map((m) => Number(m[1]));
  if (idle.length >= 2) {
    return { id: modelId, provider: 'bailian', input: idle[0], output: idle[1], url };
  }
  // Aliyun HTML → stripTags yields "12||元||||36||元"
  const plain = [...window.matchAll(/([\d.]+)\|+\s*元/g)].map((m) => Number(m[1]));
  // qwen-plus style may yield input + two output tiers; use first two list prices
  if (plain.length >= 2) {
    return { id: modelId, provider: 'bailian', input: plain[0], output: plain[1], url };
  }
  return null;
}

function matchKey(provider, textModel, id) {
  return String(textModel || id || '').trim().toLowerCase();
}

async function fetchLivePrice(provider, textModel, id) {
  const key = matchKey(provider, textModel, id);
  const p = String(provider || '').trim();

  if (p === 'deepseek' || key.startsWith('deepseek-')) {
    const all = await fetchDeepseekPrices();
    const hit = all.find((x) => x.id === key) || all.find((x) => key.includes(x.id));
    if (hit) return hit;
    // Bailian also hosts DeepSeek models
    const bailian = await fetchBailianPrice(key);
    if (bailian) return bailian;
  }

  if (p === 'moonshot' || key.startsWith('kimi-')) {
    const hit = await fetchMoonshotPrice(key);
    if (hit) return hit;
  }

  if (p === 'bailian' || p === 'custom' || !p) {
    const hit = await fetchBailianPrice(key);
    if (hit) return hit;
    if (key.startsWith('deepseek-')) {
      const all = await fetchDeepseekPrices();
      return all.find((x) => x.id === key) || null;
    }
    if (key.startsWith('kimi-')) {
      return fetchMoonshotPrice(key);
    }
  }

  return null;
}

export async function estimateModelPrice({ provider = '', textModel = '', id = '', weight = 0 } = {}) {
  const weightEstimate = estimateYuanFromWeight(weight);
  const weightLine = `预估：百万 token ≈ ¥${fmtYuan(weightEstimate)}（按 DeepSeek Flash 闲时单价折算）`;

  try {
    const live = await fetchLivePrice(provider, textModel, id);
    if (live && Number.isFinite(live.input) && Number.isFinite(live.output)) {
      const yuanPerMillion = blend11(live.input, live.output);
      return {
        ok: true,
        source: 'live',
        fallback: false,
        provider: live.provider || provider,
        model: live.id || textModel || id,
        inputYuanPerMillion: live.input,
        outputYuanPerMillion: live.output,
        yuanPerMillion,
        weightEstimate,
        sourceUrl: live.url || '',
        message: `预估：百万 token ≈ ¥${fmtYuan(yuanPerMillion)}（官方价 输入 ¥${fmtYuan(live.input)} / 输出 ¥${fmtYuan(live.output)}，1:1 折算）`
      };
    }
  } catch {
    // fall through
  }

  return {
    ok: true,
    source: 'weight',
    fallback: true,
    provider,
    model: textModel || id,
    yuanPerMillion: weightEstimate,
    weightEstimate,
    sourceUrl: '',
    message: `未能拉取官方价，已用权重估算。${weightLine}`
  };
}

export function weightEstimateMessage(weight) {
  const yuan = estimateYuanFromWeight(weight);
  return `预估：百万 token ≈ ¥${fmtYuan(yuan)}（按 DeepSeek Flash 闲时单价折算）`;
}
