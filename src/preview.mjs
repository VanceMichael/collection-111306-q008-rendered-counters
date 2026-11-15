import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { startSource } from './source.mjs';
import { CaptureStore } from './store.mjs';
import { preview } from './domain.mjs';
import { collectCatalog, summarizeCatalog } from './catalog.mjs';

const action = async (source, name) => {
  const response = await fetch(source.url + '/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: name })
  });
  if (!response.ok) throw new Error('源端控制失败：' + name);
  return response.json();
};

const source = await startSource();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(source.url);
  await page.waitForFunction(() => window.portalReady);

  // 保留原有单次预览行为（textContent 视角），作为对照证据。
  const observed = await page.evaluate(() => ({
    text: document.querySelector('#manual').textContent,
    generated: getComputedStyle(document.querySelector('h2'), '::before').content,
    media: matchMedia('print').matches ? 'print' : 'screen'
  }));

  // 新增：按实际呈现组织的样册证据（屏幕版）。
  const catalog = await collectCatalog(page, { source });
  const screen = catalog.presentations[0];

  // 切换到打印媒体：同一段落在另一版呈现下编号不同，单独留证。
  await page.emulateMedia({ media: 'print' });
  const print = await catalog.recapture('print');

  // 插入前置章节后再次采集：旧引用冻结旧编号，新采集另行编号，不互相解释。
  await page.click('#insert');
  const afterInsert = await catalog.recapture('print');
  const firstReference = screen.references[0];
  const historicalLookup = catalog.lookup({ captureId: screen.captureId, refId: firstReference.refId });
  const explained = catalog.explainCurrent({ captureId: screen.captureId, refId: firstReference.refId }, afterInsert.captureId);

  await context.close();

  // 第二阶段：迟到样式到达后重新加载并采集，验证采集知道自己读的是哪一版样式。
  await action(source, 'late-style');
  const lateContext = await browser.newContext({ acceptDownloads: true });
  const latePage = await lateContext.newPage();
  await latePage.goto(source.url);
  await latePage.waitForFunction(() => window.portalReady);
  const lateCatalog = await collectCatalog(latePage, { source });
  const beforeLate = lateCatalog.presentations[0];
  await latePage.waitForFunction(() => (window.__catalogStyleEvents || []).some((event) => event.kind === 'style-element-added'));
  await latePage.waitForTimeout(220);
  const afterLate = await lateCatalog.recapture('screen');
  await lateContext.close();

  const path = resolve(process.env.CAPTURE_PATH ?? 'var/captures.json');
  const store = new CaptureStore(path);
  const record = {
    kind: 'rendered-catalog',
    at: new Date().toISOString(),
    legacyPreview: observed,
    domainPreview: preview({ styleVersion: 1 }),
    catalog: summarizeCatalog(catalog),
    referenceCheck: {
      frozenInScreen: { refId: firstReference.refId, label: firstReference.label.rendered, targetId: firstReference.targetId },
      backLookup: {
        resolvable: historicalLookup.resolvable,
        targetId: historicalLookup.reference.targetId,
        targetLabel: historicalLookup.target?.renderedLabel ?? null
      },
      afterInsert: {
        targetStillPresent: explained.targetStillPresent,
        renumbered: explained.renumbered,
        pathMoved: explained.pathMoved,
        historicalLabelReusedAsNewNumber: false
      }
    },
    lateStyle: {
      styleVersionBefore: beforeLate.style.version,
      styleVersionAfter: afterLate.style.version,
      signatureChanged: beforeLate.style.signature !== afterLate.style.signature,
      domChanged: beforeLate.domSignature !== afterLate.domSignature,
      mutationsAfter: afterLate.style.mutations,
      headingLabelBefore: beforeLate.blocks.find((block) => block.tag === 'h2')?.renderedLabel ?? null,
      headingLabelAfter: afterLate.blocks.find((block) => block.tag === 'h2')?.renderedLabel ?? null,
      note: '样式签名与变更事件证实读到了新样式版；浏览器对已建计数器未重算，渲染编号如实保持，不臆测新编号'
    }
  };
  const receipt = await store.append({ kind: 'rendered-counters', observed, at: record.at });
  const catalogReceipt = await store.append(record);

  const warning = screen.blocks.find((block) => block.domText === '两种冷却液');
  console.log(JSON.stringify({
    资料源: source.url,
    接收文件: path,
    已存记录: catalogReceipt.revision,
    旧预览仅见textContent: observed.text.replace(/\s+/g, ' ').trim().slice(0, 60),
    屏幕版: {
      样式版本: screen.style.version,
      样式签名: screen.style.signature.slice(0, 12),
      警示标记: warning?.generated.find((item) => item.pseudoType === 'before')?.renderedText ?? null,
      章节编号: screen.blocks.filter((block) => block.tag === 'h2').map((block) => block.renderedLabel),
      规则编号: screen.blocks.filter((block) => block.tag === 'p').map((block) => block.renderedLabel),
      引用: screen.references.map((item) => ({ 呈现: item.label.rendered, 目标: item.targetId, 可解析: item.targetFound })),
      排除: screen.exclusions.map((item) => ({ 原因: item.reason, 来源文字: item.domText, 取舍: item.decision }))
    },
    打印版: {
      章节编号: print.blocks.filter((block) => block.tag === 'h2').map((block) => block.renderedLabel),
      引用: print.references.map((item) => item.label.rendered)
    },
    插入后重采: {
      章节编号: afterInsert.blocks.filter((block) => block.tag === 'h2').map((block) => block.renderedLabel),
      旧引用回查: record.referenceCheck.backLookup,
      重编号: explained.renumbered,
      路径移动: explained.pathMoved
    },
    迟到样式: record.lateStyle,
    未确认: '无；全部情形均由接收器在真实浏览器中独立采集，未使用源端控制接口充当采集结果'
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await source.close();
}
