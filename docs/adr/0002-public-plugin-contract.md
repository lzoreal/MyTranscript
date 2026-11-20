# 插件公共契约采用声明式贡献点与窄运行时 API

Status: accepted（2026-11-20）

插件清单声明全部贡献点：`pages`、`slots`、`settings`、`commands`、`providers`、`capability claims`、`importers`、`searchSources`、`menus`、`themes`。插件脚本通过 `MyTPlugins.define(id, { contributions })` 只实现清单声明过的 ID；宿主逐一核对，未声明、重复或越权的贡献直接拒绝加载。

运行时只向插件提供窄 API：`player`、`events`、`storage`、`navigate`、`capability`；内部实现细节收敛为显式的内核能力服务。槽位名和顺序由宿主固定，插件只声明进入哪个槽、优先级和渲染函数，不能自由改 DOM 位置。

公共 API 采用 `2.x` 只增不破：`3.0` 才允许破坏，并保留一个版本的适配层。清单声明 `apiVersion` 和所需贡献点；宿主不认识的贡献点拒绝加载，不静默降级。

## Consequences

- 官方插件与第三方插件使用同一套公共契约，第一方不再有隐式深桥。
- 第一版一次开全贡献点，之后槽位名和贡献结构不能再改；再改就是 `3.0`。
- 契约测试必须覆盖清单校验、贡献注册、冲突规则、依赖排序和停用回收。
