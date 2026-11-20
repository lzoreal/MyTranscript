# 风险与回滚

## 1. 删除代码块会吃掉相邻函数头

2026-11-20 实测：函数体和下一个函数之间没有空行时，按"块 + 1 行空行"删除会连下一个函数的
`function xxx(...) {` 一起删掉。`node --check` 能第一时间发现（`Unexpected token 'function'`），
但测试套件不会。

规避：搬函数时按精确首行定位，删除只删块本身；改完先逐文件跑 `node --check site/player/*.js`，
再跑测试。**不要把 `node --check` 的结果接进 `*> $null` 这类管道**：2026-11-20 就是这么漏掉
`applySettingsPanes` 少一层括号的语法错误，浏览器报 `Unexpected identifier 'count'`、整页不启动，
测试却全绿。

## 2. 测试按文本切片，函数搬家会切断切片

`tests/test_player.py` 用 `page[page.index("function A"):page.index("function B")]` 取代码丢给 node。
A、B 被搬进不同分片后，切片会跨越 IIFE 开头，节点执行直接失败。

已受影响的：`decodeXml`、`hash32`、`primaryCategory` —— 2026-11-20 决定暂不搬，
搬之前先改测试只读对应分片。

还有一个更隐蔽的坑：切片是按两个函数名之间的整段文本，函数被搬走后，原本落在区间里的**其它**
函数也会一起消失。`showCategories` 就是这么踩的——它不在切片端点，但落在
`CATEGORY_LABELS … transcriptCoverage` 区间内，搬走后 `__SLICE__` 少了定义，
node 直接 `ReferenceError`。搬任何函数前，先查它是否落在某个测试切片区间内。

## 3. 跨分片可变绑定

`studyRenderVocab` 这类会被后段重新赋值的绑定，搬到独立作用域后包装失效（2026-11-19 已踩）。
kernel 只收纯函数和常量，不碰这类绑定。

## 回滚

分片是未提交文件，回滚按需选择：

- 单个函数搬错：把函数文本放回原分片、从 `MYTK` 的 return 与 `01` 的解构里删掉名字，重跑
  `python scripts/build_player_js.py`。
- 整批回退：`site/player.html`、`site/player.css`、`site/player.js` 的外置结果来自
  `%TEMP%\player-backup-20261120.html`（拆分前快照）；分片目录可直接删除后从备份重建。

## 4. 同名函数跨分片互相覆盖（已发生一次）

同一 IIFE 里两个 `function fetchJson` 并存，函数提升让后出现的那个赢，前一个的调用方静默用上
错误签名。拆分与"复制粘贴"都可能制造这种重名，且没有语法错误提示。

规避：`python scripts/check_layers.py` 会报出任何跨分片重名顶层函数（现锁定 633 个函数唯一）；
新增函数前先跑一次。

## 5. 平台判断分散会被逐点绕过

`window.__TAURI__` 原先散在 8 个分片、30+ 处，改一处判断就得全仓找。现统一为 `tauriHost()`，
`check_layers.py` 限定它只出现一次；新增平台分支时改这个函数，不要再直接摸全局。

## 6. 局部变量遮蔽全局 state

`01` 的 `applyCustomTheme` 里有 `const state = $('ctState')`，遮蔽了全局状态对象。批量把
`state.x =` 改成 `setState('x', …)` 时，这类局部变量会被误写进全局状态。

规避：改状态前先 `Select-String 'const state ='`，把局部变量改名（现为 `ctState`）；
`check_layers.py` 会报告任何残留的 `state.x =` 直写。

## 7. 同行多赋值与表达式内赋值

`state.a = x; state.b = y;` 与 `if (state.a = x)` 语义不同：前者可安全拆成两次 setState，
后者出现在条件里会改变真值来源。批量迁移只处理"独立语句"，条件/参数位置跳过。