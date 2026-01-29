#!/usr/bin/env bash
#
# is_benchmark_running.sh - Check if a benchmark is currently running
#
# Exit codes:
#   0 - Benchmark is running
#   1 - No benchmark is running
#
# Usage:
#   ./is_benchmark_running.sh           # Full status output
#   ./is_benchmark_running.sh --quiet   # Only set exit code, no output
#   ./is_benchmark_running.sh --json    # Output status as JSON
#
# This script reads the state file written by run_benchmarks.sh to determine
# the current benchmark status. It's useful for automation scripts that need
# to wait for benchmarks to complete before rebooting or switching kernels.
#

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.benchmark_state"

QUIET=false
JSON_OUTPUT=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -q|--quiet)
      QUIET=true
      shift
      ;;
    -j|--json)
      JSON_OUTPUT=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--quiet|-q] [--json|-j]"
      echo ""
      echo "Check if a benchmark is currently running."
      echo ""
      echo "Options:"
      echo "  --quiet, -q   Only set exit code, no output"
      echo "  --json, -j    Output status as JSON"
      echo ""
      echo "Exit codes:"
      echo "  0 - Benchmark is running"
      echo "  1 - No benchmark is running"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

# Format seconds as HH:MM:SS
format_duration() {
  local secs=$1
  printf "%02d:%02d:%02d" $((secs/3600)) $((secs%3600/60)) $((secs%60))
}

# Get CPU load (1-minute average)
get_cpu_load() {
  cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo "N/A"
}

# Get RAM usage
get_ram_usage() {
  if command -v free &>/dev/null; then
    free -h | awk '/^Mem:/ {printf "%s / %s (%.0f%%)", $3, $2, ($3/$2)*100}'
  else
    echo "N/A"
  fi
}

# Get GPU usage (AMD ROCm)
get_gpu_usage() {
  local gpu_info=""

  # Try rocm-smi first
  if command -v rocm-smi &>/dev/null; then
    local gpu_util vram_used vram_total
    gpu_util=$(rocm-smi --showuse 2>/dev/null | grep -oP 'GPU use \(%\):\s*\K\d+' | head -1)
    vram_used=$(rocm-smi --showmeminfo vram 2>/dev/null | grep -oP 'VRAM Total Used Memory \(B\):\s*\K\d+' | head -1)
    vram_total=$(rocm-smi --showmeminfo vram 2>/dev/null | grep -oP 'VRAM Total Memory \(B\):\s*\K\d+' | head -1)

    if [[ -n "$gpu_util" ]]; then
      gpu_info="GPU: ${gpu_util}%"
      if [[ -n "$vram_used" && -n "$vram_total" ]]; then
        local vram_used_gib vram_total_gib
        vram_used_gib=$(awk "BEGIN {printf \"%.1f\", $vram_used/1073741824}")
        vram_total_gib=$(awk "BEGIN {printf \"%.1f\", $vram_total/1073741824}")
        gpu_info="${gpu_info}, VRAM: ${vram_used_gib}/${vram_total_gib} GiB"
      fi
      echo "$gpu_info"
      return
    fi
  fi

  # Try amdgpu_top if available
  if command -v amdgpu_top &>/dev/null; then
    amdgpu_top -d 2>/dev/null | head -5 | grep -E 'GFX|VRAM' | tr '\n' ' ' && echo
    return
  fi

  # Fallback: check /sys for basic info
  if [[ -d /sys/class/drm/card0/device ]]; then
    local busy_percent=""
    if [[ -f /sys/class/drm/card0/device/gpu_busy_percent ]]; then
      busy_percent=$(cat /sys/class/drm/card0/device/gpu_busy_percent 2>/dev/null)
      echo "GPU busy: ${busy_percent}%"
      return
    fi
  fi

  echo "N/A (install rocm-smi for GPU stats)"
}

# Check if state file exists
if [[ ! -f "$STATE_FILE" ]]; then
  if [[ "$QUIET" == "true" ]]; then
    exit 1
  elif [[ "$JSON_OUTPUT" == "true" ]]; then
    echo '{"running":false,"reason":"no state file"}'
    exit 1
  else
    echo "No benchmark is running (no state file found)"
    exit 1
  fi
fi

# Read state file
source "$STATE_FILE" 2>/dev/null || {
  if [[ "$QUIET" == "true" ]]; then
    exit 1
  elif [[ "$JSON_OUTPUT" == "true" ]]; then
    echo '{"running":false,"reason":"invalid state file"}'
    exit 1
  else
    echo "No benchmark is running (invalid state file)"
    exit 1
  fi
}

# Check if the process is still running
if ! kill -0 "$PID" 2>/dev/null; then
  # Process not running, clean up stale state file
  rm -f "$STATE_FILE"

  if [[ "$QUIET" == "true" ]]; then
    exit 1
  elif [[ "$JSON_OUTPUT" == "true" ]]; then
    echo '{"running":false,"reason":"process terminated"}'
    exit 1
  else
    echo "No benchmark is running (process $PID terminated)"
    exit 1
  fi
fi

# Benchmark is running - gather status info
NOW=$(date +%s)
ELAPSED=$((NOW - START_TIME))
ELAPSED_FMT=$(format_duration $ELAPSED)

ETA_SECS=0
ETA_FMT="calculating..."
if (( CURRENT_STEP > 0 )); then
  AVG_PER_STEP=$((ELAPSED / CURRENT_STEP))
  REMAINING_STEPS=$((TOTAL_STEPS - CURRENT_STEP))
  ETA_SECS=$((AVG_PER_STEP * REMAINING_STEPS))
  ETA_FMT=$(format_duration $ETA_SECS)
fi

PROGRESS_PCT=0
if (( TOTAL_STEPS > 0 )); then
  PROGRESS_PCT=$((CURRENT_STEP * 100 / TOTAL_STEPS))
fi

CPU_LOAD=$(get_cpu_load)
RAM_USAGE=$(get_ram_usage)
GPU_USAGE=$(get_gpu_usage)

if [[ "$QUIET" == "true" ]]; then
  exit 0
fi

if [[ "$JSON_OUTPUT" == "true" ]]; then
  cat <<EOF
{
  "running": true,
  "run_id": "$RUN_ID",
  "pid": $PID,
  "current_step": $CURRENT_STEP,
  "total_steps": $TOTAL_STEPS,
  "progress_percent": $PROGRESS_PCT,
  "elapsed_seconds": $ELAPSED,
  "elapsed_formatted": "$ELAPSED_FMT",
  "eta_seconds": $ETA_SECS,
  "eta_formatted": "$ETA_FMT",
  "current_model": "$CURRENT_MODEL",
  "current_env": "$CURRENT_ENV",
  "current_context": "$CURRENT_CONTEXT",
  "cpu_load": "$CPU_LOAD",
  "ram_usage": "$RAM_USAGE",
  "gpu_usage": "$GPU_USAGE"
}
EOF
  exit 0
fi

# Human-readable output
echo "═══════════════════════════════════════════════════════════════════════"
echo " BENCHMARK RUNNING"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
echo " Run ID:     $RUN_ID"
echo " PID:        $PID"
echo ""
echo " Progress:   $CURRENT_STEP / $TOTAL_STEPS ($PROGRESS_PCT%)"
echo " Elapsed:    $ELAPSED_FMT"
echo " ETA:        $ETA_FMT"
echo ""
echo " Current experiment:"
echo "   Model:    $CURRENT_MODEL"
echo "   Env:      $CURRENT_ENV"
echo "   Context:  $CURRENT_CONTEXT"
echo ""
echo " System resources:"
echo "   CPU load: $CPU_LOAD"
echo "   RAM:      $RAM_USAGE"
echo "   GPU:      $GPU_USAGE"
echo ""
echo "═══════════════════════════════════════════════════════════════════════"

exit 0
