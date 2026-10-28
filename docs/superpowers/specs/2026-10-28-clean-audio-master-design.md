# master 音频地址改写：决策记录（不实施）

日期：2026-10-28 结论：**不实施，代码已回退**。保留此文件是因为其中的实测数据对今后任何
"要不要改成干净音频地址"的讨论都是决定性的。

## 原方案（已放弃）

把增强版 Feed 发布的 `<enclosure url>` 从追踪套娃（`pdst.fm/e/…`、`mgln.ai/e/…`、`pdrl.fm/…`）
剥成宿主自己的规范地址（如 `serve.castfire.com/audio/….mp3`），逐节目抽样 20 集全过才放行。

## 为什么放弃

**改写地址去不掉广告。** 三层实测：

1. wrapper 只是重定向，不代理字节：同一 IP 下 wrapper 与 master 最终落到同一个 CDN 对象
   （4 个宿主族全部验证，Simplecast 那集做过整文件 SHA-256）。
2. 广告由 CDN 按听众 IP 在 **master 域名上**插入：hwmym 同一 master 地址，中国 78,219,122 字节、
   日本 78,940,728 字节，ETag 也不同。
3. 因此听众听到的广告取决于他自己的 IP，与订阅的是官方 feed 还是增强版无关。

改写唯一实际"去掉"的是发布方的**下载统计与归因**（少一次 wrapper 命中）。音频不变、广告不变、
听众体验不变，收益不成立，所以不做。

## 实测证据（2026-10-28）

同 IP 下 wrapper vs master：4 个宿主族（castfire / Megaphone / Simplecast / Omny）逐字节一致。

跨出口（中国直连 vs 日本系统代理），14 个节目各取最新一集：

| 结果 | 节目 |
| --- | --- |
| 长度与头/中/尾三段一致（8） | office-ladies、99%-invisible、smartless、hidden-brain、the-rest-is-history、programming-throwdown、speaking-of-psychology、the-aspiring-psychologist-podcast |
| 长度与 ETag 不同（1） | how-we-made-your-mother：+721,606 字节 ≈ 30.1 秒，中插落在 15.6–19.5 MB 之间，前贴片内容也不同 |
| 中国直连不可达、未比对（5） | the-psychology-of-your-20s、the-pragmatic-engineer、algorithms-data-structures-programs、the-taproot-podcast、casefile-true-crime |

后 5 个是这台机器中国**直连**的路由问题（CI 走中国代理，这些宿主在代理路径上可达），
不代表它们没有地域插播。美国出口未测（用户选择先不测）。

## 若将来重启，前置条件

- 先证明"**同一 IP** 下 wrapper 与 master 字节不同"（目前 0 例）；那是改写会改变内容的唯一信号。
- 或者目标改成"去掉统计而非广告"，并且获得节目方同意。
- "同一 IP 上两侧一致"**不能**当作地域插播的检测手段——同 IP 永远同一变体。

## 本次唯一保留的改动

与地址无关的一个 bug 修复：lxml 把文件名当 URI 解析，含 `%` 的相对路径（`99%-invisible`）
在 Windows 上写 `feed.xml` 直接抛 `FileNotFoundError`；改为写文件句柄后可正常生成。
`tests/test_scraper_utils.py::FeedWriteTests` 覆盖。

## 附：为什么抓来的字幕没有广告（2026-10-28 实测，含一处降级）

**PodScripts 不提供音频。** 单集页有 `<audio id="main_pod_player"><source></audio>`，但
`<source>` 是空的；播放器脚本（`episodesingle_novue.js`）只做显示/隐藏、seek 和句子高亮，
从不设置 `src`；浏览器抓请求，**0 个 media 请求**，页面上的第三方只有 Mediavine 广告与 GA；
全站页面与 JS 里没有任何 mp3/m4a 地址。它是纯文本站，靠页面广告变现。

**可以确定的两点：**

- PodScripts 不删广告：casefile-true-crime 的字幕里出现 "our sponsors"。
- 它们转写的音频与我们的 feed 时长一致：office-ladies 同一集 feed 4712 秒 vs 字幕结束 4693 秒；
  99%-invisible 2118 秒 vs 2099 秒（两处都差 19 秒，应是片尾未转写）。

**不能确定的：我们的 RSS 文件到底有没有广告。** 因为 PodScripts 不存音频，它们的字幕只反映
"它们自己转写的那份音频"；而我们从未直接转写过这些节目的音频（自转的只有 hwmym）。
反证也有一处：99%-invisible 的 shownotes 明确写「订阅 SiriusXM Podcasts+ 可无广告收听新集、
提前一周」——说明官方认为常规 feed 版本是带广告的。所以"字幕里没广告"也可能只是
"广告是纯音乐/无口播，或 ASR 跳过了"，不能当作"我们的文件没有广告"的证据。

**定论方法**：直接本地转写我们自己下载的文件（例：office-ladies 前 3 分钟）。
本机未安装 faster-whisper，尚未执行。


