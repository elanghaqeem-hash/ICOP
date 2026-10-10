#!/usr/bin/env bash
# Push repo ICOP CyberBusiness 360 ke GitLab dari laptop Anda.
# Pakai:  bash push-to-gitlab.sh icop-cyberbusiness360.bundle
# Butuh akses push ke gitlab.com/icop-group1/icop (SSH key atau Personal Access Token).
set -euo pipefail
BUNDLE="${1:-icop-cyberbusiness360.bundle}"
REMOTE="${GITLAB_REMOTE:-https://gitlab.com/icop-group1/icop.git}"
BRANCH="${BRANCH:-feature/cyberbusiness360-phase4}"

rm -rf icop-cb360 && git clone -q "$BUNDLE" icop-cb360 && cd icop-cb360
git remote set-url origin "$REMOTE"
# Push ke branch terpisah agar kode lama di main tidak tertimpa; gabungkan lewat Merge Request.
git push -u origin "main:${BRANCH}"
echo "Selesai. Buka Merge Request: ${REMOTE%.git}/-/merge_requests/new?merge_request[source_branch]=${BRANCH}"
