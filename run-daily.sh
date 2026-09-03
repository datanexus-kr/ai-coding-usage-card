#!/bin/zsh
# Daily AI usage refresh — regenerates cards/*.svg and rewrites the README
# usage note in the profile repo.
# Scheduled by ~/Library/LaunchAgents/com.datanexus.ai-usage-card.plist
set -uo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export USAGE_CARD_REPO="datanexus-kr/datanexus-kr"
export USAGE_CARD_DEVICE="macbookpro"
# Codex plan_type flipped prolite -> team on 2026-07-29, and the active Claude
# Code credential was created the same morning. Days before that are personal.
export USAGE_CARD_ACCOUNT_SPLIT="2026-07-29:personal:work"

cd "$HOME/Projects/ai-coding-usage-card" || exit 1
echo "--- $(date '+%Y-%m-%d %H:%M:%S %z') ---"
node usage-card.mjs && node update-note.mjs
