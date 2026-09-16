#!/bin/zsh
# Daily AI usage refresh — regenerates cards/*.svg and rewrites the README
# usage note with cost-curation insights and junho-humanizer in the profile repo.
# Scheduled by ~/Library/LaunchAgents/com.datanexus.ai-usage-card.plist
set -uo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export USAGE_CARD_REPO="datanexus-kr/datanexus-kr"
export USAGE_CARD_GITHUB_USER="datanexus-kr"
export USAGE_CARD_DEVICE="macbookpro"
export USAGE_CARD_CURATION_INDEX="https://datanexus-kr.github.io/index.json"
export USAGE_CARD_HUMANIZER_DIR="$HOME/.codex/skills/junho-humanizer"
# Codex plan_type flipped prolite -> team on 2026-07-29, and the active Claude
# Code credential was created the same morning. Days before that are personal.
export USAGE_CARD_ACCOUNT_SPLIT="2026-07-29:personal:work"

cd "$HOME/Projects/ai-coding-usage-card" || exit 1
echo "--- $(date '+%Y-%m-%d %H:%M:%S %z') ---"
node usage-card.mjs || exit 1

# The note step ends in an LLM review that rejects its own draft more often than
# not — the humanizer keeps strengthening claims past what the sources support.
# The rejection is non-deterministic and leaves the published README untouched,
# so redraft several times before giving up. At the observed ~70% reject rate,
# five tries lose the day's note about one run in six; three would lose one in
# three. Each try is roughly 90s.
for attempt in 1 2 3 4 5; do
  node update-note.mjs && break
  echo "[note] attempt $attempt rejected; redrafting"
done
