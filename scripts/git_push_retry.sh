#!/usr/bin/env bash
# 各自动提交 job 共用：只暂存本 job 拥有的路径，push 被拒就 rebase 到最新远程再重试。
# 并发跑时后提交的 job 必然遇到 non-fast-forward；路径集互不重叠，rebase 就是干净的。
# GIT_WORKTREE 指向另一个检出（如 data 分支的 data-repo）；默认在当前目录提交。
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "用法：$0 <commit message> <pathspec...>" >&2
  exit 2
fi
message=$1
shift
work=${GIT_WORKTREE:-.}

gitc() { git -C "$work" "$@"; }

gitc config user.name "github-actions[bot]"
gitc config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if ! gitc add -A -- "$@"; then
  echo "git add 失败，路径：$*" >&2
  exit 1
fi

if gitc diff --cached --quiet; then
  echo "没有需要提交的文件"
  exit 0
fi

if ! gitc commit -m "$message"; then
  echo "git commit 失败" >&2
  exit 1
fi

branch=$(gitc rev-parse --abbrev-ref HEAD)
for attempt in 1 2 3 4 5; do
  if gitc push origin "HEAD:${branch}"; then
    echo "已推送到 ${branch}（第 ${attempt} 次尝试）"
    exit 0
  fi
  echo "push 被拒（第 ${attempt} 次），拉取远程后重试"
  if ! gitc fetch origin; then
    echo "git fetch 失败" >&2
    exit 1
  fi
  if ! gitc rebase "origin/${branch}"; then
    gitc rebase --abort
    # 两片重跑同一集时，data/<slug>/<guid>.json 会 add/add 冲突。同一集的产物是
    # 等价的，保留远程那一份，本片的重复劳动丢掉即可——否则整片的提交都推不上去。
    echo "rebase 冲突，改用保留远程版本重试"
    if ! gitc rebase -X ours "origin/${branch}"; then
      gitc rebase --abort
      echo "rebase 冲突：非内容冲突无法自动取远程，需要人工处理" >&2
      exit 1
    fi
  fi
  sleep "$((attempt + RANDOM % 4))"
done

echo "重试 5 次仍未推送成功" >&2
exit 1
