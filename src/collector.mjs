import { randomUUID } from 'node:crypto';
import { alignCounters, assertMedia, createPresentationContext, sha256Text } from './evidence.mjs';

// 浏览器采集器：在真实页面里按“实际呈现”组织文字。
// 关键分工：
// - DOM 层只负责身份（id/路径）、结构与取舍说明；
// - 伪元素/计数器的渲染文字只取自 CDP 无障碍树（计数器已解析为真实编号），
//   getComputedStyle(...).content 仅作为表达式证据保留，绝不充当编号。

const INSPECTOR_BOOTSTRAP = `(() => {
  if (window.__catalogInspection) return;
  const events = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type !== 'childList') continue;
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'STYLE') events.push({ kind: 'style-element-added', target: 'style[' + events.length + ']', at: Date.now() });
        if (node.tagName === 'LINK') events.push({ kind: 'style-link-added', target: node.getAttribute('href') || '', at: Date.now() });
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.__catalogStyleEvents = events;
  window.__catalogInspection = (rootSelector) => {
    const root = document.querySelector(rootSelector);
    if (!root) throw new Error('采集根节点不存在：' + rootSelector);
    const pathOf = (element) => {
      const segments = [];
      let current = element;
      while (current && current !== root) {
        const parent = current.parentElement;
        if (!parent) break;
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        const index = sameTag.indexOf(current);
        segments.unshift(current.tagName.toLowerCase() + (sameTag.length > 1 ? ':nth-of-type(' + (index + 1) + ')' : ''));
        current = parent;
      }
      return segments.join(' > ');
    };
    const isRendered = (element) => {
      const state = getComputedStyle(element);
      if (state.display === 'none' || state.visibility === 'hidden') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0 || element.getClientRects().length > 0;
    };
    const visuallyHiddenCues = (element, state) => {
      const cues = [];
      if (state.clip === 'rect(0px, 0px, 0px, 0px)' || state.clipPath === 'inset(50%)') cues.push('clip');
      if (state.position === 'absolute' && Number.parseFloat(state.width) <= 1 && Number.parseFloat(state.height) <= 1) cues.push('one-pixel-clip');
      if (state.overflow === 'hidden' && Number.parseFloat(state.width) <= 1) cues.push('overflow-clip');
      if (element.matches('.sr-only,.visually-hidden,.visuallyhidden')) cues.push('sr-only-class');
      return cues;
    };
    const blocks = [];
    const exclusions = [];
    const references = [];
    let serial = 0;
    const visit = (element) => {
      if (element.nodeType !== 1) return;
      const state = getComputedStyle(element);
      const ariaHidden = element.getAttribute('aria-hidden') === 'true';
      const hiddenAttr = element.hasAttribute('hidden');
      const rendered = isRendered(element);
      const srCues = visuallyHiddenCues(element, state);
      const base = {
        serial: (serial += 1),
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        path: pathOf(element),
        attributes: {
          className: element.getAttribute('class') || null,
          role: element.getAttribute('role') || null,
          href: element.getAttribute('href') || null
        }
      };
      if (hiddenAttr || !rendered) {
        exclusions.push({ ...base, reason: hiddenAttr ? 'hidden-attribute' : 'not-rendered', domText: element.textContent, decision: '不采集为正文；保留来源文字与取舍说明' });
        return;
      }
      if (ariaHidden) {
        exclusions.push({ ...base, reason: 'aria-hidden-decoration', domText: element.textContent, decision: '装饰/对辅助技术隐藏：不把图形或符号凭空转成正文文字' });
        return;
      }
      if (srCues.length) {
        exclusions.push({ ...base, reason: 'screen-reader-only', cues: srCues, domText: element.textContent, decision: '视觉隐藏但供读屏：作为辅助读屏内容单独标注，不并入视觉正文' });
        return;
      }
      const ownText = Array.from(element.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent).join('').replace(/\\s+/g, ' ').trim();
      const pseudo = (pseudoType) => {
        const pseudoState = getComputedStyle(element, '::' + pseudoType);
        const expression = pseudoState.content;
        if (!expression || expression === 'none' || expression === 'normal') return null;
        return { pseudoType, expression, display: pseudoState.display };
      };
      const generated = [pseudo('before'), pseudo('after')].filter(Boolean);
      // 纯容器元素自身无 DOM 文本也无生成内容时不成为正文块，其子树仍会继续遍历。
      if (!ownText && !generated.length) {
        Array.from(element.children).forEach(visit);
        return;
      }
      blocks.push({ ...base, domText: ownText, generated });
      if (element.tagName === 'A' && element.hash) {
        references.push({
          refId: element.id ? 'ref:' + element.id : 'ref:' + base.path,
          blockId: element.id || base.path,
          href: element.getAttribute('href'),
          targetId: decodeURIComponent(element.hash.slice(1)),
          domText: ownText
        });
      }
      Array.from(element.children).forEach(visit);
    };
    Array.from(root.children).forEach(visit);
    const styleExpressions = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = Array.from(sheet.cssRules).map((rule) => rule.cssText); }
      catch (error) { rules = ['<不可读样式表:' + error.message + '>']; }
      styleExpressions.push({ href: sheet.href || 'inline', rules });
    }
    let fingerprint = 0;
    const markup = root.outerHTML;
    for (let i = 0; i < markup.length; i += 1) fingerprint = (fingerprint * 31 + markup.charCodeAt(i)) | 0;
    return {
      blocks,
      exclusions,
      references,
      domSignature: 'dom:' + (fingerprint >>> 0).toString(16) + ':' + markup.length,
      styleExpressions,
      fonts: { status: document.fonts ? document.fonts.status : 'unsupported', faceCount: document.fonts ? document.fonts.size : null }
    };
  };
})();`;

function flattenAx(nodes, output = []) {
  for (const node of nodes) {
    output.push(node);
    if (node.children) flattenAx(node.children, output);
  }
  return output;
}

// 无障碍树里伪节点自身没有名称，渲染文字在其子树的 StaticText/InlineTextBox 上；
// 这里沿 childIds 把伪元素子树内的全部文本聚合到该伪节点的 backendId。
function collectPseudoText(flatAx, pseudoBackendIds) {
  const byNodeId = new Map(flatAx.map((node) => [node.nodeId, node]));
  const textByPseudo = new Map();
  const textsUnder = (nodeId, trail) => {
    const node = byNodeId.get(String(nodeId));
    if (!node) return trail;
    if (node.role?.value !== 'InlineTextBox' && typeof node.name?.value === 'string' && node.name.value) {
      trail.push(node.name.value);
    }
    for (const childId of node.childIds || []) textsUnder(childId, trail);
    return trail;
  };
  for (const pseudoId of pseudoBackendIds) {
    const pseudoNode = flatAx.find((node) => node.backendDOMNodeId === pseudoId);
    if (!pseudoNode) continue;
    const parts = [];
    for (const childId of pseudoNode.childIds || []) textsUnder(childId, parts);
    textByPseudo.set(pseudoId, parts.join(''));
  }
  return textByPseudo;
}

export async function createCollector(page, { rootSelector = '#manual' } = {}) {
  // initScript 保证后续导航（含 reload）自动安装；evaluate 兜底处理注册前已加载的文档。
  await page.addInitScript({ content: INSPECTOR_BOOTSTRAP });
  await page.evaluate(INSPECTOR_BOOTSTRAP);
  const client = await page.context().newCDPSession(page);
  await client.send('Accessibility.enable');
  await client.send('DOM.enable');

  async function collect({ media, styleVersion, sourceUrl }) {
    assertMedia(media);
    const captureId = randomUUID();
    // 排版字体可能晚到：尽量等字体就绪，超时也不致命，字体状态会如实写入证据。
    await Promise.race([
      page.evaluate(async () => { if (document.fonts) await document.fonts.ready; }),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]);
    const inspection = await page.evaluate((selector) => window.__catalogInspection(selector), rootSelector);
    const styleMutations = await page.evaluate(() => window.__catalogStyleEvents || []);

    // 一次取全量 AX 树：伪元素节点的计数器已是渲染真值，文本在其子树里。
    const { nodes: axNodes } = await client.send('Accessibility.getFullAXTree');
    const flatAx = flattenAx(axNodes);
    const ignoredBackends = new Set();
    for (const node of flatAx) {
      if (node.ignored && typeof node.backendDOMNodeId === 'number') ignoredBackends.add(node.backendDOMNodeId);
    }

    // 描述 DOM 子树：普通 describeNode 的 pseudoElements 给出伪元素 backendId，
    // 该 ID 与无障碍树里伪节点的 backendDOMNodeId 一致。
    const doc = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const rootFound = await client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: rootSelector });
    const allFound = await client.send('DOM.querySelectorAll', { nodeId: rootFound.nodeId, selector: '*' });
    const pseudoOwner = new Map();
    const backendByKey = new Map();
    for (const nodeId of allFound.nodeIds) {
      const detail = await client.send('DOM.describeNode', { nodeId, pierce: true });
      const node = detail.node;
      const elementId = extractId(node.attributes || []);
      if (elementId) backendByKey.set('#' + elementId, node.backendNodeId);
      for (const pseudo of node.pseudoElements || []) {
        pseudoOwner.set(pseudo.backendNodeId, { ownerBackendId: node.backendNodeId, pseudoType: pseudo.pseudoType });
      }
    }
    // 无 id 元素按检查器给出的结构路径补建映射（加根前缀，避免与带 id 的 '#x' 键冲突）。
    for (const block of inspection.blocks) {
      if (block.id) continue;
      const selector = rootSelector + ' ' + block.path;
      const found = await client.send('DOM.querySelector', { nodeId: rootFound.nodeId, selector });
      if (found.nodeId) {
        const detail = await client.send('DOM.describeNode', { nodeId: found.nodeId });
        backendByKey.set('path:' + block.path, detail.node.backendNodeId);
        for (const pseudo of detail.node.pseudoElements || []) {
          pseudoOwner.set(pseudo.backendNodeId, { ownerBackendId: detail.node.backendNodeId, pseudoType: pseudo.pseudoType });
        }
      }
    }
    const textByPseudo = collectPseudoText(flatAx, new Set(pseudoOwner.keys()));

    const pseudoRenderedByOwner = new Map();
    for (const [backendId, info] of pseudoOwner) {
      const renderedText = textByPseudo.get(backendId);
      if (!renderedText) continue;
      const list = pseudoRenderedByOwner.get(info.ownerBackendId) || [];
      list.push({ pseudoType: info.pseudoType, renderedText, axBackendId: backendId });
      pseudoRenderedByOwner.set(info.ownerBackendId, list);
    }

    const blocks = [];
    for (const block of inspection.blocks) {
      const key = block.id ? '#' + block.id : 'path:' + block.path;
      const backendId = backendByKey.get(key);
      const generated = [];
      for (const pseudo of block.generated) {
        const renderedList = (backendId !== undefined && pseudoRenderedByOwner.get(backendId)) || [];
        const rendered = renderedList.find((item) => item.pseudoType === pseudo.pseudoType);
        const renderedText = rendered ? rendered.renderedText : null;
        generated.push({
          pseudoType: pseudo.pseudoType,
          cssExpression: pseudo.expression,
          renderedText,
          source: renderedText ? 'cdp-accessibility-tree' : 'rendered-text-unavailable',
          counters: renderedText ? alignCounters(pseudo.expression, renderedText) : []
        });
      }
      const prefix = generated.filter((item) => item.pseudoType === 'before').map((item) => item.renderedText ?? '').join('');
      const suffix = generated.filter((item) => item.pseudoType === 'after').map((item) => item.renderedText ?? '').join('');
      blocks.push({
        id: block.id,
        tag: block.tag,
        path: block.path,
        domText: block.domText,
        generated,
        renderedLabel: (prefix + block.domText + suffix).replace(/\s+/g, ' ').trim(),
        axIgnored: backendId === undefined ? null : ignoredBackends.has(backendId)
      });
    }

    const references = inspection.references.map((reference) => {
      const targetFound = blocks.some((block) => block.id === reference.targetId);
      const hostBlock = blocks.find((block) => (block.id || block.path) === reference.blockId);
      const generatedLabels = (hostBlock?.generated || []).map((item) => ({
        pseudoType: item.pseudoType,
        renderedText: item.renderedText,
        cssExpression: item.cssExpression
      }));
      const suffix = generatedLabels.filter((item) => item.pseudoType === 'after').map((item) => item.renderedText ?? '').join('');
      return {
        refId: reference.refId,
        blockId: reference.blockId,
        href: reference.href,
        targetId: reference.targetId,
        targetFound,
        label: {
          rendered: (reference.domText + suffix).replace(/\s+/g, ' ').trim(),
          domText: reference.domText,
          generated: generatedLabels
        }
      };
    });

    const styleSignature = sha256Text(JSON.stringify(inspection.styleExpressions));
    const presentation = createPresentationContext({
      captureId,
      media,
      capturedAt: new Date().toISOString(),
      sourceUrl,
      styleVersion,
      styleSignature,
      domSignature: inspection.domSignature,
      fonts: inspection.fonts,
      styleMutations
    });

    return {
      ...presentation,
      blocks,
      references,
      exclusions: inspection.exclusions,
      styleSheets: inspection.styleExpressions
    };
  }

  return { collect };
}

function extractId(attributes) {
  for (let i = 0; i < attributes.length; i += 2) {
    if (attributes[i] === 'id') return attributes[i + 1];
  }
  return null;
}
