#!/usr/bin/env bash
set -uo pipefail

# Parse command line arguments
MODEL_LIMIT=""
START_INDEX=1
TIMEOUT_SECS=1800
COMMIT_PUSH=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --limit)
      MODEL_LIMIT="$2"
      shift 2
      ;;
    --limit=*)
      MODEL_LIMIT="${1#*=}"
      shift
      ;;
    --start-index)
      START_INDEX="$2"
      shift 2
      ;;
    --start-index=*)
      START_INDEX="${1#*=}"
      shift
      ;;
    --timeout)
      TIMEOUT_SECS="$2"
      shift 2
      ;;
    --timeout=*)
      TIMEOUT_SECS="${1#*=}"
      shift
      ;;
    --commitpush)
      COMMIT_PUSH=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--start-index N] [--limit N] [--timeout SECS] [--commitpush]"
      echo "  --start-index N  Start from model N (1-based, alphabetically sorted)"
      echo "  --limit N        Limit the number of models to benchmark"
      echo "  --timeout SECS   Max seconds per benchmark test (default: 1800)"
      echo "  --commitpush     Auto-commit and push results after completion"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Timestamp helper for console output
ts() {
  date '+[%Y-%m-%d %H:%M:%S]'
}

# Generate unique run ID: pid_timestamp (pid first so concurrent runs spread apart in sorted output)
RUN_ID="$$_$(date +%s)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_DIR="$SCRIPT_DIR/models"
RESULTDIR="$SCRIPT_DIR/results"
STATE_FILE="$SCRIPT_DIR/.benchmark_state"
mkdir -p "$RESULTDIR"

# Cleanup state file on exit
cleanup_state() {
  rm -f "$STATE_FILE"
}
trap cleanup_state EXIT INT TERM

# Check if models directory exists
if [[ ! -d "$MODEL_DIR" ]]; then
  echo "$(ts) Models directory not found: $MODEL_DIR"
  LLAMA_CACHE="$HOME/.cache/llama.cpp"
  if [[ -d "$LLAMA_CACHE" ]]; then
    echo ""
    echo "Found llama.cpp cache at $LLAMA_CACHE"
    echo "To use it, create a symlink:"
    echo ""
    echo "  ln -s $LLAMA_CACHE $MODEL_DIR"
    echo ""
  else
    echo "Create a 'models' directory and add .gguf files to benchmark."
  fi
  exit 1
fi

echo "$(ts) Starting benchmark run: ${RUN_ID}"

# Write initial state file
write_state() {
  cat > "$STATE_FILE" <<EOF
RUN_ID=$RUN_ID
PID=$$
START_TIME=$START_TIME
CURRENT_STEP=$CURRENT_STEP
TOTAL_STEPS=$TOTAL_STEPS
CURRENT_MODEL=$CURRENT_MODEL
CURRENT_ENV=$CURRENT_ENV
CURRENT_CONTEXT=$CURRENT_CONTEXT
CURRENT_CMD=$CURRENT_CMD
EOF
}

# Initialize state variables
CURRENT_MODEL=""
CURRENT_ENV=""
CURRENT_CONTEXT=""
CURRENT_CMD=""

# Capture system info (regenerate every run to capture kernel changes etc)
python3 -c '
import platform, json, datetime, subprocess, socket

def get_distro():
    try:
        with open("/etc/os-release") as f:
            for line in f:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip("\"")
    except:
        return "Linux"
    return "Linux"

def get_linux_firmware():
    try:
        result = subprocess.run(["rpm", "-q", "linux-firmware"], capture_output=True, text=True)
        if result.returncode == 0:
            return result.stdout.strip()
    except:
        pass
    return "unknown"

def get_kernel_cmdline():
    try:
        with open("/proc/cmdline") as f:
            return f.read().strip()
    except:
        return "unknown"

def get_sysctl_values():
    keys = [
        "vm.swappiness",
        "vm.dirty_ratio",
        "vm.dirty_background_ratio",
        "vm.dirty_writeback_centisecs",
        "kernel.sched_autogroup_enabled",
    ]
    values = {}
    for key in keys:
        try:
            result = subprocess.run(["sysctl", "-n", key], capture_output=True, text=True)
            if result.returncode == 0:
                values[key] = result.stdout.strip()
        except:
            pass
    return values

def get_repo_commit():
    try:
        result = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd="..")
        if result.returncode == 0:
            return result.stdout.strip()
    except:
        pass
    return "unknown"

info = {
    "distro": get_distro(),
    "hostname": socket.gethostname(),
    "kernel": platform.release(),
    "kernel_cmdline": get_kernel_cmdline(),
    "sysctl": get_sysctl_values(),
    "linux_firmware": get_linux_firmware(),
    "repo_commit": get_repo_commit(),
    "timestamp": datetime.datetime.now().strftime("%d %b %Y")
}
print(json.dumps(info))
' > "$RESULTDIR/system_info.json"
echo "$(ts) Captured system info to $RESULTDIR/system_info.json"

# Pick exactly one .gguf per model: either
#  - any .gguf without "-000*-of-" (single-file models)
#  - or the first shard "*-00001-of-*.gguf"
# Exclude multimodal projection files (*mmproj*) as they are not benchmarkable LLMs
mapfile -t MODEL_PATHS < <(
  find -L "$MODEL_DIR" -type f -name '*.gguf' \
    \( -name '*-00001-of-*.gguf' -o -not -name '*-000*-of-*.gguf' \) \
    -not -iname '*mmproj*' \
    | sort
)

if (( ${#MODEL_PATHS[@]} == 0 )); then
  echo "$(ts) ❌ No models found under $MODEL_DIR – check your paths/patterns!"
  echo "$(ts)    Tip: You can symlink your models cache, e.g.:"
  echo "$(ts)    ln -s ~/.cache/llama.cpp $MODEL_DIR"
  exit 1
fi

TOTAL_MODELS=${#MODEL_PATHS[@]}

# Apply start index if specified (1-based: --start-index 2 means start at 2nd model)
if (( START_INDEX > 1 )); then
  SKIP_COUNT=$((START_INDEX - 1))
  if (( SKIP_COUNT >= TOTAL_MODELS )); then
    echo "$(ts) ❌ Start index $START_INDEX exceeds total models ($TOTAL_MODELS)"
    exit 1
  fi
  echo "$(ts) Starting at model $START_INDEX (skipping first $SKIP_COUNT)"
  MODEL_PATHS=("${MODEL_PATHS[@]:$SKIP_COUNT}")
fi

# Apply model limit if specified
if [[ -n "$MODEL_LIMIT" ]] && (( MODEL_LIMIT > 0 )) && (( MODEL_LIMIT < ${#MODEL_PATHS[@]} )); then
  echo "$(ts) Limiting to $MODEL_LIMIT model(s) out of ${#MODEL_PATHS[@]} remaining"
  MODEL_PATHS=("${MODEL_PATHS[@]:0:$MODEL_LIMIT}")
fi

DISPLAY_END=$((START_INDEX + ${#MODEL_PATHS[@]} - 1))
echo "$(ts) Benchmarking ${#MODEL_PATHS[@]} model(s) (#$START_INDEX-$DISPLAY_END of $TOTAL_MODELS):"
for p in "${MODEL_PATHS[@]}"; do
  echo "  • $p"
done
echo

# Track benchmark results for commit summary
PASSED_COUNT=0
FAILED_COUNT=0
SKIPPED_COUNT=0
declare -A ENVS_USED=()
declare -A MODELS_TESTED=()

# Calculate total benchmark steps for progress indicator
# Each model runs: 4 ROCm envs × 2 hblt modes × 2 contexts + 2 Vulkan envs × 1 mode × 2 contexts = 20 steps
STEPS_PER_MODEL=$(( 4 * 2 * 2 + 2 * 1 * 2 ))
TOTAL_STEPS=$(( ${#MODEL_PATHS[@]} * STEPS_PER_MODEL ))
CURRENT_STEP=0
START_TIME=$(date +%s)

# Format seconds as HH:MM:SS
format_duration() {
  local secs=$1
  printf "%02d:%02d:%02d" $((secs/3600)) $((secs%3600/60)) $((secs%60))
}

# Show progress: (current/total) elapsed ETA
show_progress() {
  local now=$(date +%s)
  local elapsed=$((now - START_TIME))
  local elapsed_fmt=$(format_duration $elapsed)

  if (( CURRENT_STEP > 0 )); then
    local avg_per_step=$((elapsed / CURRENT_STEP))
    local remaining_steps=$((TOTAL_STEPS - CURRENT_STEP))
    local eta_secs=$((avg_per_step * remaining_steps))
    local eta_fmt=$(format_duration $eta_secs)
    printf "(%d/%d) elapsed %s ETA %s" "$CURRENT_STEP" "$TOTAL_STEPS" "$elapsed_fmt" "$eta_fmt"
  else
    printf "(%d/%d) elapsed %s" "$CURRENT_STEP" "$TOTAL_STEPS" "$elapsed_fmt"
  fi
}

declare -A CMDS=(
  [rocm6_4_4]="toolbox run -c llama-rocm-6.4.4 -- /usr/local/bin/llama-bench"
  [rocm7.1.1]="toolbox run -c llama-rocm-7.1.1 -- /usr/local/bin/llama-bench"
  [rocm-7.2]="toolbox run -c llama-rocm-7.2 -- /usr/local/bin/llama-bench"
  [rocm7-nightlies]="toolbox run -c llama-rocm7-nightlies -- /usr/local/bin/llama-bench"
  [vulkan_amdvlk]="toolbox run -c llama-vulkan-amdvlk -- /usr/sbin/llama-bench"
  [vulkan_radv]="toolbox run -c llama-vulkan-radv -- /usr/sbin/llama-bench"
)

# Track which toolboxes we've already tested this run
declare -A TOOLBOX_STATUS=()

# Test if toolbox works (cached per run)
ensure_toolbox_works() {
  local toolbox_name="$1"

  # Return cached result if already tested
  if [[ -n "${TOOLBOX_STATUS[$toolbox_name]:-}" ]]; then
    [[ "${TOOLBOX_STATUS[$toolbox_name]}" == "ok" ]]
    return $?
  fi

  # Test the toolbox with a simple command
  echo "$(ts) 🔍 Testing toolbox '$toolbox_name'..."
  if toolbox run -c "$toolbox_name" -- true 2>&1; then
    echo "$(ts) ✅ Toolbox '$toolbox_name' is ready"
    TOOLBOX_STATUS[$toolbox_name]="ok"
    return 0
  else
    echo "$(ts) ❌ Toolbox '$toolbox_name' failed - run './refresh-toolboxes.sh $toolbox_name' to fix"
    TOOLBOX_STATUS[$toolbox_name]="failed"
    return 1
  fi
}

get_hblt_modes() {
  local env="$1"
  if [[ "$env" == rocm* ]]; then
    printf '%s\n' default off
  else
    printf '%s\n' default
  fi
}

# Map ENV names to toolbox container names
declare -A TOOLBOX_NAMES=(
  [rocm6_4_4]="llama-rocm-6.4.4"
  [rocm7.1.1]="llama-rocm-7.1.1"
  [rocm-7.2]="llama-rocm-7.2"
  [rocm7-nightlies]="llama-rocm7-nightlies"
  [vulkan_amdvlk]="llama-vulkan-amdvlk"
  [vulkan_radv]="llama-vulkan-radv"
)

# Get toolbox container info (ID and creation time)
get_toolbox_info() {
  local toolbox_name="$1"
  local container_id created_at
  # Get the container ID from toolbox list
  container_id=$(podman ps -a --filter "name=${toolbox_name}" --format '{{.ID}}' 2>/dev/null | head -1)
  if [[ -n "$container_id" ]]; then
    created_at=$(podman inspect "$container_id" --format '{{.Created}}' 2>/dev/null || echo "unknown")
    echo "${container_id}:${created_at}"
  else
    echo "unknown:unknown"
  fi
}

# Get model fingerprint (partial hash + size + mtime)
get_model_fingerprint() {
  local file="$1"
  local size mtime hash
  size=$(stat -c%s "$file" 2>/dev/null || echo "0")
  mtime=$(stat -c%Y "$file" 2>/dev/null || echo "0")
  # Hash first 1MB + last 1MB for fast partial hash
  hash=$( (head -c 1048576 "$file" 2>/dev/null; tail -c 1048576 "$file" 2>/dev/null) | sha256sum | cut -d' ' -f1)
  echo "${hash}:${size}:${mtime}"
}

# Write benchmark metadata header to log file
write_benchmark_meta() {
  local out_file="$1"
  local toolbox_name="$2"
  local model_path="$3"
  local run_id="$4"

  local toolbox_info model_fingerprint container_id created_at
  toolbox_info=$(get_toolbox_info "$toolbox_name")
  container_id="${toolbox_info%%:*}"
  created_at="${toolbox_info#*:}"
  model_fingerprint=$(get_model_fingerprint "$model_path")

  {
    echo "# BENCHMARK_META: run_id=${run_id}"
    echo "# BENCHMARK_META: toolbox_name=${toolbox_name}"
    echo "# BENCHMARK_META: toolbox_id=${container_id}"
    echo "# BENCHMARK_META: toolbox_created=${created_at}"
    echo "# BENCHMARK_META: model_fingerprint=${model_fingerprint}"
    echo ""
  } > "$out_file"
}

for MODEL_PATH in "${MODEL_PATHS[@]}"; do
  MODEL_NAME="$(basename "$MODEL_PATH" .gguf)"

  for ENV in "${!CMDS[@]}"; do
    CMD="${CMDS[$ENV]}"
    mapfile -t HBLT_MODES < <(get_hblt_modes "$ENV")

    for MODE in "${HBLT_MODES[@]}"; do
      BASE_SUFFIX=""
      CMD_EFFECTIVE="$CMD"

      if [[ "$ENV" == rocm* ]]; then
        if [[ "$MODE" == off ]]; then
          BASE_SUFFIX="__hblt0"
          CMD_EFFECTIVE="${CMD_EFFECTIVE/-- /-- env ROCBLAS_USE_HIPBLASLT=0 }"
        else
          CMD_EFFECTIVE="${CMD_EFFECTIVE/-- /-- env ROCBLAS_USE_HIPBLASLT=1 }"
        fi
      fi

      # run twice: baseline and with flash attention
      for FA in 1; do
        SUFFIX="$BASE_SUFFIX"
        EXTRA_ARGS=()
        if (( FA == 1 )); then
          SUFFIX="${SUFFIX}__fa1"
          EXTRA_ARGS=( -fa 1 )
        fi

        for CTX in default longctx32768; do
          CTX_SUFFIX=""
          CTX_ARGS=()
          if [[ "$CTX" == longctx32768 ]]; then
            CTX_SUFFIX="__longctx32768"
            CTX_ARGS=( -p 2048 -n 32 -d 32768 )
            if [[ "$ENV" == *vulkan* ]]; then
              CTX_ARGS+=( -ub 512 )
            else
              CTX_ARGS+=( -ub 2048 )
            fi
          fi

          OUT="$RESULTDIR/${MODEL_NAME}__${ENV}${SUFFIX}${CTX_SUFFIX}__${RUN_ID}.log"
          CTX_REPS=5
          if [[ "$CTX" == longctx32768 ]]; then
            CTX_REPS=3
          fi

          ((CURRENT_STEP++)) || true

          if [[ -s "$OUT" ]]; then
            echo "$(ts) ⏩ $(show_progress) Skipping [${ENV}] ${MODEL_NAME}${SUFFIX}${CTX_SUFFIX:+ ($CTX_SUFFIX)}, log exists"
            ((SKIPPED_COUNT++)) || true
            continue
          fi

          FULL_CMD=( $CMD_EFFECTIVE -ngl 99 -mmp 0 -m "$MODEL_PATH" "${EXTRA_ARGS[@]}" "${CTX_ARGS[@]}" -r "$CTX_REPS" )

          # Ensure toolbox works before running
          TOOLBOX_NAME="${TOOLBOX_NAMES[$ENV]}"
          if ! ensure_toolbox_works "$TOOLBOX_NAME"; then
            echo "$(ts) ⏩ $(show_progress) Skipping [${ENV}] ${MODEL_NAME}${SUFFIX}${CTX_SUFFIX:+ ($CTX_SUFFIX)}, toolbox unavailable"
            ((SKIPPED_COUNT++)) || true
            continue
          fi

          printf "\n%s ▶ $(show_progress) [%s] %s%s%s\n" "$(ts)" "$ENV" "$MODEL_NAME" "${SUFFIX:+ $SUFFIX}" "${CTX_SUFFIX:+ $CTX_SUFFIX}"
          printf "  → log: %s\n" "$OUT"
          printf "  → cmd: %s\n\n" "${FULL_CMD[*]}"

          # Update state file for monitoring
          CURRENT_MODEL="$MODEL_NAME"
          CURRENT_ENV="$ENV"
          CURRENT_CONTEXT="$CTX"
          CURRENT_CMD="${FULL_CMD[*]}"
          write_state

          # Write metadata header
          write_benchmark_meta "$OUT" "$TOOLBOX_NAME" "$MODEL_PATH" "$RUN_ID"

          timeout "$TIMEOUT_SECS" "${FULL_CMD[@]}" </dev/null >>"$OUT" 2>&1
          status=$?

          # Check for timeout (exit code 124)
          timed_out=false
          if (( status == 124 )); then
            timed_out=true
          fi

          # Check if benchmark produced valid results (look for the results table)
          has_results=false
          if grep -q "^|.*model.*|" "$OUT" 2>/dev/null && grep -q "t/s" "$OUT" 2>/dev/null; then
            has_results=true
          fi

          if (( status != 0 )) || [[ "$has_results" == "false" ]]; then
            # Extract error reason from log
            error_reason=""
            if [[ "$timed_out" == "true" ]]; then
              error_reason="timeout after ${TIMEOUT_SECS}s"
            elif grep -qi "failed to load model" "$OUT" 2>/dev/null; then
              error_reason="failed to load model"
            elif grep -qi "not a valid gguf file" "$OUT" 2>/dev/null; then
              error_reason="not a valid GGUF file"
            elif grep -qi "device memory allocation failed" "$OUT" 2>/dev/null; then
              error_reason="out of memory"
            elif grep -qi "GPU hang\|HW Exception" "$OUT" 2>/dev/null; then
              error_reason="GPU hang/exception"
            elif grep -qi "error:" "$OUT" 2>/dev/null; then
              error_reason=$(grep -i "error:" "$OUT" | head -1 | sed 's/.*error: *//' | cut -c1-60)
            elif [[ "$has_results" == "false" ]]; then
              error_reason="no benchmark results produced"
            fi

            echo "✖ FAILED (exit ${status}): ${error_reason:-unknown error}" >>"$OUT"
            echo "$(ts)   ✖ [${ENV}] ${MODEL_NAME}${SUFFIX}${CTX_SUFFIX:+ $CTX_SUFFIX} : FAILED (exit ${status})"
            if [[ -n "$error_reason" ]]; then
              echo "        → Reason: ${error_reason}"
            else
              # Show last non-empty line from log as hint
              last_line=$(grep -v '^$' "$OUT" | tail -1 | cut -c1-80)
              [[ -n "$last_line" ]] && echo "        → Last output: ${last_line}"
            fi
            ((FAILED_COUNT++)) || true
          else
            echo "$(ts)   ✔ [${ENV}] ${MODEL_NAME}${SUFFIX}${CTX_SUFFIX:+ $CTX_SUFFIX} : DONE"
            ((PASSED_COUNT++)) || true
            ENVS_USED[$ENV]=1
            MODELS_TESTED[$MODEL_NAME]=1
          fi
        done
      done
    done
  done
done

# Generate results JSON files
echo ""
echo "$(ts) Generating results JSON files..."

if [[ -f "$SCRIPT_DIR/generate_results_json.py" ]]; then
  echo "$(ts) Running generate_results_json.py..."
  python3 "$SCRIPT_DIR/generate_results_json.py" && echo "$(ts) ✅ results.json updated" || echo "$(ts) ❌ generate_results_json.py failed"
fi

if [[ -f "$SCRIPT_DIR/generate_results_json_new.py" ]]; then
  echo "$(ts) Running generate_results_json_new.py..."
  python3 "$SCRIPT_DIR/generate_results_json_new.py" && echo "$(ts) ✅ results_new.json updated" || echo "$(ts) ❌ generate_results_json_new.py failed"
fi

# Summary
TOTAL_EXECUTED=$((PASSED_COUNT + FAILED_COUNT))
echo ""
echo "$(ts) ═══════════════════════════════════════════════════════════════"
echo "$(ts) Benchmark run ${RUN_ID} complete."
echo "$(ts)   Passed:  ${PASSED_COUNT}"
echo "$(ts)   Failed:  ${FAILED_COUNT}"
echo "$(ts)   Skipped: ${SKIPPED_COUNT}"
if (( ${#MODELS_TESTED[@]} > 0 )); then
  echo "$(ts)   Models:  ${#MODELS_TESTED[@]} (${!MODELS_TESTED[*]::3}...)" | cut -c1-100
fi
if (( ${#ENVS_USED[@]} > 0 )); then
  echo "$(ts)   Envs:    ${!ENVS_USED[*]}"
fi
echo "$(ts) ═══════════════════════════════════════════════════════════════"

# Commit and push if requested
if [[ "$COMMIT_PUSH" == "true" ]]; then
  echo ""
  echo "$(ts) --commitpush requested, checking results..."

  if (( PASSED_COUNT == 0 )); then
    echo "$(ts) ❌ All experiments failed (${FAILED_COUNT} failures). Skipping commit."
    exit 1
  fi

  # Build commit message
  MODEL_COUNT=${#MODELS_TESTED[@]}
  ENV_LIST="${!ENVS_USED[*]}"

  # Create a concise commit message
  COMMIT_MSG="Benchmark: ${PASSED_COUNT} passed, ${FAILED_COUNT} failed"
  if (( MODEL_COUNT > 0 )); then
    COMMIT_MSG="${COMMIT_MSG} (${MODEL_COUNT} models)"
  fi

  COMMIT_BODY="Run ID: ${RUN_ID}
Environments: ${ENV_LIST:-none}
Models tested: ${MODEL_COUNT}
Results: ${PASSED_COUNT} passed, ${FAILED_COUNT} failed, ${SKIPPED_COUNT} skipped"

  # Change to repo root for git operations
  cd "$SCRIPT_DIR/.."

  echo "$(ts) Staging result files..."
  git add docs/results_new.jsonl.js docs/results.json benchmark/results/ 2>/dev/null || true

  # Check if there are changes to commit
  if git diff --cached --quiet; then
    echo "$(ts) No changes to commit."
  else
    echo "$(ts) Committing..."
    git commit -m "$(cat <<EOF
${COMMIT_MSG}

${COMMIT_BODY}
EOF
)"

    echo "$(ts) Pushing to remote..."
    if git push; then
      echo "$(ts) ✅ Results committed and pushed successfully."
    else
      echo "$(ts) ❌ Push failed. You may need to pull first and resolve conflicts."
      exit 1
    fi
  fi
fi
