import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startSource } from '../src/source.mjs';
import { collectCatalog, summarizeCatalog } from '../src/catalog.mjs';

const launch = async () => {
  const source = await startSource();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(source.url);
  await page.waitForFunction(() => window.portalReady);
  return { source, browser, context, page };
};

const findBlock = (presentation, predicate) => presentation.blocks.find(predicate);

test('屏幕版采集按实际呈现组织正文、生成文字与计数标签，而非拼接 textContent', async () => {
  const { source, browser, page } = await launch();
  try {
    const catalog = await collectCatalog(page, { source });
    const screen = catalog.presentations[0];
    assert.equal(screen.media, 'screen');
    assert.equal(screen.style.version, 1);
    assert.ok(screen.style.signature.startsWith('sha256-') || screen.style.signature.length === 64);

    const heading = findBlock(screen, (block) => block.tag === 'h2');
    const before = heading.generated.find((item) => item.pseudoType === 'before');
    // 表达式保留为证据，但编号取的是 AX 树解析后的真值
    assert.equal(before.cssExpression, 'counter(chapter) ". "');
    assert.equal(before.renderedText, '3. ');
    assert.deepEqual(before.counters, [{ name: 'chapter', renderedValue: '3' }]);
    assert.equal(heading.renderedLabel, '3. 接收检查');
    assert.equal(heading.domText, '接收检查');

    const rules = screen.blocks.filter((block) => block.tag === 'p');
    assert.deepEqual(rules.map((block) => block.domText), ['确认回路关闭', '两种冷却液']);
    assert.equal(rules[0].renderedLabel, '3-1 确认回路关闭');
    assert.equal(rules[1].renderedLabel, '⚠ 不得混用：两种冷却液');

    // 旧爬虫漏掉的警示标记必须作为生成文字被采集到
    const warning = findBlock(screen, (block) => block.domText === '两种冷却液');
    const warningBefore = warning.generated.find((item) => item.pseudoType === 'before');
    assert.equal(warningBefore.renderedText, '⚠ 不得混用：');
    assert.equal(warning.renderedLabel, '⚠ 不得混用：两种冷却液');

    // textContent 对照：警示标记确实不在 DOM 文本里
    const rawText = await page.evaluate(() => document.querySelector('#manual').textContent);
    assert.ok(!rawText.includes('不得混用'));

    const summary = summarizeCatalog(catalog);
    assert.equal(summary.presentations[0].blocks.find((block) => block.domText === '两种冷却液').renderedLabel, '⚠ 不得混用：两种冷却液');
  } finally {
    await browser.close();
    await source.close();
  }
});

test('屏幕版与打印版分别留证：同一目标编号不同且不跨版挂载', async () => {
  const { source, browser, page } = await launch();
  try {
    const catalog = await collectCatalog(page, { source });
    const screen = catalog.presentations[0];
    await page.emulateMedia({ media: 'print' });
    const print = await catalog.recapture('print');

    assert.equal(screen.captureId !== print.captureId, true);
    assert.equal(print.media, 'print');
    const screenHeading = findBlock(screen, (block) => block.tag === 'h2');
    const printHeading = findBlock(print, (block) => block.tag === 'h2');
    assert.equal(screenHeading.id, printHeading.id);
    assert.equal(screenHeading.renderedLabel, '3. 接收检查');
    assert.equal(printHeading.renderedLabel, '10. 接收检查');

    const screenRule = findBlock(screen, (block) => block.id === 'r1');
    const printRule = findBlock(print, (block) => block.id === 'r1');
    assert.equal(screenRule.renderedLabel, '3-1 确认回路关闭');
    assert.equal(printRule.renderedLabel, '10-1 确认回路关闭');

    const screenRef = screen.references[0];
    const printRef = print.references[0];
    assert.equal(screenRef.label.rendered, '引用检查项（参见第三节）');
    assert.equal(printRef.label.rendered, '引用检查项（纸版附录）');
    assert.equal(screenRef.targetId, printRef.targetId);
    // 两版证据独立保存，编号不跨版引用
    assert.notEqual(screenRef.label.rendered, printRef.label.rendered);
    assert.equal(print.style.signature, screen.style.signature);
  } finally {
    await browser.close();
    await source.close();
  }
});

test('插入内容重编号后，旧引用仍按身份锚点查回原目标且不被解释成新编号', async () => {
  const { source, browser, page } = await launch();
  try {
    const catalog = await collectCatalog(page, { source });
    const screen = catalog.presentations[0];
    const reference = screen.references[0];
    const frozenLabel = reference.label.rendered;

    await page.emulateMedia({ media: 'print' });
    await page.click('#insert');
    const afterInsert = await catalog.recapture('print');

    const headings = afterInsert.blocks.filter((block) => block.tag === 'h2').map((block) => block.renderedLabel);
    assert.deepEqual(headings, ['10. 前置检查', '11. 接收检查']);

    const historical = catalog.lookup({ captureId: screen.captureId, refId: reference.refId });
    assert.equal(historical.resolvable, true);
    assert.equal(historical.target.id, 'r1');
    assert.equal(historical.reference.label.rendered, frozenLabel);
    assert.equal(historical.presentation.media, 'screen');

    const explained = catalog.explainCurrent({ captureId: screen.captureId, refId: reference.refId }, afterInsert.captureId);
    assert.equal(explained.targetStillPresent, true);
    assert.equal(explained.targetId, 'r1');
    assert.equal(explained.renumbered, true);
    assert.equal(explained.pathMoved, true);
    assert.equal(explained.currentTarget.renderedLabel, '11-1 确认回路关闭');
    assert.equal(explained.historicalTarget.renderedLabel, '3-1 确认回路关闭');

    const currentTargetBlock = findBlock(afterInsert, (block) => block.id === 'r1');
    assert.equal(currentTargetBlock.renderedLabel, '11-1 确认回路关闭');
    // 旧标签文字没有出现在新目标的渲染编号中，证明没有被悄悄复用
    assert.ok(!currentTargetBlock.renderedLabel.includes('参见第三节'));
  } finally {
    await browser.close();
    await source.close();
  }
});

test('迟到样式到达后重新编号，两次采集各自记录样式版本、签名与变更事件', async () => {
  const { source, browser, context, page } = await launch();
  try {
    const action = async (name) => {
      const response = await fetch(source.url + '/api/action', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name })
      });
      assert.equal(response.status, 200);
    };
    await action('late-style');
    await page.reload();
    await page.waitForFunction(() => window.portalReady);
    const catalog = await collectCatalog(page, { source });
    const before = catalog.presentations[0];
    assert.equal(before.style.version, 2);
    const headingBefore = findBlock(before, (block) => block.tag === 'h2').renderedLabel;
    assert.equal(headingBefore, '3. 接收检查');
    assert.equal(before.style.mutations.length, 0);

    await page.waitForFunction(() => (window.__catalogStyleEvents || []).some((event) => event.kind === 'style-element-added'));
    await page.waitForTimeout(220);
    const after = await catalog.recapture('screen');
    assert.equal(after.style.version, 2);
    // 样式表内容变化必须体现为签名变化与变更事件：采集明确知道自己读到了另一版样式
    assert.notEqual(after.style.signature, before.style.signature);
    assert.ok(after.style.mutations.some((event) => event.kind === 'style-element-added'));
    // DOM 未变；浏览器对已建计数器不重算，两次渲染编号如实记录为相同，
    // 但两版样式身份不同——后续解释必须以签名为准，不能假定同编号即同一样式版
    assert.equal(before.domSignature, after.domSignature);
    assert.equal(findBlock(after, (block) => block.tag === 'h2').renderedLabel, headingBefore);
    assert.equal(after.style.version, before.style.version);
  } finally {
    await context.close();
    await browser.close();
    await source.close();
  }
});

test('装饰图形不转写为正文，隐藏段落与辅助读屏内容记录取舍说明', async () => {
  const { source, browser, page } = await launch();
  try {
    const catalog = await collectCatalog(page, { source });
    const screen = catalog.presentations[0];
    const reasons = screen.exclusions.map((item) => item.reason);
    assert.ok(reasons.includes('aria-hidden-decoration'));
    assert.ok(reasons.includes('hidden-attribute'));

    const decoration = screen.exclusions.find((item) => item.reason === 'aria-hidden-decoration');
    assert.equal(decoration.domText, '◆');
    assert.ok(!screen.blocks.some((block) => block.renderedLabel.includes('◆')));
    assert.match(decoration.decision, /不把图形/);

    const hidden = screen.exclusions.find((item) => item.reason === 'hidden-attribute');
    assert.equal(hidden.domText, '未发布步骤');
    assert.ok(!screen.blocks.some((block) => block.domText === '未发布步骤'));

    // 注入一个仅供读屏的辅助段落，验证其被单独标注而非并入视觉正文
    await page.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.className = 'sr-only';
      paragraph.textContent = '读屏专用说明';
      document.querySelector('#manual').append(paragraph);
    });
    const second = await catalog.recapture('screen');
    const srOnly = second.exclusions.find((item) => item.reason === 'screen-reader-only');
    assert.ok(srOnly);
    assert.equal(srOnly.domText, '读屏专用说明');
    assert.ok(!second.blocks.some((block) => block.renderedLabel.includes('读屏专用说明')));
  } finally {
    await browser.close();
    await source.close();
  }
});

test('脚注式目标被接收器移动位置后，各版呈现保留各自路径，引用仍指向同一身份', async () => {
  const { source, browser, page } = await launch();
  try {
    const catalog = await collectCatalog(page, { source });
    const screen = catalog.presentations[0];
    const targetBefore = findBlock(screen, (block) => block.id === 'r1');
    const pathBefore = targetBefore.path;

    // 接收器侧的 DOM 操作：把目标段落移入新包裹层模拟脚注换位，不改动源端模拟器
    await page.evaluate(() => {
      const target = document.querySelector('#r1');
      const wrapper = document.createElement('div');
      wrapper.className = 'footnote-slot';
      target.before(wrapper);
      wrapper.append(target);
    });
    const moved = await catalog.recapture('screen');
    const targetAfter = findBlock(moved, (block) => block.id === 'r1');
    assert.notEqual(targetAfter.path, pathBefore);
    assert.match(targetAfter.path, /div/);
    assert.equal(targetAfter.id, 'r1');
    const reference = moved.references[0];
    assert.equal(reference.targetId, 'r1');
    const back = catalog.lookup({ captureId: moved.captureId, refId: reference.refId });
    assert.equal(back.resolvable, true);
    assert.equal(back.target.path, targetAfter.path);
  } finally {
    await browser.close();
    await source.close();
  }
});
