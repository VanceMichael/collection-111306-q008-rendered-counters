import { createHash } from 'node:crypto';

// 接收器侧的证据领域逻辑：全部为纯函数，不接触浏览器，便于单测。
// 设计原则：编号是“某一版呈现”的证据，不是段落的身份；身份只用持久锚点，
// 编号文字只用于展示与比对，永远不参与引用解析。

export const MEDIA = Object.freeze(['screen', 'print']);

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function assertMedia(media) {
  if (!MEDIA.includes(media)) throw new Error(`未知媒体呈现：${String(media)}`);
  return media;
}

// 每次采集的“呈现上下文”：必须说清自己读的是哪一版样式、哪种媒体、哪份 DOM。
export function createPresentationContext(input) {
  const media = assertMedia(input.media);
  const styleVersion = Number(input.styleVersion);
  if (!Number.isInteger(styleVersion) || styleVersion < 0) throw new Error('styleVersion 必须是非负整数');
  if (typeof input.styleSignature !== 'string' || !input.styleSignature) throw new Error('缺少样式签名');
  if (typeof input.domSignature !== 'string' || !input.domSignature) throw new Error('缺少 DOM 签名');
  return {
    captureId: input.captureId,
    media,
    capturedAt: new Date(input.capturedAt).toISOString(),
    sourceUrl: String(input.sourceUrl),
    style: {
      version: styleVersion,
      signature: input.styleSignature,
      fonts: input.fonts ?? null,
      mutations: Array.isArray(input.styleMutations) ? input.styleMutations.map((item) => ({
        kind: String(item.kind),
        target: String(item.target ?? ''),
        at: Number(item.at)
      })) : []
    },
    domSignature: input.domSignature
  };
}

// 把 CSS content 表达式拆成 token：counter/counters 与字符串字面量、attr。
// 仅用于把已渲染文本与计数器名对齐；解析失败时返回 null，调用方保留整段渲染文字，不编造。
const TOKEN_PATTERN = /counter\(\s*([\w-]+)\s*(?:,[^)]*)?\)|counters\(\s*([\w-]+)[^)]*\)|attr\(\s*([\w-]+)\s*\)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;

function unescapeCssLiteral(value) {
  return value.replace(/\\(.)/g, '$1');
}

export function tokenizeContentExpression(expression) {
  if (typeof expression !== 'string' || expression === 'none' || expression === 'normal') return [];
  const tokens = [];
  let match;
  TOKEN_PATTERN.lastIndex = 0;
  while ((match = TOKEN_PATTERN.exec(expression)) !== null) {
    if (match[1] || match[2]) tokens.push({ type: 'counter', name: match[1] || match[2] });
    else if (match[3]) tokens.push({ type: 'attr', name: match[3] });
    else if (match[4] !== undefined) tokens.push({ type: 'literal', text: unescapeCssLiteral(match[4]) });
    else if (match[5] !== undefined) tokens.push({ type: 'literal', text: unescapeCssLiteral(match[5]) });
  }
  return tokens;
}

const collapseSpace = (value) => value.replace(/\s+/g, ' ');

// 依据表达式 token 顺序，在“已渲染文本”中定位每个计数器的实际呈现值。
// 返回 [] 表示无法可靠对齐（渲染文字原样保留在 generated.renderedText 中）。
export function alignCounters(expression, renderedText) {
  const tokens = tokenizeContentExpression(expression);
  if (!tokens.length || typeof renderedText !== 'string' || !renderedText) return [];
  if (!tokens.some((token) => token.type === 'counter')) return [];
  const rendered = renderedText;
  const values = [];
  let cursor = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === 'attr') return [];
    if (token.type === 'literal') {
      const expected = collapseSpace(token.text);
      const at = rendered.indexOf(expected, cursor);
      if (at < 0) return [];
      cursor = at + expected.length;
      continue;
    }
    const nextLiteral = tokens.slice(i + 1).find((item) => item.type === 'literal');
    let end;
    if (nextLiteral) {
      end = rendered.indexOf(collapseSpace(nextLiteral.text), cursor);
      if (end < cursor) return [];
    } else end = rendered.length;
    const value = rendered.slice(cursor, end);
    if (!value || /^\s+$/.test(value)) return [];
    values.push({ name: token.name, renderedValue: value });
    cursor = end;
  }
  return values;
}

// 引用记录：targetId 是唯一解析键；呈现文字只是被冻结的证据。
export function buildReference({ refId, targetId, href, blockId, renderedLabel, domText, generated, targetFound }) {
  if (!targetId) throw new Error('引用缺少持久目标锚点，无法保证回查');
  return {
    refId,
    targetId,
    href,
    blockId,
    targetFound: Boolean(targetFound),
    label: {
      rendered: renderedLabel,
      domText,
      generated: generated.map((item) => ({ ...item }))
    }
  };
}

// 严格回查：只按 targetId 在“引用所属那次采集”的呈现里找目标，绝不按编号文字匹配。
export function lookupReference(catalog, selector) {
  const presentation = catalog.presentations.find((item) => item.captureId === selector.captureId);
  if (!presentation) return { resolvable: false, reason: 'unknown-capture', selector };
  const reference = presentation.references.find((item) => item.refId === selector.refId);
  if (!reference) return { resolvable: false, reason: 'unknown-reference', selector, presentation };
  const target = presentation.blocks.find((block) => block.id === reference.targetId);
  return {
    resolvable: Boolean(target),
    reason: target ? undefined : 'target-missing-in-captured-presentation',
    presentation: { captureId: presentation.captureId, media: presentation.media, style: presentation.style },
    reference,
    target: target ? structuredClone(target) : null
  };
}

// 用“当前这次采集”解释旧引用：目标仍按身份锚点定位，再如实报告编号是否已变化。
export function explainAgainstCurrent(catalog, selector, currentCaptureId) {
  const historical = lookupReference(catalog, selector);
  const current = catalog.presentations.find((item) => item.captureId === currentCaptureId);
  if (!current) throw new Error('当前采集不存在');
  const currentTarget = current.blocks.find((block) => block.id === historical.reference?.targetId) ?? null;
  const historicalTarget = historical.target;
  return {
    resolvable: historical.resolvable,
    targetId: historical.reference?.targetId ?? null,
    capturedIn: historical.presentation,
    labelAsCaptured: historical.reference?.label ?? null,
    historicalTarget: historicalTarget,
    currentTarget: currentTarget ? structuredClone(currentTarget) : null,
    targetStillPresent: Boolean(currentTarget),
    renumbered: Boolean(historicalTarget && currentTarget && historicalTarget.renderedLabel !== currentTarget.renderedLabel),
    pathMoved: Boolean(historicalTarget && currentTarget && historicalTarget.path !== currentTarget.path)
  };
}
