#!/bin/zsh
# Daily AI usage card refresh — regenerates cards/*.svg in the profile repo.
# Scheduled by ~/Library/LaunchAgents/com.datanexus.ai-usage-card.plist
set -uo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export USAGE_CARD_REPO="datanexus-kr/datanexus-kr"
export USAGE_CARD_DEVICE="macbookpro"

cd "$HOME/Projects/ai-coding-usage-card" || exit 1
echo "--- $(date '+%Y-%m-%d %H:%M:%S %z') ---"
node usage-card.mjs
