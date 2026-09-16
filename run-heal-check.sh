#!/bin/zsh
# Hourly watchdog for the published AI usage ledger — see heal-check.mjs.
# Scheduled by ~/Library/LaunchAgents/com.datanexus.ai-usage-card-watchdog.plist
set -uo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export USAGE_CARD_REPO="datanexus-kr/datanexus-kr"
export USAGE_CARD_GITHUB_USER="datanexus-kr"
export USAGE_CARD_DEVICE="macbookpro"
export USAGE_CARD_ACCOUNT_SPLIT="2026-07-29:personal:work"

cd "$HOME/Projects/ai-coding-usage-card" || exit 1
node heal-check.mjs
