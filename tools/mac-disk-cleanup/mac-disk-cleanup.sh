#!/bin/bash
#
# mac-disk-cleanup.sh — automated, reversible disk cleanup for macOS (Apple Silicon).
#
# Nothing is ever deleted without passing three independent checks:
#
#   CHECK 1  scan   — builds a written plan. Read-only. Deletes nothing.
#   CHECK 2  apply  — re-validates every path in the plan against the live disk,
#                     runs the safety guards again, asks you to type each category
#                     name, then MOVES files to a quarantine folder. Reversible.
#   CHECK 3  purge  — the only command that actually destroys data, and only from
#                     inside quarantine. Requires typing the exact size total.
#
# Between checks 2 and 3 you can use your Mac normally and confirm nothing broke.
# `restore` puts everything back if it did.
#
# Usage:
#   ./mac-disk-cleanup.sh scan
#   ./mac-disk-cleanup.sh apply --plan <planfile> [--dry-run] [--allow-during-render]
#   ./mac-disk-cleanup.sh purge
#   ./mac-disk-cleanup.sh restore
#   ./mac-disk-cleanup.sh snapshots [--reclaim GB | --delete-all]
#   ./mac-disk-cleanup.sh archive --plan <planfile> --to /Volumes/YourSSD
#
set -u
set -o pipefail

# ---------------------------------------------------------------------------
# CONFIGURATION — edit this block before first use
# ---------------------------------------------------------------------------

# Folders that must NEVER be touched, no matter what. Add every project folder,
# every render scratch/cache location, and anything else you care about.
# One per line. Trailing slashes optional. Globs are NOT expanded — use real paths.
PROTECT_PATHS=(
  "$HOME/Documents"
  "$HOME/Movies"
  "$HOME/Pictures"
  "$HOME/Music"
  "$HOME/Desktop"
  # --- ADD YOUR PROJECT FOLDERS BELOW THIS LINE ---
  # "$HOME/Work/ClientRenders"
  # "$HOME/Dropbox/Projects"
)

# Skip anything modified more recently than this. A running app touches its own
# cache constantly, so this is the primary "is it in use?" guard.
MIN_AGE_MINUTES=60

# Files in ~/Downloads older than this are treated as review-tier candidates.
DOWNLOADS_AGE_DAYS=30

# Ignore candidates smaller than this. Keeps the plan readable.
MIN_CANDIDATE_MB=50

# Allowed drift between scan time and apply time before a path is rejected.
SIZE_TOLERANCE_PCT=25

# Processes that mean "creative work in progress". If any are running, `apply`
# refuses to do anything unless you pass --allow-during-render, and the caches
# belonging to these apps are never candidates at all.
RENDER_PROCESSES=(
  "Final Cut Pro" "Compressor" "Motion"
  "DaVinci Resolve" "Adobe Premiere Pro" "After Effects" "Adobe Media Encoder"
  "ffmpeg" "HandBrake" "Blender" "Topaz" "ScreenFlow" "Camtasia"
)

# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

QUARANTINE_ROOT="$HOME/.mac-disk-cleanup-quarantine"
PLAN_DIR="$HOME/.mac-disk-cleanup-plans"
SELF="$(basename "$0")"

# Paths that are rejected on exact match, always, regardless of category.
HARD_DENY=(
  "/" "/System" "/Users" "/Applications" "/Volumes" "/Library" "/private"
  "$HOME" "$HOME/Library" "$HOME/Library/Caches" "$HOME/Library/Developer"
  "$HOME/Library/Application Support" "$HOME/Library/Containers"
  "$HOME/Documents" "$HOME/Desktop" "$HOME/Downloads" "$HOME/Movies"
  "$HOME/Pictures" "$HOME/Music" "$HOME/.Trash"
)

C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
C_BLU=$'\033[34m'; C_BLD=$'\033[1m';  C_OFF=$'\033[0m'

die()  { printf '%s\n' "${C_RED}error: $*${C_OFF}" >&2; exit 1; }
warn() { printf '%s\n' "${C_YEL}warning: $*${C_OFF}" >&2; }
info() { printf '%s\n' "$*"; }
hdr()  { printf '\n%s\n' "${C_BLD}$*${C_OFF}"; }

# bytes -> human readable
human() {
  local b=${1:-0}
  if   [ "$b" -ge 1073741824 ]; then awk -v b="$b" 'BEGIN{printf "%.1f GB", b/1073741824}'
  elif [ "$b" -ge 1048576 ];    then awk -v b="$b" 'BEGIN{printf "%.0f MB", b/1048576}'
  elif [ "$b" -ge 1024 ];       then awk -v b="$b" 'BEGIN{printf "%.0f KB", b/1024}'
  else printf '%s B' "$b"; fi
}

# Shorten $HOME/x to ~/x for display.
short() { case "$1" in "$HOME"/*) printf '~/%s' "${1#$HOME/}" ;; *) printf '%s' "$1" ;; esac; }

# Disk usage of a path, in bytes. 0 if missing/unreadable.
size_bytes() {
  local p="$1" kb
  [ -e "$p" ] || { echo 0; return; }
  kb=$(du -sk "$p" 2>/dev/null | awk 'NR==1{print $1}')
  [ -n "${kb:-}" ] || kb=0
  echo $(( kb * 1024 ))
}

abspath() {
  local p="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "$p" 2>/dev/null && return
  fi
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$p" 2>/dev/null
}

free_bytes() {
  local b
  b=$(df -k /System/Volumes/Data 2>/dev/null | awk 'NR==2{print $4*1024}')
  [ -n "${b:-}" ] || b=$(df -k / 2>/dev/null | awk 'NR==2{print $4*1024}')
  printf '%s' "${b:-0}"
}

render_running() {
  local p
  for p in "${RENDER_PROCESSES[@]}"; do
    if pgrep -f -- "$p" >/dev/null 2>&1; then printf '%s' "$p"; return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Safety guards. Every candidate path passes ALL of these, at scan time AND
# again immediately before it is moved. Prints a reason and returns 1 on reject.
# ---------------------------------------------------------------------------
guard_path() {
  local raw="$1" allow_prefix="$2" p d

  p="$(abspath "$raw")"
  [ -n "${p:-}" ] || { echo "cannot resolve path"; return 1; }
  [ -e "$p" ]     || { echo "no longer exists"; return 1; }

  # 1. Never an exact match against a top-level or system directory.
  for d in "${HARD_DENY[@]}"; do
    [ "$p" = "$d" ] && { echo "refuses to act on protected directory itself"; return 1; }
  done

  # 2. Must live under the expected allowlist prefix for its category. This is
  #    what stops a mangled variable from pointing the deleter somewhere else.
  case "$p" in
    "$allow_prefix"/*|"$allow_prefix") : ;;
    *) echo "outside allowed prefix $allow_prefix"; return 1 ;;
  esac

  # 3. Must be inside the home folder.
  case "$p" in
    "$HOME"/*) : ;;
    *) echo "outside home folder"; return 1 ;;
  esac

  # 4. Must not be inside — or contain — anything you marked protected.
  for d in "${PROTECT_PATHS[@]}"; do
    d="${d%/}"
    [ -n "$d" ] || continue
    case "$p" in
      "$d"|"$d"/*) echo "inside protected path $d"; return 1 ;;
    esac
    case "$d" in
      "$p"/*) echo "contains protected path $d"; return 1 ;;
    esac
  done

  # 5. Not too shallow. Anything less than three levels deep under / is suspect.
  local depth
  depth=$(printf '%s' "$p" | awk -F/ '{print NF-1}')
  [ "$depth" -ge 3 ] || { echo "path too shallow (depth $depth)"; return 1; }

  # 6. Recently modified means something is probably using it right now.
  if [ -d "$p" ]; then
    if find "$p" -newermt "-${MIN_AGE_MINUTES} minutes" -print -quit 2>/dev/null | grep -q .; then
      echo "modified in the last ${MIN_AGE_MINUTES} min (possibly in use)"; return 1
    fi
  else
    if [ -n "$(find "$p" -newermt "-${MIN_AGE_MINUTES} minutes" -print -quit 2>/dev/null)" ]; then
      echo "modified in the last ${MIN_AGE_MINUTES} min (possibly in use)"; return 1
    fi
  fi

  # 7. Not belonging to a creative app that is currently running.
  local rp
  for rp in "${RENDER_PROCESSES[@]}"; do
    case "$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')" in
      *"$(printf '%s' "$rp" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"*)
        if pgrep -f -- "$rp" >/dev/null 2>&1; then
          echo "belongs to running app $rp"; return 1
        fi ;;
    esac
  done

  # 8. No process is holding a file open in there.
  if command -v lsof >/dev/null 2>&1; then
    if lsof -w -- "$p" 2>/dev/null | grep -q .; then
      echo "a running process has this open"; return 1
    fi
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Candidate discovery. Each emits: tier<TAB>category<TAB>allowprefix<TAB>path
# tier is "safe" (rebuildable) or "review" (not rebuildable — never auto-applied)
# ---------------------------------------------------------------------------

emit() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4"; }

# Caches we leave alone even when idle: system plumbing and anything creative.
cache_is_excluded() {
  case "$1" in
    *com.apple.containermanagerd*|*com.apple.Safari.SafeBrowsing*|\
    *CloudKit*|*com.apple.iCloudHelper*|*FamilyCircle*) return 0 ;;
  esac
  local rp
  for rp in "${RENDER_PROCESSES[@]}"; do
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
      *"$(printf '%s' "$rp" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"*) return 0 ;;
    esac
  done
  return 1
}

discover() {
  local min_bytes=$(( MIN_CANDIDATE_MB * 1048576 ))
  local p sz

  # --- Trash -------------------------------------------------------------
  if [ -d "$HOME/.Trash" ]; then
    for p in "$HOME"/.Trash/* "$HOME"/.Trash/.[!.]*; do
      [ -e "$p" ] || continue
      emit safe trash "$HOME/.Trash" "$p"
    done
  fi

  # --- Xcode: rebuildable ------------------------------------------------
  for p in "$HOME/Library/Developer/Xcode/DerivedData" \
           "$HOME/Library/Developer/Xcode/iOS DeviceSupport" \
           "$HOME/Library/Developer/Xcode/watchOS DeviceSupport" \
           "$HOME/Library/Developer/CoreSimulator/Caches"; do
    [ -d "$p" ] || continue
    sz=$(size_bytes "$p"); [ "$sz" -ge "$min_bytes" ] || continue
    emit safe xcode-rebuildable "$HOME/Library/Developer" "$p"
  done

  # --- Xcode archives: NOT rebuildable, contains shipped dSYMs -----------
  if [ -d "$HOME/Library/Developer/Xcode/Archives" ]; then
    sz=$(size_bytes "$HOME/Library/Developer/Xcode/Archives")
    [ "$sz" -ge "$min_bytes" ] && \
      emit review xcode-archives "$HOME/Library/Developer" "$HOME/Library/Developer/Xcode/Archives"
  fi

  # --- Simulator devices -------------------------------------------------
  if [ -d "$HOME/Library/Developer/CoreSimulator/Devices" ]; then
    sz=$(size_bytes "$HOME/Library/Developer/CoreSimulator/Devices")
    [ "$sz" -ge "$min_bytes" ] && \
      emit review simulator-devices "$HOME/Library/Developer" "$HOME/Library/Developer/CoreSimulator/Devices"
  fi

  # --- User caches -------------------------------------------------------
  if [ -d "$HOME/Library/Caches" ]; then
    for p in "$HOME"/Library/Caches/*; do
      [ -e "$p" ] || continue
      cache_is_excluded "$p" && continue
      sz=$(size_bytes "$p"); [ "$sz" -ge "$min_bytes" ] || continue
      emit safe user-caches "$HOME/Library/Caches" "$p"
    done
  fi

  # --- Developer tool caches --------------------------------------------
  for p in "$HOME/.npm/_cacache" "$HOME/Library/Caches/Yarn" \
           "$HOME/Library/pnpm/store" "$HOME/.cache/pip" \
           "$HOME/Library/Caches/Homebrew" "$HOME/.cargo/registry/cache" \
           "$HOME/.gradle/caches" "$HOME/Library/Caches/go-build"; do
    [ -d "$p" ] || continue
    sz=$(size_bytes "$p"); [ "$sz" -ge "$min_bytes" ] || continue
    emit safe dev-caches "$HOME" "$p"
  done

  # --- iOS device backups: irreplaceable if the device is gone -----------
  local ios="$HOME/Library/Application Support/MobileSync/Backup"
  if [ -d "$ios" ]; then
    for p in "$ios"/*; do
      [ -e "$p" ] || continue
      emit review ios-backups "$ios" "$p"
    done
  fi

  # --- Old downloads -----------------------------------------------------
  if [ -d "$HOME/Downloads" ]; then
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      sz=$(size_bytes "$p"); [ "$sz" -ge "$min_bytes" ] || continue
      emit review downloads-old "$HOME/Downloads" "$p"
    done < <(find "$HOME/Downloads" -mindepth 1 -maxdepth 1 -mtime "+${DOWNLOADS_AGE_DAYS}" 2>/dev/null)
  fi

  # --- iOS software update files ----------------------------------------
  for p in "$HOME/Library/iTunes"/*"Software Updates" \
           "$HOME/Library/Application Support/MobileSync/SoftwareUpdates"; do
    [ -d "$p" ] || continue
    sz=$(size_bytes "$p"); [ "$sz" -ge "$min_bytes" ] || continue
    emit safe ios-updates "$HOME/Library" "$p"
  done
}

# ---------------------------------------------------------------------------
# CHECK 1 — scan (read-only)
# ---------------------------------------------------------------------------
cmd_scan() {
  mkdir -p "$PLAN_DIR"
  local stamp plan tmp
  stamp=$(date +%Y%m%d-%H%M%S)
  plan="$PLAN_DIR/plan-$stamp.tsv"
  tmp="$PLAN_DIR/.raw-$stamp"

  hdr "Disk overview"
  df -h / /System/Volumes/Data 2>/dev/null
  info ""
  info "Finder reports more free space than this because it counts 'purgeable'"
  info "space (mostly Time Machine snapshots) as available. The number above is real."

  hdr "Time Machine local snapshots"
  local snaps
  snaps=$(tmutil listlocalsnapshots / 2>/dev/null | grep -c 'com.apple.TimeMachine')
  if [ "${snaps:-0}" -gt 0 ]; then
    tmutil listlocalsnapshots / 2>/dev/null | sed 's/^/  /'
    info ""
    info "${C_YEL}$snaps snapshot(s) found. These are frequently the largest single${C_OFF}"
    info "${C_YEL}consumer on a full drive. They are handled by:  $SELF snapshots${C_OFF}"
  else
    info "  none"
  fi

  local render_app
  if render_app=$(render_running); then
    hdr "Render in progress"
    info "${C_YEL}Detected running: $render_app${C_OFF}"
    info "Its caches are excluded from all results, and 'apply' will refuse to run"
    info "until it finishes (override with --allow-during-render)."
  fi

  hdr "Scanning (read-only, this takes a minute)…"
  discover > "$tmp" 2>/dev/null

  : > "$plan"
  {
    echo "# mac-disk-cleanup plan"
    echo "# created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# host: $(hostname -s)  user: $(whoami)"
    echo "# columns: tier<TAB>category<TAB>bytes<TAB>allowprefix<TAB>path"
  } >> "$plan"

  local tier cat prefix path sz reason
  local -i n_ok=0 n_skip=0
  local total_safe=0 total_review=0
  local skipped="$PLAN_DIR/.skipped-$stamp"
  : > "$skipped"

  while IFS=$'\t' read -r tier cat prefix path; do
    [ -n "${path:-}" ] || continue
    if reason=$(guard_path "$path" "$prefix"); then
      sz=$(size_bytes "$path")
      printf '%s\t%s\t%s\t%s\t%s\n' "$tier" "$cat" "$sz" "$prefix" "$path" >> "$plan"
      if [ "$tier" = safe ]; then total_safe=$(( total_safe + sz ));
      else total_review=$(( total_review + sz )); fi
      n_ok=$(( n_ok + 1 ))
    else
      printf '%s\t%s\n' "$reason" "$path" >> "$skipped"
      n_skip=$(( n_skip + 1 ))
    fi
  done < "$tmp"
  rm -f "$tmp"

  hdr "Results — biggest first"
  printf '%-8s %-20s %10s  %s\n' TIER CATEGORY SIZE PATH
  printf '%s\n' "--------------------------------------------------------------------------------"
  grep -v '^#' "$plan" | sort -t$'\t' -k3,3nr | while IFS=$'\t' read -r tier cat sz prefix path; do
    local color="$C_GRN"; [ "$tier" = review ] && color="$C_YEL"
    printf '%s%-8s%s %-20s %10s  %s\n' "$color" "$tier" "$C_OFF" "$cat" "$(human "$sz")" "$(short "$path")"
  done

  if [ "$n_skip" -gt 0 ]; then
    hdr "Skipped by safety guards ($n_skip)"
    while IFS=$'\t' read -r reason path; do
      printf '  %-52s %s\n' "$(short "$path")" "${C_BLU}$reason${C_OFF}"
    done < "$skipped"
  fi
  rm -f "$skipped"

  hdr "Totals"
  printf '  %ssafe%s   (rebuildable, auto-applied)      %s\n' "$C_GRN" "$C_OFF" "$(human "$total_safe")"
  printf '  %sreview%s (NOT rebuildable, never auto)    %s\n' "$C_YEL" "$C_OFF" "$(human "$total_review")"
  printf '  free space right now                    %s\n' "$(human "$(free_bytes)")"

  hdr "Plan written"
  info "  $plan"
  info ""
  info "Nothing has been deleted or moved. To continue:"
  info "  ${C_BLD}$SELF apply --plan $plan${C_OFF}"
  info ""
  info "Review-tier items are listed but will NOT be acted on by 'apply'. Archive"
  info "them to an external drive instead:  $SELF archive --plan <plan> --to /Volumes/NAME"
}

# ---------------------------------------------------------------------------
# CHECK 2 — apply (re-validate, confirm, move to quarantine)
# ---------------------------------------------------------------------------
cmd_apply() {
  local plan="" dry=0 allow_render=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --plan) plan="${2:-}"; shift 2 ;;
      --dry-run) dry=1; shift ;;
      --allow-during-render) allow_render=1; shift ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [ -n "$plan" ] || die "apply requires --plan <file>. Run '$SELF scan' first."
  [ -f "$plan" ] || die "plan not found: $plan"

  local render_app
  if render_app=$(render_running); then
    if [ "$allow_render" -eq 0 ]; then
      die "'$render_app' is running. Refusing to touch anything mid-render.
       Wait for it to finish, or re-run with --allow-during-render if you are
       certain it is unrelated to the files in the plan."
    fi
    warn "proceeding while '$render_app' is running, at your explicit request"
  fi

  hdr "CHECK 2 of 3 — re-validating the plan against the live disk"

  local tier cat sz prefix path now reason
  local -a ok_tier ok_cat ok_sz ok_path ok_prefix
  ok_tier=(); ok_cat=(); ok_sz=(); ok_path=(); ok_prefix=()
  local -i rejected=0

  while IFS=$'\t' read -r tier cat sz prefix path; do
    case "$tier" in ''|'#'*) continue ;; esac
    [ "$tier" = safe ] || continue   # review tier is never auto-applied

    if ! reason=$(guard_path "$path" "$prefix"); then
      printf '  %sREJECT%s %-46s %s\n' "$C_RED" "$C_OFF" "$(short "$path")" "$reason"
      rejected=$(( rejected + 1 )); continue
    fi

    now=$(size_bytes "$path")
    local drift=0
    if [ "$sz" -gt 0 ]; then
      drift=$(awk -v a="$sz" -v b="$now" 'BEGIN{d=(b-a)/a*100; if(d<0)d=-d; printf "%d", d}')
    fi
    if [ "$drift" -gt "$SIZE_TOLERANCE_PCT" ]; then
      printf '  %sREJECT%s %-46s size changed %s%% since scan\n' \
        "$C_RED" "$C_OFF" "$(short "$path")" "$drift"
      rejected=$(( rejected + 1 )); continue
    fi

    ok_tier+=("$tier"); ok_cat+=("$cat"); ok_sz+=("$now")
    ok_path+=("$path"); ok_prefix+=("$prefix")
    printf '  %sOK%s     %-46s %s\n' "$C_GRN" "$C_OFF" "$(short "$path")" "$(human "$now")"
  done < "$plan"

  local n=${#ok_path[@]}
  [ "$n" -gt 0 ] || die "nothing left to act on — every candidate was rejected. Re-run 'scan'."
  [ "$rejected" -eq 0 ] || warn "$rejected item(s) rejected and will be left alone"

  # Group by category for confirmation.
  local -a cats; cats=()
  local i c seen
  for (( i=0; i<n; i++ )); do
    seen=0
    for c in ${cats[@]+"${cats[@]}"}; do [ "$c" = "${ok_cat[$i]}" ] && seen=1; done
    [ "$seen" -eq 0 ] && cats+=("${ok_cat[$i]}")
  done

  if [ "$dry" -eq 1 ]; then
    hdr "Dry run — stopping here. Nothing moved."
    exit 0
  fi

  # --- per-category confirmation ---
  local -a approved; approved=()
  hdr "Confirm each category. Type the category name exactly, or anything else to skip."
  for c in "${cats[@]}"; do
    local csize=0
    for (( i=0; i<n; i++ )); do
      [ "${ok_cat[$i]}" = "$c" ] && csize=$(( csize + ${ok_sz[$i]} ))
    done
    printf '\n  %s%s%s — %s across ' "$C_BLD" "$c" "$C_OFF" "$(human "$csize")"
    local cn=0
    for (( i=0; i<n; i++ )); do [ "${ok_cat[$i]}" = "$c" ] && cn=$(( cn + 1 )); done
    printf '%d item(s):\n' "$cn"
    for (( i=0; i<n; i++ )); do
      [ "${ok_cat[$i]}" = "$c" ] && printf '      %s\n' "$(short "${ok_path[$i]}")"
    done
    printf '  type "%s" to include > ' "$c"
    local answer; read -r answer </dev/tty
    if [ "$answer" = "$c" ]; then
      approved+=("$c"); printf '  %sincluded%s\n' "$C_GRN" "$C_OFF"
    else
      printf '  %sskipped%s\n' "$C_YEL" "$C_OFF"
    fi
  done

  [ "${#approved[@]}" -gt 0 ] || { info "Nothing approved. Exiting without changes."; exit 0; }

  local grand=0
  for (( i=0; i<n; i++ )); do
    for c in "${approved[@]}"; do
      [ "${ok_cat[$i]}" = "$c" ] && grand=$(( grand + ${ok_sz[$i]} ))
    done
  done
  local gb; gb=$(awk -v b="$grand" 'BEGIN{printf "%.1f", b/1073741824}')

  # --- final typed confirmation ---
  hdr "Final confirmation"
  info "About to MOVE $(human "$grand") into quarantine. Files are not destroyed —"
  info "they go to $QUARANTINE_ROOT and can be put back with '$SELF restore'."
  info ""
  info "${C_BLD}Note: moving within the same drive does not free space yet.${C_OFF}"
  info "Space is reclaimed by '$SELF purge', after you've confirmed nothing broke."
  printf '\nType exactly:  MOVE %s GB\n> ' "$gb"
  local final; read -r final </dev/tty
  [ "$final" = "MOVE $gb GB" ] || die "confirmation did not match. Nothing was changed."

  # --- execute ---
  local stamp qdir
  stamp=$(date +%Y%m%d-%H%M%S)
  qdir="$QUARANTINE_ROOT/$stamp"
  mkdir -p "$qdir" || die "cannot create quarantine folder"
  : > "$qdir/manifest.tsv"

  hdr "Moving"
  local moved=0 failed=0
  for (( i=0; i<n; i++ )); do
    local include=0
    for c in "${approved[@]}"; do [ "${ok_cat[$i]}" = "$c" ] && include=1; done
    [ "$include" -eq 1 ] || continue

    local src="${ok_path[$i]}"
    # Last-instant re-check. Between confirmation and now, things can change.
    if ! reason=$(guard_path "$src" "${ok_prefix[$i]}"); then
      printf '  %sSKIP%s  %-46s %s\n' "$C_YEL" "$C_OFF" "$(short "$src")" "$reason"
      failed=$(( failed + 1 )); continue
    fi

    local rel dest
    rel="${src#$HOME/}"
    dest="$qdir/$rel"
    mkdir -p "$(dirname "$dest")"
    if mv -- "$src" "$dest" 2>/dev/null; then
      printf '%s\t%s\t%s\n' "${ok_sz[$i]}" "$src" "$dest" >> "$qdir/manifest.tsv"
      printf '  %smoved%s %-46s %s\n' "$C_GRN" "$C_OFF" "$(short "$src")" "$(human "${ok_sz[$i]}")"
      moved=$(( moved + ${ok_sz[$i]} ))
    else
      printf '  %sFAIL%s  %s\n' "$C_RED" "$C_OFF" "$(short "$src")"
      failed=$(( failed + 1 ))
    fi
  done

  hdr "Quarantined"
  info "  $(human "$moved") moved to $qdir"
  [ "$failed" -eq 0 ] || warn "$failed item(s) could not be moved and were left in place"
  info ""
  info "Now use your Mac normally for a while. If anything misbehaves:"
  info "  ${C_BLD}$SELF restore${C_OFF}"
  info "When you're satisfied, reclaim the space:"
  info "  ${C_BLD}$SELF purge${C_OFF}"
}

# ---------------------------------------------------------------------------
# CHECK 3 — purge (the only destructive operation)
# ---------------------------------------------------------------------------
cmd_purge() {
  [ -d "$QUARANTINE_ROOT" ] || die "nothing in quarantine."
  local total=0 batch
  hdr "CHECK 3 of 3 — permanent deletion"
  info "Quarantine batches:"
  for batch in "$QUARANTINE_ROOT"/*; do
    [ -d "$batch" ] || continue
    local sz; sz=$(size_bytes "$batch")
    total=$(( total + sz ))
    printf '  %-24s %s\n' "$(basename "$batch")" "$(human "$sz")"
  done
  [ "$total" -gt 0 ] || die "quarantine is empty."

  local gb; gb=$(awk -v b="$total" 'BEGIN{printf "%.1f", b/1073741824}')
  info ""
  info "${C_RED}This permanently destroys $(human "$total"). It cannot be undone.${C_OFF}"
  info "Everything here was already reviewed and confirmed at the apply step."
  printf '\nType exactly:  DELETE %s GB PERMANENTLY\n> ' "$gb"
  local final; read -r final </dev/tty
  [ "$final" = "DELETE $gb GB PERMANENTLY" ] || die "confirmation did not match. Nothing deleted."

  # Guard the guard: never rm anything but our own quarantine root.
  case "$(abspath "$QUARANTINE_ROOT")" in
    "$HOME"/.mac-disk-cleanup-quarantine) : ;;
    *) die "quarantine path failed its own sanity check — refusing to delete" ;;
  esac

  local before after
  before=$(free_bytes)
  rm -rf -- "$QUARANTINE_ROOT"/*
  after=$(free_bytes)

  hdr "Done"
  printf '  free before  %s\n' "$(human "$before")"
  printf '  free after   %s\n' "$(human "$after")"
  printf '  reclaimed    %s\n' "$(human $(( after - before )))"
}

cmd_restore() {
  [ -d "$QUARANTINE_ROOT" ] || die "nothing in quarantine."
  hdr "Restoring everything from quarantine"
  local batch sz src dest restored=0
  for batch in "$QUARANTINE_ROOT"/*; do
    [ -d "$batch" ] && [ -f "$batch/manifest.tsv" ] || continue
    while IFS=$'\t' read -r sz src dest; do
      [ -e "$dest" ] || continue
      mkdir -p "$(dirname "$src")"
      if mv -- "$dest" "$src" 2>/dev/null; then
        printf '  %srestored%s %s\n' "$C_GRN" "$C_OFF" "$(short "$src")"
        restored=$(( restored + 1 ))
      else
        printf '  %sFAIL%s %s\n' "$C_RED" "$C_OFF" "$(short "$src")"
      fi
    done < "$batch/manifest.tsv"
  done
  info ""
  info "$restored item(s) restored."
}

# ---------------------------------------------------------------------------
# Time Machine local snapshots — separate, because it is irreversible
# ---------------------------------------------------------------------------
cmd_snapshots() {
  local reclaim_gb="" delete_all=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --reclaim) reclaim_gb="${2:-}"; shift 2 ;;
      --delete-all) delete_all=1; shift ;;
      *) die "unknown option: $1" ;;
    esac
  done

  hdr "Time Machine local snapshots"
  local list; list=$(tmutil listlocalsnapshots / 2>/dev/null | grep 'com.apple.TimeMachine')
  [ -n "$list" ] || { info "  none found — nothing to do."; exit 0; }
  printf '%s\n' "$list" | sed 's/^/  /'
  info ""
  info "These are on-disk copies of changed files, kept while your Time Machine"
  info "drive is disconnected. macOS thins them automatically under pressure, but"
  info "not aggressively enough on a nearly-full drive."
  info ""
  info "${C_RED}Deleting a snapshot is permanent. Any file you deleted since it was${C_OFF}"
  info "${C_RED}taken, and have no other backup of, becomes unrecoverable.${C_OFF}"

  if [ "$delete_all" -eq 1 ]; then
    info ""
    printf 'Type exactly:  DELETE ALL SNAPSHOTS\n> '
    local a; read -r a </dev/tty
    [ "$a" = "DELETE ALL SNAPSHOTS" ] || die "confirmation did not match."
    printf 'Confirm once more — type the hostname (%s)\n> ' "$(hostname -s)"
    local b; read -r b </dev/tty
    [ "$b" = "$(hostname -s)" ] || die "confirmation did not match."
    local before; before=$(free_bytes)
    tmutil deletelocalsnapshots / || die "tmutil failed"
    printf '\nreclaimed %s\n' "$(human $(( $(free_bytes) - before )))"
    return
  fi

  [ -n "$reclaim_gb" ] || {
    info ""
    info "Recommended, gentlest option — ask macOS to free a target amount and let"
    info "it choose the oldest snapshots itself:"
    info "  ${C_BLD}$SELF snapshots --reclaim 20${C_OFF}"
    info "Or, to remove every snapshot:"
    info "  ${C_BLD}$SELF snapshots --delete-all${C_OFF}"
    exit 0
  }

  local bytes; bytes=$(awk -v g="$reclaim_gb" 'BEGIN{printf "%d", g*1073741824}')
  info ""
  printf 'Type exactly:  THIN %s GB\n> ' "$reclaim_gb"
  local a; read -r a </dev/tty
  [ "$a" = "THIN $reclaim_gb GB" ] || die "confirmation did not match."

  local before; before=$(free_bytes)
  info "asking macOS to reclaim ${reclaim_gb}GB (urgency 4 = most aggressive)…"
  tmutil thinlocalsnapshots / "$bytes" 4
  printf '\nfree before %s\nfree after  %s\nreclaimed   %s\n' \
    "$(human "$before")" "$(human "$(free_bytes)")" "$(human $(( $(free_bytes) - before )))"
}

# ---------------------------------------------------------------------------
# Archive review-tier items to an external drive (for when the SSD arrives)
# ---------------------------------------------------------------------------
cmd_archive() {
  local plan="" dest=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --plan) plan="${2:-}"; shift 2 ;;
      --to) dest="${2:-}"; shift 2 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [ -n "$plan" ] && [ -f "$plan" ] || die "archive requires --plan <file>"
  [ -n "$dest" ] || die "archive requires --to /Volumes/YourDrive"
  [ -d "$dest" ] || die "destination not mounted: $dest"
  case "$(abspath "$dest")" in
    /Volumes/*) : ;;
    *) die "destination must be an external volume under /Volumes" ;;
  esac

  local root="$dest/mac-archive-$(hostname -s)-$(date +%Y%m%d)"
  mkdir -p "$root" || die "cannot write to $dest"

  hdr "Review-tier items to archive"
  local tier cat sz prefix path total=0
  local -a a_path a_sz; a_path=(); a_sz=()
  while IFS=$'\t' read -r tier cat sz prefix path; do
    case "$tier" in ''|'#'*) continue ;; esac
    [ "$tier" = review ] || continue
    [ -e "$path" ] || continue
    a_path+=("$path"); a_sz+=("$sz"); total=$(( total + sz ))
    printf '  %-52s %s\n' "$(short "$path")" "$(human "$sz")"
  done < "$plan"
  [ "${#a_path[@]}" -gt 0 ] || die "no review-tier items in this plan."

  local avail; avail=$(df -k "$dest" | awk 'NR==2{print $4*1024}')
  printf '\n  total to copy   %s\n  free on target  %s\n' "$(human "$total")" "$(human "$avail")"
  [ "$avail" -gt "$total" ] || die "not enough free space on $dest"

  printf '\nType exactly:  ARCHIVE\n> '
  local a; read -r a </dev/tty
  [ "$a" = "ARCHIVE" ] || die "confirmation did not match."

  local i failed=0
  for (( i=0; i<${#a_path[@]}; i++ )); do
    local src="${a_path[$i]}" rel target
    rel="${src#$HOME/}"; target="$root/$rel"
    mkdir -p "$(dirname "$target")"
    hdr "Copying ${src/#$HOME/~}"
    if ! rsync -a --info=progress2 -- "$src" "$(dirname "$target")/"; then
      warn "copy failed, leaving original in place"; failed=$(( failed + 1 )); continue
    fi
    info "verifying…"
    if rsync -an -i -- "$src" "$(dirname "$target")/" | grep -q '^[<>ch]'; then
      warn "verification found differences — leaving original in place"
      failed=$(( failed + 1 ))
    else
      info "${C_GRN}verified identical${C_OFF}"
    fi
  done

  hdr "Archive complete"
  info "  copied to $root"
  [ "$failed" -eq 0 ] || warn "$failed item(s) failed and were NOT verified"
  info ""
  info "Originals have NOT been removed. Once you have confirmed the archive opens"
  info "correctly — and ideally after it exists in a second place — delete the"
  info "originals through Finder, or add them to PROTECT_PATHS' opposite by running"
  info "a fresh scan with a lower review threshold."
}

# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
${C_BLD}mac-disk-cleanup.sh${C_OFF} — reversible disk cleanup with three-stage confirmation

  ${C_BLD}scan${C_OFF}                              read-only survey, writes a plan file
  ${C_BLD}apply --plan <file>${C_OFF}               re-validate, confirm, move to quarantine
        [--dry-run] [--allow-during-render]
  ${C_BLD}purge${C_OFF}                             permanently delete quarantine (frees space)
  ${C_BLD}restore${C_OFF}                           put everything back
  ${C_BLD}snapshots [--reclaim GB|--delete-all]${C_OFF}  Time Machine local snapshots
  ${C_BLD}archive --plan <f> --to /Volumes/X${C_OFF}   copy review-tier items to external drive

Edit PROTECT_PATHS at the top of this file before first use.
EOF
}

case "${1:-}" in
  scan)      shift; cmd_scan "$@" ;;
  apply)     shift; cmd_apply "$@" ;;
  purge)     shift; cmd_purge "$@" ;;
  restore)   shift; cmd_restore "$@" ;;
  snapshots) shift; cmd_snapshots "$@" ;;
  archive)   shift; cmd_archive "$@" ;;
  ""|-h|--help|help) usage ;;
  *) die "unknown command: $1 (try --help)" ;;
esac
