import { createCollector } from './collector.mjs';
import { explainAgainstCurrent, lookupReference } from './evidence.mjs';

// 样册证据编排：在同一个浏览器页面上分别采集屏幕版/打印版，
// 每次采集都带自己的样式版本、媒体、签名，互不覆盖编号解释。
export async function collectCatalog(page, { source, rootSelector = '#manual' } = {}) {
  const collector = await createCollector(page, { rootSelector });
  const snapshot = await (await fetch(new URL('/api/snapshot', source.url))).json();
  const presentations = [];

  async function captureOne(media) {
    const presentation = await collector.collect({
      media,
      styleVersion: snapshot.styleVersion,
      sourceUrl: source.url + '/'
    });
    presentations.push(presentation);
    return presentation;
  }

  const screen = await captureOne('screen');
  return {
    kind: 'rendered-catalog',
    source: { url: source.url, styleVersion: snapshot.styleVersion, lateStyle: Boolean(snapshot.lateStyle) },
    presentations,
    currentCaptureId: screen.captureId,
    async recapture(media) {
      const latest = await (await fetch(new URL('/api/snapshot', source.url))).json();
      const presentation = await collector.collect({
        media,
        styleVersion: latest.styleVersion,
        sourceUrl: source.url + '/'
      });
      presentations.push(presentation);
      return presentation;
    },
    // 回查始终锚定“引用所属那次采集”，再对照当前版报告差异。
    lookup(selector) {
      return lookupReference(this, selector);
    },
    explainCurrent(selector, currentCaptureId = this.currentCaptureId) {
      return explainAgainstCurrent(this, selector, currentCaptureId);
    }
  };
}

// 给业务人员看的摘要：正文块、标签、引用目标关联，以及被排除内容的取舍说明。
export function summarizeCatalog(catalog) {
  return {
    kind: catalog.kind,
    source: catalog.source,
    presentations: catalog.presentations.map((presentation) => ({
      captureId: presentation.captureId,
      media: presentation.media,
      style: presentation.style,
      domSignature: presentation.domSignature,
      blocks: presentation.blocks.map((block) => ({
        id: block.id,
        path: block.path,
        domText: block.domText,
        renderedLabel: block.renderedLabel,
        generated: block.generated.map((item) => ({
          pseudoType: item.pseudoType,
          renderedText: item.renderedText,
          counters: item.counters
        }))
      })),
      references: presentation.references.map((reference) => ({
        refId: reference.refId,
        targetId: reference.targetId,
        targetFound: reference.targetFound,
        rendered: reference.label.rendered
      })),
      exclusions: presentation.exclusions.map((item) => ({
        reason: item.reason,
        tag: item.tag,
        id: item.id,
        domText: item.domText,
        decision: item.decision
      }))
    }))
  };
}
