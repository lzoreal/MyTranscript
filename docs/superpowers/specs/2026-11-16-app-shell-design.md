# MyTranscript 全站外壳与订阅设计

日期：2026-11-16
状态：已确认（2026-11-16 用户批准设计，开始实现）
原型：`mytranscript-prototype-flat-player-theme-fixed.html`（用户提供）

## 目标

参考原型把 MyTranscript 从“单页播放器”升级为带应用外壳的站点：
首页、播客库、发现、搜索、节目/单集详情、播放器、队列、历史、书签、笔记、
收听模式、设置；加入站内订阅、链接导入、OPML 导入导出；全站支持多主题。
播放器的音频、字幕、进度、对齐等既有能力保持不变。

## 实测约束

- `site/` 下 14 个 feed 共约 51MB（the-daily 单个约 20MB）。首页和播客库
  不能直接拉 feed，否则首屏不可用。
- Simplecast、Megaphone、Amperwave、Libsyn、Art19 的 feed 对本站 Origin
  返回 `Access-Control-Allow-Origin: *`，站外订阅可直接 fetch；不支持的宿主
  需要自定义 CORS 代理或手动粘贴 RSS 内容。
- `site/index.html`、`site/podcasts.html` 由流水线生成；`site/player.html`
  是手写文件，`tests/test_player.py` 钉住了若干部件与字符串。
- 仓库内没有前端构建工具；站点是 GitHub Pages 静态文件。

## 架构决定

采用单页应用（SPA）方案：

- `site/player.html` 同时承载应用外壳与播放器；hash 路由控制页面。
- 只有一个 `audio` 元素和一个播放器引擎，切换页面不中断播放。
- 外壳各页只读写本地状态，不做演示数据。
- `site/index.html` 改为跳转到 `player.html#/home`；`podcasts.html` 保留为
  兼容的节目清单。
- 新增 `site/catalog.json`，由 `scripts/build_catalog.py` 从各 `feed.xml`
  生成，publish job 发布后重建。

## 路由

| 路由 | 页面 |
| --- | --- |
| `#/home` | 首页 |
| `#/library` | 播客库 |
| `#/discover` | 发现 |
| `#/search/<q>` | 搜索 |
| `#/podcast/<key>` | 节目详情 |
| `#/episode/<key>/<epId>` | 单集详情 |
| `#/player/<key>/<epId>[?t=秒]` | 播放器（隐藏外壳） |
| `#/queue` / `#/history` / `#/bookmarks` / `#/notes` / `#/listening` / `#/settings` | 功能页 |

兼容旧的 `player.html?show=<slug>&ep=<id>` 深链。所有路由参数用
`encodeURIComponent`。

## 数据

### 站点目录 `site/catalog.json`

```json
{
  "generated_at": "2026-11-16T00:00:00Z",
  "shows": [
    {
      "slug": "smartless",
      "name": "SmartLess",
      "feed": "smartless/feed.xml",
      "artwork": "https://...jpg",
      "description": "...",
      "episode_count": 382,
      "latest": [
        {
          "id": "guid",
          "title": "Episode title",
          "date": "Thu, 12 Nov 2026 08:00:00 +0000",
          "duration": "01:03:29",
          "url": "https://...mp3",
          "directUrl": "",
          "img": "https://...jpg",
          "description": "400 字以内的纯文本简介",
          "transcript": {"type": "application/json", "url": "https://raw.githubusercontent.com/..."}
        }
      ]
    }
  ]
}
```

- 每节目最多 20 条 `latest`，按 `pubDate` 倒序。
- `feed` 使用编码后的相对路径（`99%25-invisible/feed.xml`）。
- 仅收录 `podcast:transcript` 指向本项目的字幕。

### 本地状态（localStorage）

| 键 | 内容 |
| --- | --- |
| `myt-subs` | 订阅数组；不存在时默认订阅全部内置节目，存在（含空数组）时按存储为准 |
| `myt-progress` | 每集 `{t,d,at,show,title,img,key,feed}`；旧 `{t,d,at}` 兼容 |
| `myt-queue` | 队列数组（节目/单集元数据） |
| `myt-bookmarks` | 句级书签 `{id,key,ep,show,title,t,en,zh,at}` |
| `myt-notes` | 笔记 `{id,title,body,show,ep,t,at}` |
| `myt-theme` / `myt-theme-dark` / `myt-theme-light` | 主题 |
| `myt-reader` | 阅读排版 |
| `myt-cors-proxy` | 可选 CORS 代理模板，`{url}` 占位 |
| `myt-play-mode` / `myt-sleep` | 收听模式、睡眠定时 |
| `myt-ep-<key>` | 上次选中的单集 |

站外 feed 的原始 XML 放在 IndexedDB（库名 `myt-feeds`，key 为绝对 URL），
避免刷新后重复请求；不可用时退化为内存缓存。

### 订阅

内置节目默认全部订阅（无 feed 的 the-pragmatic-engineer 不计入）。
站外节目以 `ext-<hash>` 作为 key；`feed` 为绝对 URL。

添加站外节目流程：

1. 规范化 URL（缺少协议补 `https://`）。
2. URL 命中内置增强 feed → 转为内置订阅。
3. 直连 fetch；失败时用设置的 CORS 代理；再失败给出“粘贴 RSS 内容”兜底。
4. 解析成功写入订阅和 IndexedDB；失败仍可“保存链接”，节目页显示重试。

OPML：

- 导入解析 `<outline xmlUrl>`，内置 feed 映射为内置订阅，其余为站外订阅，
  导入后逐个懒加载。
- 导出包含全部订阅；内置使用增强 feed 绝对地址。

### 站外节目

- 只有音频；界面标注“仅音频，无增强字幕”。
- 字幕标签指向本项目域名/raw.githubusercontent 的 JSON 时才启用逐词稿。

## 主题

保留 7 套主题：brass、midnight、forest、oxblood、celadon（深色）、
paper、mist（浅色）。外壳复用既有 `--bg/--panel/--ink/--muted/--line/--accent`
token，并新增每套主题的侧栏 token。所有新页面不写死颜色。默认 brass。

## 播放器改造

对齐 `mytranscript-prototype-flat-player-theme-fixed.html` 的播放器页：

- 顶部：返回、`NOW PLAYING · 节目`、单集信息、收藏当前句。
- 正文：全宽、无卡片、句间分隔线、时间列、行内词高亮。
- 底部：贴边全宽 dock；进度行、正在播放、−15″/+30″、播放、逐词/逐句、
  倍速、信息、单集、沉浸、Aa。
- 右侧抽屉：单集信息、单集列表（沿用现有内容）。
- 排版面板保留全部现有滑杆。
- 既有能力保留：直连 CDN、词级时间、断点续播、偏移对齐、实验数据导入、
  多主题、沉浸模式、回到当前句。

新增：

- 收藏当前句（顶栏星标），书签页可跳回该时间点。
- 睡眠定时（15/30/45/60 分钟、本集结束），真实暂停。
- 收听模式：沉浸、连续播放、节目电台、简洁驾驶（隐藏正文、放大控件）。
- 外壳 mini-player，切换页面继续播放。

## 各页行为

- 首页：继续收听（最近未听完）、订阅节目最近更新（catalog）、真实统计。
- 播客库：订阅节目网格、搜索、添加 RSS、OPML 导入/导出。
- 发现：内置节目目录（已订阅标记 + 订阅切换），站外订阅列表。
- 搜索：播客与单集（catalog + 已加载 feed）；文字稿只搜当前单集并明示。
- 节目详情：封面/简介/订阅/增强 feed 复制/最近单集/加载全部单集。
- 单集详情：播放、加入队列、收藏、复制链接、字幕状态。
- 队列：增删、立即播放、下一集。
- 历史：来自 `myt-progress`，继续播放、清除。
- 书签：句级片段，跳回时间点，删除。
- 笔记：新建/删除，可关联节目与单集。
- 收听模式：四种模式 + 睡眠定时。
- 设置：播放（默认倍速/连续播放/记住位置）、文字稿、外观（7 主题 + 排版）、
  RSS 与订阅（添加/导入/导出/CORS 代理/移除）、数据管理（导出/清除）、关于。

## 不做

- 无后端、无账号、无跨设备同步。
- 无全站文字稿全文搜索、无 PWA/离线。
- 站外 feed 抓取失败时不伪造数据。

## 验证

- `python tests/test_player.py` 保持通过；新增 OPML/目录/订阅辅助函数测试。
- `for f in tests/test_*.py; do python "$f"; done` 全绿。
- 本地 HTTP 服务 + 浏览器：桌面/移动、7 套主题、内置/站外订阅、OPML
  往返、无效 OPML、坏 feed、CORS 失败、空库、断点续播、书签回跳。
- `index.html` 跳转 app；`podcasts.html` 仍可访问。
