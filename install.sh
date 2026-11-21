#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_NAME="xxn-lite-loop"
DRY_RUN=0
WITH_HOOKS=0
HOOK_TARGET=""
CUSTOM_TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --with-hooks) WITH_HOOKS=1; shift ;;
    --hook-target) HOOK_TARGET="${2:-}"; shift 2 ;;
    --target) CUSTOM_TARGET="${2:-}"; shift 2 ;;
    -h|--help)
      echo "用法: bash install.sh [--target <目录>] [--with-hooks [--hook-target claude|codex|antigravity]] [--dry-run]"
      exit 0
      ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

TARGETS=()
if [ -n "$CUSTOM_TARGET" ]; then
  TARGETS+=("$CUSTOM_TARGET")
else
  TARGETS+=("$HOME/.agents/skills/$SKILL_NAME")
  if [ -d "$HOME/.claude" ]; then
    TARGETS+=("$HOME/.claude/skills/$SKILL_NAME")
  fi
fi

COPY_ITEMS=(SKILL.md README.md references scripts hooks)

for dest in "${TARGETS[@]}"; do
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] 将安装 $SKILL_NAME -> $dest"
    continue
  fi
  mkdir -p "$dest"
  if [ "$SCRIPT_DIR" -ef "$dest" ]; then
    continue
  fi
  for item in "${COPY_ITEMS[@]}"; do
    if [ -e "$SCRIPT_DIR/$item" ]; then
      rm -rf "$dest/$item"
      cp -R "$SCRIPT_DIR/$item" "$dest/$item"
    fi
  done
  echo "✅ 已安装 $SKILL_NAME -> $dest"
done

if [ "$WITH_HOOKS" -eq 1 ] && [ -f "$SCRIPT_DIR/hooks/install-hooks.mjs" ]; then
  ARGS=()
  [ -n "$HOOK_TARGET" ] && ARGS+=(--target "$HOOK_TARGET")
  [ "$DRY_RUN" -eq 1 ] && ARGS+=(--dry-run)
  HOOK_INSTALLER="${TARGETS[0]}/hooks/install-hooks.mjs"
  if [ "$DRY_RUN" -eq 1 ]; then
    HOOK_INSTALLER="$SCRIPT_DIR/hooks/install-hooks.mjs"
  fi
  node "$HOOK_INSTALLER" "${ARGS[@]}"
fi

echo "🎉 完成。重启 AI 客户端或新开会话后，输入：\$xxn-lite-loop <一句话描述你的需求>"
