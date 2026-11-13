# AGENTS.md

给在本仓库里工作的 AI/人类协作者的作业说明。背景与数据流细节见 [docs/handover.md](docs/handover.md)。

## 这个仓库做什么

把 14 个英文播客做成"带字幕的增强版 RSS"，发布到 GitHub Pages：

- 13 个已发布节目全部走统一管线：RSS → ASR 词流 → 双语词级 JSON，
  存 `data/<slug>/`，导出 `json/<slug>/`；**两者在独立的 `data` 分支**（main 不存），
  由 raw.githubusercontent 提供、不进 Pages；本地可 sparse 检出跳过；
- how-we-made-your-mother（hwmym）的入口仍是 `transcribe.py`，但产物同样是 `data/` + `json/`；
- 旧 VTT / 中文 VTT / `feed-zh.xml` 链路已下线（`translate_vtt.py`、`generate_zh_feed.py`、
  `translate.yml`、`align.yml` 已删除）；只剩 7 集历史字幕仍以 VTT 发布，等回填后清掉。

状态文件仍然彼此独立（`progress.json`、`state.json`、`data/<slug>/state-*.json`），
不要为了省事把它们合成一份。

## 金科玉律

1. **提交策略**：用户说"提交"才提交；"提交并推送"才 push；不建 tag、不发 release，除非明确要求。
2. **密钥永不落日志**：只允许 `…末4位`。`scripts/gemini_keys.py` 的 `label()` 是唯一允许的展示形式。
3. **每个 job 只写自己的文件**（见下表）。并发 job 之间靠 pathspec 互斥，破坏它就会冲突。
4. **不猜**：状态文件结构、VTT 形态、阈值都有实测依据，改动前先读 [docs/handover.md](docs/handover.md)。
5. **测试必须真跑**：本仓库没有 pytest 配置，逐个文件跑 `python tests/test_xxx.py`。

## 命令

本地克隆建议只取 main（默认 clone 会连 `data` 分支一起拉）：

```bash
git clone --single-branch --filter=blob:none --sparse https://github.com/lzoreal/MyTranscript.git
cd MyTranscript
git sparse-checkout set --no-cone '/*' '!/data/**' '!/json/**'
```

```bash
# 全部测试
for f in tests/test_*.py; do python "$f"; done

# 单文件
python tests/test_align_timings.py

# 语法/配置检查
python -c "import ast,pathlib; ast.parse(pathlib.Path('scripts/xxx.py').read_text(encoding='utf-8'))"
python -c "import yaml; yaml.safe_load(open('.github/workflows/xxx.yml', encoding='utf-8'))"
```

本地跑真实转写要用 Python 3.10（3.14 上装不了 faster-whisper）：

```bash
WHISPER_MODEL="D:/tmp/tmlt-align/ct2-turbo" \
  "/c/Users/游梦/AppData/Local/Programs/Python/Python310/python.exe" your_script.py
```

## 文件归属（改代码前先看这张表）

| 路径 | 归属 job | 其他 job 不得写 |
| --- | --- | --- |
| `progress.json`、站点根 `index.html`、`podcasts.html` | Crawl（只再抓 pragmatic-engineer 等未迁移节目） | ✅ |
| `state.json`、hwmym 的 `transcripts/*.vtt`、`timings/`、hwmym 的 feed/index | Transcribe | ✅ |
| `data/**`（双语词级 JSON + 分片 state）、`json/<slug>/**`（**都在 `data` 分支**） | Transcript Pipeline / Transcribe | ✅ |
| `feed.xml`、`index.html`、`progress.json`（main） | Transcript Pipeline（`transcripts.yml` 的 publish） | ✅ |
| 站点发布 | Deploy（main 上 `site/**` 变更触发，只读最新 main） | — |

## 已知坑（都踩过）

| 坑 | 规避 |
| --- | --- |
| Windows 控制台是 GBK，emoji/中文会让 stdout 崩 | 脚本里 `sys.stdout.reconfigure(encoding="utf-8", errors="replace")` |
| lxml 把含 `%` 的相对路径当 URI，Windows 上写 `feed.xml` 失败 | 用 `with open(tmp, "wb")` 再 `tree.write(handle)` |
| bash heredoc 里写 `\\n` 会被吞成真换行 | 用 `chr(10)` 拼字符串，或写脚本文件而不是 heredoc |
| GitHub 表达式里数字 `0` 是假值 | `matrix.shard == 0` 必须 `format('{0}', matrix.shard)` 再判 |
| `if: always()` 不覆盖 job **超时**（会被直接取消） | 预算必须 < `timeout-minutes`，shard 内结果要尽早落到 sidecar |
| 本地 `origin` URL 可能被脚本改坏（变成 `https://…@github.com/.git`） | 临时用完整 URL `git fetch https://github.com/lzoreal/MyTranscript.git main` |
| `git_push_retry.sh` 对不存在的 pathspec 会 `git add` 失败 | 动态只加"存在且非空"的目录 |
| 分批迁移时 feed 整批消失 | `pipeline_site.merged_processed` 只在 JSON 已导出时才切标签，否则保留 VTT（有测试锁定） |

## 改动完成后

1. 跑完 `tests/` 全部文件，确认 `OK`；
2. 如果动了 workflow，`yaml.safe_load` 通过；
3. 涉及 Data 格式（VTT/sidecar/state/progress）的改动，必须同时更新 `docs/handover.md`；
4. 不自行 push；等用户确认。
