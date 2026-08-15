# dsh-global-search 🧭

DeepSeek Harness 全局对话内容搜索插件：**跨所有工作区全文搜索会话内容**，消息级命中 + 关键词高亮 + **一键跳转到具体消息位置**。

## 功能

- 🔍 **全局全文搜索**：搜索所有工作区、所有历史会话的用户消息与助手回复内容（不再局限于对话标题）
- 📍 **消息级命中**：结果精确到会话里的某条消息，显示角色（问/答）、时间与上下文片段
- ✨ **关键词高亮**：命中片段中的关键词高亮显示，一眼定位
- 🎯 **精确跳转**：点击结果打开会话并**自动滚动到该条消息**，闪烁高亮提示
- ⌨️ **Ctrl+F 快捷键**：随时呼出搜索面板（Mac 为 Cmd+F），已打开时再次按下聚焦输入框
- 📶 **索引进度**：首次使用自动扫描全部会话，界面实时显示索引进度
- 🔄 **实时增量**：新消息通过事件监听增量入索引，无需手动重建
- 🎨 **无侵入 UI**：透明遮罩，背景完全不变，只有搜索面板浮出；点击面板外区域或 Esc 关闭

## 使用

1. 点击侧边栏底部的 **「全局搜索」** 按钮，或按 **Ctrl+F**（Mac：Cmd+F）
2. 输入关键词（支持中文、英文、代码片段等任意子串），稍候即出结果
3. 点击任意**命中片段** → 自动打开对应会话并滚动定位到该消息（闪烁高亮）
4. 点击会话标题区 → 打开会话（定位到首个命中）

## 架构

```
lib/index.js    Host 半：扫描会话日志（多帧 zstd + JSONL 事件）→ 内存索引 → HTTP 搜索 API
lib/client.js   Client 半：侧边栏按钮 + 搜索面板 + 快捷键 + DOM 定位跳转（React）
```

- 会话日志位置：`<DSH_HOME>/sessions/<工作区>/<会话ID>/session.jsonl.zstd`
  （自动探测 `$DSH_HOME`、`~/.dsh`、`%APPDATA%\DeepWharf\harness`）
- 搜索 API：
  - `GET /api/global-search?q=<关键词>&limit=<数量>` → 搜索结果（含 snippet 高亮偏移与 DOM 定位指纹）
  - `GET /api/global-search/status` → 索引状态
  - `POST /api/global-search/rescan` → 强制重建索引
- 跳转定位：Host 返回每条命中的 `fingerprint`（剥离 markdown 符号与空白后的文本指纹），Client 在会话 DOM 中匹配 `[data-chat-anchor-key]` 消息块并滚动高亮；配有多候选回退（关键词 / 原始前缀）

## 安装

插件开发于 `E:\Documents\DeepSeeK\dsh-global-search`，已安装到：

```
%APPDATA%\DeepWharf\harness\plugins\dsh-global-search     ← 插件本体
%APPDATA%\DeepWharf\harness\profiles\node_modules\dsh-global-search   ← Junction 链接
%APPDATA%\DeepWharf\harness\profiles\web\cordis.patch.yml ← 注册行（id: global-search）
```

升级插件：重新复制 `lib/` 与 `package.json` 到 plugins 目录后重启应用。

## 开发要点（踩坑记录）

- **Cordis `inject` 必须声明依赖服务**：`inject: []` 会让 `apply` 立即执行，`ctx.get('webServer')` 拿到 `undefined` 导致路由注册被静默跳过；声明 `inject: ['webServer']` 后 cordis 会等服务就绪再 `apply`。Client 半同理（`exports.inject = ['timer']`）。
- **会话日志是多帧 zstd 容器**：`session.jsonl.zstd` 是多个独立 zstd 帧拼接（追加写入），不能整体解压；需按帧格式解析边界后逐帧解压。
- **Client 半服务访问**：`ctx.get(name)` 无需声明；`ctx.name` 属性访问必须声明在 `inject` 里（动态包白名单）。
- 测试：`node test-host.mjs`（独立 mock ctx 验证扫描与搜索逻辑）。

## 限制

- 索引保存在内存中，应用重启后自动重建（一般几秒内完成，界面有进度提示）
- 单个会话日志超过 64MB 会被跳过（防止占用过多内存）
- 每条消息最多索引前 20000 字符
- 跳转定位依赖消息块已渲染；极早期历史消息若未加载，至少会打开对应会话
