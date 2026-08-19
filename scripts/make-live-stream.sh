#!/usr/bin/env bash
#
# A local live HLS stream, stamped with EXT-X-PROGRAM-DATE-TIME.
#
# The point of generating one rather than pointing at a public test stream is that
# the claims being demonstrated are about PROGRAM-DATE-TIME, discontinuities and
# DVR behaviour — all of which are properties of the *packager*. With a stream we
# control, the failure modes can be provoked on demand instead of waited for.
#
# The picture carries a burned-in elapsed timecode, frame counter and wall clock, so
# two consoles can be checked for agreement by eye rather than by trusting the
# readouts they print.
#
#   ./scripts/make-live-stream.sh                # 25 fps, 2 s segments, 60 s DVR
#   ./scripts/make-live-stream.sh --restart-after 120
#
# `--restart-after N` kills and relaunches the encoder after N seconds, which is the
# realistic way an EXT-X-DISCONTINUITY and a PROGRAM-DATE-TIME reset appear. That is
# the single most likely thing to go wrong in live operation, so it is worth being
# able to reproduce it in a meeting.

set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR=".stream"
FPS=25
SEGMENT_SECONDS=2
DVR_SEGMENTS=30          # 30 × 2 s = a 60 s DVR window
RESTART_AFTER=0
FONT="/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart-after) RESTART_AFTER="$2"; shift 2 ;;
    --fps) FPS="$2"; shift 2 ;;
    --segment-seconds) SEGMENT_SECONDS="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
done

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 69; }
[[ -f "$FONT" ]] || FONT="$(fc-match --format=%{file} 'DejaVu Sans Mono' 2>/dev/null || true)"
[[ -f "$FONT" ]] || { echo "no monospace font found for drawtext" >&2; exit 69; }

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.ts "$OUT_DIR"/*.m3u8

GOP=$(( FPS * SEGMENT_SECONDS ))

draw() {
  echo "drawtext=fontfile=${FONT}:fontsize=${2}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=10:x=28:y=${3}:text='${1}'"
}

FILTERS="$(draw '%{pts\:hms}' 64 28)"
FILTERS="${FILTERS},$(draw 'frame %{n}' 34 120)"
FILTERS="${FILTERS},$(draw '%{localtime}' 30 172)"

# `append_list` is what turns an encoder restart into an EXT-X-DISCONTINUITY plus a
# fresh PROGRAM-DATE-TIME, rather than a playlist that silently starts over from
# media sequence 0. It is only wanted when we intend to restart — on a clean run it
# just puts a stray discontinuity tag at the head of the playlist.
HLS_FLAGS="delete_segments+program_date_time+independent_segments+omit_endlist"
if [[ "$RESTART_AFTER" -gt 0 ]]; then
  HLS_FLAGS="${HLS_FLAGS}+append_list"
fi

encoder=""

run_encoder() {
  ffmpeg -hide_banner -loglevel warning \
    -re -f lavfi -i "testsrc2=size=1280x720:rate=${FPS}" \
    -vf "${FILTERS}" \
    -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
    -g "${GOP}" -keyint_min "${GOP}" -sc_threshold 0 \
    -f hls \
    -hls_time "${SEGMENT_SECONDS}" \
    -hls_list_size "${DVR_SEGMENTS}" \
    -hls_flags "${HLS_FLAGS}" \
    -hls_segment_filename "${OUT_DIR}/seg%05d.ts" \
    "${OUT_DIR}/index.m3u8"
}

cleanup() {
  trap - EXIT INT TERM
  [[ -n "$encoder" ]] && kill "$encoder" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "live stream  → http://localhost:3200/stream/index.m3u8"
echo "segments     → ${OUT_DIR}/ (${SEGMENT_SECONDS}s × ${DVR_SEGMENTS} = $(( SEGMENT_SECONDS * DVR_SEGMENTS ))s DVR)"
echo "             served by app/stream/[...file]/route.ts, NOT public/ — Next indexes"
echo "             public/ at build time and 404s anything created after it"
echo "program-date-time: on"
if [[ "$RESTART_AFTER" -gt 0 ]]; then
  echo "encoder restart every ${RESTART_AFTER}s → discontinuity + PDT reset"
fi
echo

if [[ "$RESTART_AFTER" -gt 0 ]]; then
  while true; do
    run_encoder &
    encoder=$!
    sleep "$RESTART_AFTER"
    echo "--- restarting encoder (expect a discontinuity) ---"
    kill "$encoder" 2>/dev/null || true
    wait "$encoder" 2>/dev/null || true
    encoder=""
  done
else
  run_encoder &
  encoder=$!
  wait "$encoder"
fi
