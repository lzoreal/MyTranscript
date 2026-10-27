#!/usr/bin/env bash
# 三个自动提交 job 共用：只暂存本 job 拥有的路径，push 被拒就 rebase 到最新远程再重试。
# 并发跑时后提交的 job 必然遇到 non-fast-forward；路径集互不重叠，rebase 就是干净的。
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "用法：$0 <commit message> <pathspec...>" >&2
  exit 2
fi
message=$1
shift

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if ! git add -A -- "$@"; then
  echo "git add 失败，路径：$*" >&2
  exit 1
fi

if git diff --cached --quiet; then
  echo "没有需要提交的文件"
  exit 0
fi

if ! git commit -m "$message"; then
  echo "git commit 失败" >&2
  exit 1
fi

branch=$(git rev-parse --abbrev-ref HEAD)
for attempt in 1 2 3 4 5; do
  if git push origin "HEAD:${branch}"; then
    echo "已推送到 ${branch}（第 ${attempt} 次尝试）"
    exit 0
  fi
  echo "push 被拒（第 ${attempt} 次），拉取远程后重试"
  if ! git fetch origin; then
    echo "git fetch 失败" >&2
    exit 1
  fi
  if ! git rebase "origin/${branch}"; then
    git rebase --abort
    echo "rebase 冲突：本 job 与其它 job 改了同一个文件，需要人工处理" >&2
    exit 1
  fi
  sleep "$((attempt + RANDOM % 4))"
done

echo "重试 5 次仍未推送成功" >&2
exit 1
