# 本地资料源约定

页面用真实 CSS counter-reset/counter-increment、::before/::after 和 print 媒体规则生成标签。CSSOM content 可能是未解析计数表达式；采集结果需结合实际呈现，不应把表达式字符串充当编号。#insert 会使后续章节编号变化。

## 采集侧约定（接收器，不属于源端）

- 编号证据以 CDP `Accessibility.getFullAXTree` 的解析结果为准：伪元素在无障碍树中是被忽略的 `none` 节点，其 `StaticText` 子节点持有已解析的计数器真值；DOM 侧用 `DOM.describeNode` 的 `pseudoElements[].backendNodeId` 与伪节点 `backendDOMNodeId` 对齐。
- `getComputedStyle(element, '::before').content` 仅作为 CSS 表达式证据保存，表达式与渲染文字的计数器对齐失败时保留整段渲染文字，不编造数值。
- 每次采集生成独立 `captureId`，记录媒体（screen/print）、源端声明的 `styleVersion`、样式表内容哈希（样式签名）、DOM 指纹、字体状态与样式变更事件。同一段落跨呈现只通过稳定 `id`（无 id 时用结构路径）关联，编号文字不参与关联。
- 引用回查只接受目标锚点 `id`：在引用所属采集内定位目标；对照另一采集时单独报告重编号与路径移动，绝不按编号文本反查目标。
- `aria-hidden="true"` 元素、`hidden` 元素与视觉隐藏的读屏专用元素不进入正文块，统一写入 `exclusions` 并附原因与来源文字。

## 通用控制

`GET /api/snapshot` 查看当前原始源状态；`POST /api/action` 接收 JSON 对象 `{"action":"动作名"}`。可用动作：reset、late-style。控制只改变模拟源，不代表接收器已经处理了变化。

所有资料均由本项目构造，包含的机构、设备、会话和文件仅供本地使用，不访问真实账号。浏览器操作应通过正常可见界面；测试用源控制接口不是业务采集捷径。

## 来源证据

源端请求记录只用于核查服务行为，接收器自身的审计、状态和输出需由扩展功能负责。源端重启会恢复默认资料，但本地接收文件不会自动清空。
