# AGENTS.md

给在本仓库里工作的 AI/人类协作者的作业说明。背景与数据流细节见 [docs/handover.md](docs/handover.md)。

## 这个仓库做什么

把 13 个英文播客做成"带字幕的增强版 RSS"，发布到 GitHub Pages：

- 12 个节目：字幕来自 PodScripts 抓取（`scraper.py`）；
- 1 个节目（how-we-made-your-mother，简称 hwmym）：字幕来自我们自己的 Whisper 转写（`transcribe.py`）；
- 两者都由 `translate_vtt.py` 生成中文，`generate_zh_feed.py` 生成中文 Feed。

**永远不要把两条来源合并成一套清单/一套流程**——它们的数据、状态文件、提交路径都不同。

## 金科玉律

1. **提交策略**：用户说"提交"才提交；"提交并推送"才 push；不建 tag、不发 release，除非明确要求。
2. **密钥永不落日志**：只允许 `…末4位`。`scripts/gemini_keys.py` 的 `label()` 是唯一允许的展示形式。
3. **每个 job 只写自己的文件**（见下表）。并发 job 之间靠 pathspec 互斥，破坏它就会冲突。
4. **不猜**：状态文件结构、VTT 形态、阈值都有实测依据，改动前先读 [docs/handover.md](docs/handover.md)。
5. **测试必须真跑**：本仓库没有 pytest 配置，逐个文件跑 `python tests/test_xxx.py`。

## 命令

```bash
# 全部测试（6 个文件，174 个用例）
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
| `progress.json`、12 个节目的 `site/<slug>/transcripts/*.vtt`、`feed.xml`、`index.html` | Crawl | ✅ |
| `state.json`、hwmym 的 `transcripts/*.vtt`、`timings/`、hwmym 的 feed/index | Transcribe | ✅ |
| `site/*/transcripts/zh/`、`site/*/feed-zh.xml`、`translations.json` | Translate | ✅ |
| 站点发布 | Deploy（push 触发，只读最新 main） | — |
| 抓取节目的两份 VTT + `timings/` | Align（会**重写**字幕） | 见 `docs/handover.md` |

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

## 改动完成后

1. 跑完 `tests/` 全部文件，确认 `OK`；
2. 如果动了 workflow，`yaml.safe_load` 通过；
3. 涉及 Data 格式（VTT/sidecar/state/progress）的改动，必须同时更新 `docs/handover.md`；
4. 不自行 push；等用户确认。
