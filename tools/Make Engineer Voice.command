#!/bin/bash
# Outlap — records the race engineer's radio lines with your Mac's own voice
# (the built-in `say` command), into voice/ next to index.html. The game plays
# these through Web Audio with a radio filter, which works on iPhone home-screen
# apps too. Double-click this file in Finder. Run it again to re-record.
cd "$(dirname "$0")/.." || exit 1
OUT="voice"
mkdir -p "$OUT"

# best British male voice installed (System Settings > Accessibility > Spoken
# Content > System Voice > Manage Voices adds the "Enhanced"/"Premium" ones)
VOICE=""
LIST="$(say -v '?' | sed -E 's/ {2,}[a-z]{2}_[A-Z]{2}.*//')"
for v in "Jamie (Premium)" "Jamie (Enhanced)" "Daniel (Enhanced)" "Arthur (Enhanced)" "Oliver (Enhanced)" "Jamie" "Daniel" "Arthur" "Oliver"; do
  if printf '%s\n' "$LIST" | grep -qx "$v"; then VOICE="$v"; break; fi
done
if [ -z "$VOICE" ]; then VOICE="$(say -v '?' | grep -E 'en_GB' | head -1 | sed -E 's/ {2,}[a-z]{2}_[A-Z]{2}.*//')"; fi
if [ -z "$VOICE" ]; then VOICE="$(say -v '?' | grep -E 'en_' | head -1 | sed -E 's/ {2,}[a-z]{2}_[A-Z]{2}.*//')"; fi
echo "Voice: ${VOICE:-system default}"

# id|line  (several lines per id = variants, picked at random in the game)
LINES=$(cat <<'EOF'
test|Radio check. Loud and clear.
vsc|Virtual safety car, virtual safety car. Keep the delta positive, no overtaking.
vsc|V S C, V S C. Slow down, stay positive on the delta.
vsc_end|V S C ending. Get ready to go.
vsc_end|V S C ending, be ready for green.
sc|Safety car, safety car. Slow down and close up to the queue. No overtaking.
sc|Safety car deployed. Keep the delta positive, catch the pack.
sc_in|Safety car in this lap. Safety car in this lap.
sc_in|Safety car is coming in this lap. Get ready for the restart.
sc_lights|Safety car lights are out. Leader controls the pace, stay sharp.
sc_lights|Lights out on the safety car. Watch the leader, be ready.
sc_lights_you|Safety car lights are out. You control the restart. Your call.
restart_go|He's gone! Go, go, go. No overtaking before the line.
restart_go|Leader is going. Full power, pass after the line.
green|Green flag. Push now.
green|Track is clear. Green, green, green.
red|Red flag, red flag. The race is stopped. We can change tyres and fix the car.
resume_grid|Standing restart. Back on the grid, watch the lights.
resume_sc|We're resuming behind the safety car.
debris|Debris on track. Careful.
box_cheap|Box this lap for a cheap stop. Your call.
box_cheap|Cheap stop available. Box, box if you want it.
cover_ahead|The car ahead has pitted. Box this lap to cover?
cover_behind|The car behind has pitted. Box this lap to cover the undercut?
unlap|You're a lap down. You can overtake the safety car and unlap yourself.
failure|We've lost the car. Pull over safely. Sorry, mate.
EOF
)

TMP="$(mktemp -d)"
JSON="{\"lines\":{"
FIRST=1
PREV=""
N=0
while IFS='|' read -r ID TEXT; do
  [ -z "$ID" ] && continue
  if [ "$ID" != "$PREV" ]; then
    [ -n "$PREV" ] && JSON="$JSON],"
    JSON="$JSON\"$ID\":["
    N=0; PREV="$ID"
  else
    JSON="$JSON,"
  fi
  N=$((N+1))
  F="${ID}_${N}.m4a"
  if [ -n "$VOICE" ]; then say -v "$VOICE" -r 205 -o "$TMP/a.aiff" "$TEXT"; else say -r 205 -o "$TMP/a.aiff" "$TEXT"; fi
  afconvert -f m4af -d aac -b 64000 "$TMP/a.aiff" "$OUT/$F" >/dev/null 2>&1
  JSON="$JSON\"$F\""
  echo "  $F  — $TEXT"
done <<< "$LINES"
JSON="$JSON]},\"voice\":\"$VOICE\"}"
printf '%s\n' "$JSON" > "$OUT/manifest.json"
rm -rf "$TMP"

if command -v git >/dev/null 2>&1 && [ -d .git ]; then
  git add "$OUT" >/dev/null 2>&1 && git commit -q -m "Engineer radio: recorded voice lines ($VOICE)" >/dev/null 2>&1 && echo "Committed. Now push:  git push origin main"
fi
echo ""
echo "Done — $(ls "$OUT"/*.m4a | wc -l | tr -d ' ') radio lines in $OUT/. You can close this window."
