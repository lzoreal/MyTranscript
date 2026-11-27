# 主题 × 页面视觉审计

一次把 **6 套随包主题 × 18 个页面 × 桌面/移动两档宽度** 全拍一遍，顺带跑四类自动检测：
文字对比度（只在纯色底上算）、11px 以下的字号、30px 以下的可点元素、横向溢出。
产物是一叠截图 + 每套主题一张联系表，扫一眼就能发现哪套主题在哪个页面塌了。

## 跑法

```bash
python -m pip install playwright          # 首次；只装 Python 包，不下载 chromium
python scripts/theme_audit.py             # 默认 6 套主题 × 18 页 × 1440/390
python scripts/theme_audit.py --themes liquid-glass,glass2 --widths 1440 --routes home,settings
python scripts/theme_audit.py --no-serve  # 8899 端口上已经有站点服务时
```

浏览器用本机 Edge（`channel="msedge"`）。脚本自己起一个 `http.server` 指向 `site/`，
跑完自动关掉；产物落在 `.tmp-theme-audit/`（命中 `.gitignore` 的 `.tmp-*`，不入库）：

| 文件 | 内容 |
| --- | --- |
| `<宽>-<主题>-<页>.png` | 单页截图（1440×900 / 390×844） |
| `sheet-<宽>-<主题>.jpg` | 6 列联系表，一屏看完这套主题的全部页面 |
| `audit.json` | 每页的指标明细（哪条文字、多少对比度、多小的命中区） |

## 为了“像真用户”而做的状态预置

空 localStorage 的首页只有空态，看不出问题，所以每次都会先种：

- `myt-subs`：内置节目前 8 档（订阅态）；
- `myt-progress` / `myt-favorites` / `myt-queue` / `myt-bookmarks`：各 2–4 条，
  让「继续收听 / 队列 / 收藏 / 书签」有内容；
- `myt-theme-custom.enabled = true`：随包主题是由自定义主题通道注入的，不开这个开关
  `ct-pack-*` 只有骨架没有皮肤。

## 怎么读指标（别当成 hard fail）

- **对比度**：只对不透明纯色底计算；渐变/图片底直接跳过，所以玻璃、海报墙这类主题
  天然报得少，仍要人眼过一遍联系表。
- **clipped / 省略号**：长标题用 `text-overflow: ellipsis` 是设计，不是 bug；
  自动检测会把这类也算进去，看文字是否“关键信息被吃掉”再决定。
- **switch**：拨杆视觉是 36×20，热区用 `::before` 补到了 44×40，检测只看外框会误报。
- **横向溢出**：Folia 桌面端的三列海报墙本身就是横向可滚的“镜头墙”，
  `main.scrollWidth > clientWidth` 是预期；移动端（≤900）才是真溢出。

## 最近一次全量（2026-11-27）修掉的东西

- 底栏浮层压住页面最后一行（设置/统计/笔记）：`.main` 底部内联距改成
  `calc(var(--bottom) + 54px)`。
- 空状态只有一句提示贴在面板上沿：`emptyLine()` 生成的 `.empty-line` 统一成
  虚线占位块（居中、图标、可挂 CTA）。
- 单集行在窄屏被挤成 “The Part…”：标题允许两行、副标题可换行；
  顺手修掉裸 `.ep-title` 把行内标题放大到 26px 的老问题（详情页 H1 现在限定 `#page-episode`）。
- 小控件命中区：`--ctl-h-sm` 28→32，`mini-btn` 32，移动端统一 40；拨杆热区补到 44×40。
- 字号下限：`player.css` 与 6 套主题里 11px 以下的字号全部抬到 11px。
- 主题对比度：glass2 主按钮底色、surveillance 主按钮文字、folia 详情页 CTA、
  mono/surveillance 统计页注释。
- Folia 海报墙：≤900 不再铺二维镜头墙（JS `foliaNarrow`），退回三列/两列瀑布，
  并让第一排避开悬浮搜索胶囊；浮动侧栏在底栏导航接管后收起。
- 播放页侧栏「节目 · 日期」不再截成 “202_”，允许换两行。

## 已知但这次没动的

- 播放页（网页版）音频模式中间是一块空白：网页端没有字幕/封面舞台，桌面壳里才有。
- 设置页在 1440 下仍是单列窄栏，右侧留白偏多；这是编辑式骨架的选择，改动面大。
