# 发现页排行榜（v1 需求）

## 目标

在桌面版的「发现」页里加一个**排行榜** tab：用户能按地区看 Apple Podcasts 总榜，
按分类看 Podcast Index 趋势榜，点节目先预览、再订阅。榜单只是「发现→订阅」的入口，
不改变播放、订阅、目录的既有机制。

## 范围

**做**

- 发现页顶部增加 `排行榜` tab，与现有「目录 / 在线搜索」并列。
- 地区：完整 storefront 下拉（默认 `cn`），记住上次选择。
- 总榜：Apple Marketing RSS，取前 50，展示名次、封面、节目名、作者、分类。
- 分类榜：Podcast Index `podcasts/trending`，按分类过滤，取前 50。
- 分类入口：常用 10 类横排 chips，其余收进「更多」。
- 点卡片：走现有在线预览（简介 / 最近单集），预览里点订阅。
- 已订阅的节目保留在榜内，卡片显示「已订阅」，点击进已订阅详情。
- 刷新：进入读缓存（1 小时），过期自动重取；提供手动刷新按钮。
- 失败：显示上次缓存 + 顶部错误条与重试，不阻断浏览。
- 默认状态：记住上次的地区与分类。

**不做**

- 不做名次涨跌箭头（需要每日快照，v1 不落这份存储）。
- 不接 Spotify 榜单（无官方 API，网页抓取不合规）。
- 不接 Listen Notes（付费，v1 不需要）。
- 不做网页版入口：GitHub Pages 上不显示排行榜 tab。
- 不做「一键订阅全部」「榜单订阅提醒」。

## 数据契约

### 总榜（Apple）

```
GET https://rss.applemarketingtools.com/api/v2/{storefront}/podcasts/top/50/podcasts.json
```

- 无鉴权；`feed.results` 的数组顺序就是名次；`feed.updated` 是抓取时间。
- 每行只有 `id / name / artistName / url / genres / artworkUrl100`，**没有 feedUrl**。
- 该域对带 `Origin` 的请求返回 403，浏览器跨域直连不可用。
- 不支持分类过滤（`top/50/{genreId}.json` 实测 404）。

### feedUrl 解析（iTunes Lookup）

```
GET https://itunes.apple.com/lookup?id={id1,id2,...}&entity=podcast&country={storefront}
```

- 支持批量 id；返回 `feedUrl / collectionName / artistName / artworkUrl600 / trackCount`。
- 该域带 `Access-Control-Allow-Origin: *`，浏览器可直连。
- 榜单 50 条一次批量换回；失败的单条不阻塞其余条目。

### 分类榜（Podcast Index）

```
GET https://api.podcastindex.org/api/1.0/podcasts/trending?max=50&cat={category}
```

- 复用现有 `PODCAST_INDEX` 内置凭据与 `podcastIndexAuth` 签名（`06-catalog-feeds-search.js`）。
- 返回自带 `feedUrl`，不需要再 lookup。
- **语义是「趋势」，不是「名次」**：名次按返回顺序展示，文档与 UI 不宣称它是听众排名。
- 分类 id 使用 Podcast Index 的分类体系；常用 10 类固定映射，其余从分类列表取。

## 交互

1. 进入发现页 → 默认停在排行榜 tab（记住上次的 tab）。
2. 选地区 / 分类 → 拉榜单 → 列表渲染。
3. 点一张卡 → 在线预览（复用 `onlinePreview` / `onlineDetailHTML`）。
4. 预览里点订阅 → 走 `subscribeFromOnline`，写入现有订阅与 feed 缓存。
5. 已订阅的卡显示标记，点击直接进已订阅的节目详情。
6. 顶部刷新按钮：忽略缓存重取；失败落回缓存 + 错误条。

## 缓存

- 榜单：`localStorage`，按 `{source}|{storefront}|{category}` 分键，TTL 1 小时。
- lookup：按 `storefront + id` 缓存 24 小时，跟随 iTunes 的 `Cache-Control`。
- 预览用的 feed 内容继续走现有 feed 缓存，不额外加一层。

## 跨主题约束

排行榜不是一套独立视觉，它必须活在现有主题体系里。约束如下：

- **只复用现有原语**：tab 用 `.tabs`，分类 chips 用 `.online-chips`，节目行用 `.online-row` /
  `.online-art` / `.online-body` / `.online-actions`，按钮用 `.btn`，徽标用 `.pill`。
  这些类在 `site/player.css` 里已有完整样式，9 套随包主题全部继承。
- **不新建主题私有样式**：不往 9 个 `themes/*.css` 里加榜单规则；需要新增的只有基础层
  一个 `.chart-rank`（名次数字），颜色只用 `var(--ink) / var(--muted) / var(--line) / var(--accent)`，
  禁止写死 `#fff` / `#000` / 固定背景。
- **布局不假设侧栏形态**：Folia 的侧栏是窄 rail，档案室是纸张底，编辑部是浅色；
  榜单容器只占 `.page` 内正常文档流，不 fixed、不依赖侧栏宽度。
- **浅色档同样要能读**：`ledger / apple / news` 是浅色，名次与“已订阅”标记必须用 token，
  不能靠深色背景反白。
- **主题切换不重载**：榜单与主题同属一个 skeleton，切主题只换 CSS，榜单状态必须保留。

验收主题矩阵（共 16 档）：

- 内置深色：`plate / spotify / console`
- 内置浅色：`prototype / ledger / apple / news`
- 随包 6 套：`liquid-glass / glass2 / minimal-maxi / mono-tech / surveillance / folia-poster`

重点看 `folia-poster`（满宽 `.page`、窄侧栏）。

## 技术落点

- 页面与交互：`src/player-js/07-routes-pages.js` 的 `renderDiscover()` / `renderOnlineResults()` 旁新增排行榜分支。
- 取数：`src/player-js/06-catalog-feeds-search.js` 复用 `fetchJson`、`mapAppleResults`、`subscribeFromOnline`；新增 `fetchChart`、`resolveFeedUrls`、`fetchCategoryTrending`。
- Apple 总榜：桌面壳调 `http_text`（`00-runtime.js` 已暴露），网页版不执行。
- 分类榜：沿用现有 Web Crypto 签名与内置凭据。
- 不需要新增路由，也不需要新增插件。

## 验收

- 桌面版：切 `cn / us` 都能在 8 秒内拿到 50 条总榜；封面与名次正确。
- 任意一条总榜能解析出 `feedUrl` 并完成订阅；订阅后榜单标记为「已订阅」。
- 分类榜切换 10 个常用分类都能出结果；空结果有明确空态。
- 断网后重进：显示缓存榜单 + 错误条；手动刷新可恢复。
- 网页版：没有排行榜 tab，DOM 中不出现死入口。
- 16 档主题逐档切换：榜单 tab 可点、名次可读、行不溢出、订阅按钮不被裁；
  浅色档对比度正常；切换主题后榜单状态不丢。
- 9 套随包主题的 CSS 文件零改动（`git diff themes/` 为空）。
- 缓存过期后自动重取，不重复打两次相同请求。

## 风险与已知缺口

- Apple 榜单域对 `Origin` 返回 403，网页版无法直连；这是 v1 桌面限定的直接原因。
- Podcast Index 凭据仍在客户端；沿用现状，不在本需求里迁移。
- 「分类榜」与「总榜」语义不同（趋势 vs 名次），UI 文案必须区分，不能统一叫「排名」。
- 地区下拉覆盖全部 storefront 后，部分地区可能没有榜单数据，需要空态。
- 5 套随包主题对 `.online-row` / 发现页是零覆盖，榜单会继承基础层样式；可用但不一定贴合
  主题气质（例如 surveillance 的监控感、glass2 的玻璃层次）。v1 先保证“全主题不坏”，
  各包要不要强化，等验收后再按需 opt-in。

## 数据来源

- Apple Podcasts Marketing Tools RSS（榜单与目录元数据）。
- iTunes Lookup API（feedUrl 解析）。
- Podcast Index API（分类趋势）。

界面需标注「数据来源 Apple Podcasts / Podcast Index」，不得暗示官方背书。
