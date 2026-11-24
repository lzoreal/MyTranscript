# 骨架归主题所有，`player.html` 只留开屏外壳

主题从「只改颜色与排版」升级为「自带骨架」：`site/player.html` 的静态 body 抽成
`site/skeletons/<id>.html`，构建期打包成 `window.MYT_SKELETONS`（照 `themes-defaults.js` 的
先例），开屏时用一段普通 script 按当前生效档注入到骨架容器，再让 `player.js`（`type="module"`，
天然 defer）接手。JS 需要往页面里塞东西的地方，一律由骨架留 `[data-anchor="…"]`，不再假设某个
类名一定存在。

这样做是因为「不像桌面应用」这条不满要求改版面结构，而旧的 `html` 字段只能往
`#customHomeMount` 塞附加块——它从来不是骨架替换。下面两条替代方案被否掉：只给新档一份专属骨架
（会长出第二套机制，且「每个主题都能改骨架」就是假的）；单骨架 + 区块开关（结构差异被预留区块锁死）。

Consequences: 骨架必须在任何 `$()` 绑定之前落地（`00-runtime.js` 在模块顶层就抓
`epList`/`transcript`），所以注入脚本要放在 body 末尾、module 之前，不能放进 `head`；切到骨架不同的档
必须重载页面，不能靠热切；13 档主题要逐档回归，因为错位脚本拦不住，只能看。
