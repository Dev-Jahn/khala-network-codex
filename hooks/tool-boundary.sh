# PostToolUse fast path for Codex lanes (see lib/lane.mjs). Shell builtins only:
# without a lane marker for this identity, or with an empty inbox, it exits 0
# with no output and Node never starts. Codex runs hooks in the session cwd.
if [ "${KHALA_SESSION+set}" = set ]; then
  id=$KHALA_SESSION
elif [ -f .khala-codex-session ]; then
  IFS= read -r id 2>/dev/null < .khala-codex-session || [ -n "$id" ] || exit 0
  case $id in *[!a-z0-9-]) id=${id%?} ;; esac # CRLF line ending
else
  exit 0
fi
case $id in '' | -* | *[!a-z0-9-]*) exit 0 ;; esac
home=${KHALA_HOME-$HOME/.khala}
[ -f "$home/run/codex/$id.lane" ] || exit 0
for item in "$home/inbox/$id/new"/*; do
  [ -e "$item" ] || exit 0
  exec node "${0%/*}/hook.mjs" PostToolUse
done
