import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignCounters,
  buildReference,
  createPresentationContext,
  explainAgainstCurrent,
  lookupReference,
  sha256Text,
  tokenizeContentExpression
} from '../src/evidence.mjs';

const baseContext = {
  captureId: 'c1',
  media: 'screen',
  capturedAt: new Date('2026-11-15T00:00:00Z').toISOString(),
  sourceUrl: 'http://127.0.0.1/x/',
  styleVersion: 1,
  styleSignature: 'sig-1',
  domSignature: 'dom-1',
  fonts: { status: 'loaded' },
  styleMutations: []
};

test('呈现上下文必须声明媒体与样式版本，拒绝未知媒体', () => {
  const context = createPresentationContext(baseContext);
  assert.equal(context.media, 'screen');
  assert.equal(context.style.version, 1);
  assert.throws(() => createPresentationContext({ ...baseContext, media: 'paper' }), /媒体/);
  assert.throws(() => createPresentationContext({ ...baseContext, styleVersion: -1 }), /styleVersion/);
  assert.throws(() => createPresentationContext({ ...baseContext, styleSignature: '' }), /样式签名/);
});

test('content 表达式拆分为计数器与字面量 token', () => {
  assert.deepEqual(tokenizeContentExpression('counter(chapter) ". "'), [
    { type: 'counter', name: 'chapter' },
    { type: 'literal', text: '. ' }
  ]);
  assert.deepEqual(tokenizeContentExpression('counter(chapter) "-" counter(rule) " "'), [
    { type: 'counter', name: 'chapter' },
    { type: 'literal', text: '-' },
    { type: 'counter', name: 'rule' },
    { type: 'literal', text: ' ' }
  ]);
  assert.deepEqual(tokenizeContentExpression('none'), []);
  assert.equal(tokenizeContentExpression('attr(data-x)').some((token) => token.type === 'attr'), true);
});

test('计数器渲染值按表达式顺序对齐，表达式字符串不充当编号', () => {
  assert.deepEqual(alignCounters('counter(chapter) ". "', '3. '), [
    { name: 'chapter', renderedValue: '3' }
  ]);
  assert.deepEqual(alignCounters('counter(chapter) "-" counter(rule) " "', '10-1 '), [
    { name: 'chapter', renderedValue: '10' },
    { name: 'rule', renderedValue: '1' }
  ]);
  // 对齐失败时不编造计数器值
  assert.deepEqual(alignCounters('counter(chapter) ". "', ''), []);
  assert.deepEqual(alignCounters('counter(chapter) "X"', '3. '), []);
  assert.deepEqual(alignCounters('attr(data-x) " "', 'x '), []);
});

test('引用必须带持久目标锚点，回查只按锚点不按编号文字', () => {
  assert.throws(() => buildReference({ refId: 'r', targetId: '', href: '#', blockId: 'b', renderedLabel: 'x', domText: 'x', generated: [], targetFound: false }), /锚点/);
  const reference = buildReference({
    refId: 'ref:a', targetId: 'r1', href: '#r1', blockId: 'r1',
    renderedLabel: '引用检查项（参见第三节）', domText: '引用检查项', generated: [], targetFound: true
  });
  const catalog = {
    presentations: [{
      captureId: 'c1', media: 'screen', style: { version: 1 },
      blocks: [{ id: 'r1', renderedLabel: '3-1 确认回路关闭', path: 'p' }],
      references: [reference]
    }]
  };
  const found = lookupReference(catalog, { captureId: 'c1', refId: 'ref:a' });
  assert.equal(found.resolvable, true);
  assert.equal(found.target.id, 'r1');
  // 即便新呈现里别的段落恰好显示同一编号，也不会被当作旧引用目标
  const other = lookupReference(catalog, { captureId: 'c1', refId: 'missing' });
  assert.equal(other.resolvable, false);
  assert.equal(lookupReference(catalog, { captureId: 'ghost', refId: 'ref:a' }).resolvable, false);
});

test('对照当前采集时如实报告重编号与路径移动，旧编号不被重新解释', () => {
  const reference = buildReference({
    refId: 'ref:a', targetId: 'r1', href: '#r1', blockId: 'a',
    renderedLabel: '引用检查项（参见第三节）', domText: '引用检查项', generated: [], targetFound: true
  });
  const catalog = {
    presentations: [
      {
        captureId: 'c1', media: 'screen', style: { version: 1, signature: 's1' },
        blocks: [{ id: 'r1', renderedLabel: '3-1 确认回路关闭', path: 'section > p' }],
        references: [reference]
      },
      {
        captureId: 'c2', media: 'print', style: { version: 1, signature: 's1' },
        blocks: [{ id: 'r1', renderedLabel: '11-1 确认回路关闭', path: 'section:nth-of-type(2) > p' }],
        references: []
      }
    ]
  };
  const explained = explainAgainstCurrent(catalog, { captureId: 'c1', refId: 'ref:a' }, 'c2');
  assert.equal(explained.targetStillPresent, true);
  assert.equal(explained.renumbered, true);
  assert.equal(explained.pathMoved, true);
  assert.equal(explained.labelAsCaptured.rendered, '引用检查项（参见第三节）');
  assert.equal(explained.historicalLabelReusedAsNewNumber ?? false, false);
});

test('签名随样式内容变化且稳定可复现', () => {
  assert.equal(sha256Text('a').length, 64);
  assert.equal(sha256Text('a'), sha256Text('a'));
  assert.notEqual(sha256Text('a'), sha256Text('b'));
});
