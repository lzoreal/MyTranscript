# 示例插件 search-echo

一个最小的 `apiVersion: "2.2"` 插件，四类贡献各一个：

- `menus: echo`：调用 `ctx.api.toast`；
- `searchSources: echo`：返回 `{ version, items }`，等待期间检查 `ctx.signal`；
- `slots: searchAfter`：挂到 `search.results.after`，读 `ctx.payloadVersion`；
- `themes: sunset`：只有 `css`，不拿 `api`。

用它验证新宿主的三件事：按类型收窄的 ctx、独立 payload 版本、可取消的调用。

安装：把整个目录复制到 `%ProgramData%\MyTranscript\plugins\`，或在设置页「导入插件」选择该目录。
第三方插件首次启用会要求授权；这是示例，不要在没有审查的情况下扩大它的权限。

校验：

```bash
node scripts/check_plugin_manifest.mjs examples/plugins/search-echo
```
