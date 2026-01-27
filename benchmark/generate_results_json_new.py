#!/usr/bin/env python3
"""
Generate results_new.json with multi-run support.

This script extends the original generate_results_json.py to:
- Support multiple benchmark runs stored in a single JSON file
- Use run_id (timestamp_pid) for unique identification
- Parse BENCHMARK_META comments for toolbox and model info
- Output key-sorted JSON for git-friendly merging
"""
import re, glob, os, json, time, argparse
from pathlib import Path
from datetime import datetime, timezone

RESULT_SOURCES = [
    ("results", False),       # regular single-node runs
    ("results-rpc", True),    # distributed RPC runs across two servers
]
OUT_JSON = "../docs/results_new.json"

# --- Regexes ---------------------------------------------------------------

# Table headers come in two shapes (with or without "fa" column)
HEADER_RE = re.compile(r"^\|\s*model\s*\|", re.IGNORECASE)
SEP_RE    = re.compile(r"^\|\s*-+")

# Build line, e.g. "build: cd6983d5 (6119)"
BUILD_RE  = re.compile(r"build:\s*([0-9a-f]{7,})\s*\((\d+)\)", re.IGNORECASE)

# Error classifiers (same spirit as your table script)
LOAD_ERR   = re.compile(r"failed to load model|Device memory allocation.*failed|⚠️\s*Fail", re.IGNORECASE)
HANG_ERR   = re.compile(r"GPU Hang|HW Exception", re.IGNORECASE)
GENERIC_ERR= re.compile(r"error:|exit \d+|runtime error|⚠️\s*Runtime Error", re.IGNORECASE)

# Extract numeric ± numeric from the last column
TS_RE      = re.compile(r"([\d.]+)\s*±\s*([\d.]+)")

# Quantization from model name
QUANT_RE = re.compile(r"(Q\d+_[A-Z0-9_]+|BF16|F16|F32|mxfp\d+)", re.IGNORECASE)

PARAMS_RE = re.compile(r"([\d.,]+)\s*B", re.IGNORECASE)
GIB_RE    = re.compile(r"([\d.,]+)\s*GiB", re.IGNORECASE)

# "30B", "235B" from model name
NAME_B_RE = re.compile(r"(\d+(?:\.\d+)?)B")

# Shard suffix in filenames
SHARD_RE = re.compile(r"-000\d+-of-000\d+", re.IGNORECASE)

# Long-context suffix in filenames (e.g., __longctx32768)
LONGCTX_RE = re.compile(r"longctx(\d+)", re.IGNORECASE)

# BENCHMARK_META comment pattern
META_RE = re.compile(r"^#\s*BENCHMARK_META:\s*(\w+)=(.+)$", re.MULTILINE)

# --- Helpers ---------------------------------------------------------------

ENV_CANON = {
    "rocm7_1_1": "rocm7.1.1",
    "rocm7_alpha": "rocm7-nightlies",
    "rocm-7alpha": "rocm7-nightlies",
}

def clean_model_name(raw):
    base = SHARD_RE.sub("", raw)
    return base

def canonicalize_env(env):
    if not env:
        return env
    for raw, canon in ENV_CANON.items():
        prefix = f"{raw}-"
        if env == raw:
            return canon
        if env.startswith(prefix):
            return canon + env[len(raw):]
    return env

def parse_env_flags(basename):
    """
    pattern: <model>__<env>[__fa1][__hblt0][__longctx32768][__rpc]
    Returns (env, fa, context_tag, context_tokens, rpc_flag)
    """
    parts = basename.split("__")
    if len(parts) < 2:
        return None, False, "default", None, False

    env = parts[1]
    fa = False
    context_tag = "default"
    context_tokens = None
    rpc_flag = False

    for raw_suffix in parts[2:]:
        suffix = raw_suffix.lower()
        if suffix == "fa1":
            fa = True
        elif suffix == "hblt0":
            env = f"{env}-hblt0"
        elif suffix.startswith("longctx"):
            context_tag = suffix
            m = LONGCTX_RE.search(suffix)
            if m:
                try:
                    context_tokens = int(m.group(1))
                except ValueError:
                    context_tokens = None
        elif suffix == "rpc":
            rpc_flag = True

    return env, fa, context_tag, context_tokens, rpc_flag

def env_base_and_variant(env):
    # e.g. "rocm6_4_2-rocwmma" -> ("rocm6_4_2", "rocwmma")
    if "-" in env:
        base, variant = env.split("-", 1)
        return base, variant
    return env, None

def detect_error(text):
    if LOAD_ERR.search(text):
        return True, "load"
    if HANG_ERR.search(text):
        return True, "hang"
    if GENERIC_ERR.search(text):
        return True, "runtime"
    return False, None

def parse_table(text):
    """
    Returns list of rows parsed from the markdown-like table.
    Each row is a dict of the parsed columns, normalized by header names.
    Handles presence/absence of the 'fa' column.
    """
    lines = text.splitlines()
    rows = []
    header = None
    col_idx = {}

    for i, line in enumerate(lines):
        if HEADER_RE.search(line):
            # header line
            header = [c.strip().lower() for c in line.strip().strip("|").split("|")]
            # next line should be the separator; skip it
            # build index map
            for idx, name in enumerate(header):
                col_idx[name] = idx
            continue
        if header and (SEP_RE.search(line) or not line.strip()):
            # skip separators / blanks after header
            continue
        if header and line.startswith("|"):
            parts = [c.strip() for c in line.strip().strip("|").split("|")]
            # guard for short lines
            if len(parts) < len(header):
                continue
            row = {}
            for name, idx in col_idx.items():
                row[name] = parts[idx]
            rows.append(row)
        # stop parsing block when a blank line after some rows appears
        if header and line.strip() == "" and rows:
            break

    return rows

def parse_benchmark_meta(text):
    """
    Parse BENCHMARK_META comments from log file.
    Returns dict with toolbox_name, toolbox_id, toolbox_created, model_fingerprint.
    """
    meta = {}
    for match in META_RE.finditer(text):
        key, value = match.group(1), match.group(2).strip()
        meta[key] = value
    return meta

def parse_model_fingerprint(fingerprint_str):
    """
    Parse model fingerprint string "hash:size:mtime" into dict.
    """
    if not fingerprint_str or fingerprint_str == "unknown":
        return None
    parts = fingerprint_str.split(":")
    if len(parts) != 3:
        return None
    try:
        return {
            "partial_hash": parts[0],
            "size_bytes": int(parts[1]),
            "mtime_unix": int(parts[2]),
            "mtime_iso": datetime.fromtimestamp(int(parts[2]), timezone.utc).isoformat().replace("+00:00", "Z")
        }
    except (ValueError, OSError):
        return None

def coerce_float(m, default=None):
    try:
        return float(m)
    except:
        return default

def extract_quant(model_name):
    m = QUANT_RE.search(model_name)
    return (m.group(1).upper() if m else None)

def b_from_name(model_name):
    m = NAME_B_RE.search(model_name)
    return coerce_float(m.group(1)) if m else None

def sort_dict_recursive(obj):
    """Recursively sort dictionary keys for consistent JSON output."""
    if isinstance(obj, dict):
        return {k: sort_dict_recursive(v) for k, v in sorted(obj.items())}
    elif isinstance(obj, list):
        return [sort_dict_recursive(item) for item in obj]
    return obj

def generate_run_id():
    """Generate unique run ID: pid_timestamp (pid first so concurrent runs spread apart)."""
    return f"{os.getpid()}_{int(time.time())}"

def extract_run_id_from_filename(basename):
    """
    Extract run_id from filename pattern: model__env__flags__RUN_ID
    Run ID format: pid_timestamp (e.g., 12345_1706284800)
    """
    parts = basename.split("__")
    if len(parts) >= 2:
        # Last part might be the run_id
        last_part = parts[-1]
        # Check if it matches run_id pattern (digits_digits)
        if re.match(r"^\d+_\d+$", last_part):
            return last_part
    return None

# --- Main scan -------------------------------------------------------------

def scan_results():
    """Scan result logs and return dict of runs grouped by run_id."""
    runs = {}  # run_id -> {"benchmarks": [], "builds": set(), "envs": set()}

    for results_dir, is_rpc_source in RESULT_SOURCES:
        glob_pattern = os.path.join(results_dir, "*.log")
        for path in sorted(glob.glob(glob_pattern)):
            base = os.path.basename(path).rsplit(".log", 1)[0]
            if "__" not in base:
                continue

            with open(path, errors="ignore") as f:
                text = f.read()

            # Parse BENCHMARK_META comments - run_id is now stored here
            bench_meta = parse_benchmark_meta(text)

            # Get run_id from metadata first, then try filename, then generate one
            run_id = bench_meta.get("run_id")
            if not run_id:
                run_id = extract_run_id_from_filename(base)
            if not run_id:
                run_id = "unknown_run"

            # Initialize run entry if needed
            if run_id not in runs:
                runs[run_id] = {"benchmarks": [], "builds": set(), "envs": set()}

            model_raw, _rest = base.split("__", 1)
            env, fa_from_name, context_tag, context_tokens, rpc_flag = parse_env_flags(base)
            env = canonicalize_env(env)
            if env:
                runs[run_id]["envs"].add(env)

            model_clean = clean_model_name(model_raw)
            model_id = parse_model_fingerprint(bench_meta.get("model_fingerprint"))

            # Toolbox info
            toolbox_info = None
            if bench_meta.get("toolbox_name"):
                toolbox_info = {
                    "name": bench_meta.get("toolbox_name"),
                    "container_id": bench_meta.get("toolbox_id"),
                    "created_iso": bench_meta.get("toolbox_created"),
                }

            # build info (take the last match in file if many)
            build_hash, build_num = None, None
            for m in BUILD_RE.finditer(text):
                build_hash, build_num = m.group(1), m.group(2)
            if build_hash:
                runs[run_id]["builds"].add((build_hash, build_num))
                if toolbox_info:
                    toolbox_info["llamacpp_build"] = {"hash": build_hash, "number": build_num}

            # detect error (if there is no valid table rows)
            table_rows = parse_table(text)

            # If table rows exist, we'll still mark errors only if no perf found
            has_pp = any(r.get("test","").lower()=="pp512" for r in table_rows)
            has_tg = any(r.get("test","").lower()=="tg128" for r in table_rows)
            error, etype = (False, None)
            if not (has_pp or has_tg):
                error, etype = detect_error(text)

            # Determine FA flag:
            #   prefer explicit column "fa" if present, else fallback to filename "__fa1"
            fa_in_table = None
            for r in table_rows:
                if "fa" in r:
                    try:
                        fa_in_table = int(r["fa"]) == 1
                    except:
                        fa_in_table = None
                    break
            fa_enabled = fa_in_table if fa_in_table is not None else fa_from_name

            # Normalize env base / variant (e.g., rocwmma)
            env_base, env_variant = env_base_and_variant(env)

            # Emit one run per row (pp512 / tg128)
            for r in table_rows or [{}]:
                test = r.get("test", "").lower() if table_rows else None
                tps_mean, tps_std = None, None
                if table_rows:
                    ts_field = r.get("t/s", "")
                    m = TS_RE.search(ts_field)
                    if m:
                        tps_mean = coerce_float(m.group(1))
                        tps_std  = coerce_float(m.group(2))

                # parse numeric helpers from row (if present)
                params_b = None
                file_size_gib = None
                if "params" in r:
                    pm = PARAMS_RE.search(r["params"])
                    if pm:
                        params_b = coerce_float(pm.group(1).replace(",", ""))
                if "size" in r:
                    sm = GIB_RE.search(r["size"])
                    if sm:
                        file_size_gib = coerce_float(sm.group(1).replace(",", ""))

                # quant from model name (unchanged)
                quant = extract_quant(model_clean)

                # name_params_b: prefer table value; else fall back to B in model name
                name_params_b = params_b if params_b is not None else b_from_name(model_clean)

                benchmark = {
                    "model": model_raw,
                    "model_clean": model_clean,
                    "env": env,
                    "env_base": env_base,
                    "env_variant": env_variant,
                    "fa": bool(fa_enabled),
                    "context": context_tag or "default",
                    "context_tokens": context_tokens,
                    "test": test,
                    "tps_mean": tps_mean,
                    "tps_std": tps_std,
                    "error": bool(error),
                    "error_type": etype,
                    "params_b": params_b,
                    "file_size_gib": file_size_gib,
                    "name_params_b": name_params_b,
                    "quant": quant,
                    "rpc": bool(is_rpc_source or rpc_flag),
                }

                # Add optional fields only if present
                if model_id:
                    benchmark["model_id"] = model_id
                if toolbox_info:
                    benchmark["toolbox"] = toolbox_info

                runs[run_id]["benchmarks"].append(benchmark)

    # Read system_info.json
    sys_info = {}
    if RESULT_SOURCES:
        si_path = os.path.join(RESULT_SOURCES[0][0], "system_info.json")
        if os.path.exists(si_path):
            try:
                with open(si_path) as f:
                    sys_info = json.load(f)
            except:
                pass

    return runs, sys_info


def main():
    parser = argparse.ArgumentParser(description="Generate results_new.json with multi-run support")
    parser.add_argument("--output", "-o", default=OUT_JSON, help=f"Output JSON file (default: {OUT_JSON})")
    args = parser.parse_args()

    out_path = Path(args.output)

    # Scan current results - groups benchmarks by run_id found in logs
    runs_from_logs, sys_info = scan_results()

    # Load existing file to merge with
    if out_path.exists():
        try:
            with open(out_path) as f:
                data = json.load(f)
            if "runs" not in data:
                data = {"schema_version": "1.0", "runs": {}}
        except (json.JSONDecodeError, IOError):
            data = {"schema_version": "1.0", "runs": {}}
    else:
        data = {"schema_version": "1.0", "runs": {}}

    # Merge each run from logs into the data
    new_runs = 0
    total_benchmarks = 0
    for run_id, run_data in runs_from_logs.items():
        benchmarks = run_data["benchmarks"]
        builds = run_data["builds"]
        envs = run_data["envs"]

        if not benchmarks:
            continue  # Skip empty runs

        total_benchmarks += len(benchmarks)

        # Create run entry
        run_entry = {
            "system_info": sys_info,
            "benchmarks": benchmarks,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "llamacpp_builds": [{"hash": h, "number": n} for (h, n) in sorted(builds)],
            "environments": sorted(envs),
        }

        # Add/update run (always merge, never overwrite entire file)
        if run_id not in data["runs"]:
            new_runs += 1
        data["runs"][run_id] = run_entry

    # Sort all keys recursively for git-friendly output
    data = sort_dict_recursive(data)

    # Write output
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    print(f"Wrote {out_path}")
    print(f"  New runs added: {new_runs}")
    print(f"  Total benchmarks processed: {total_benchmarks}")
    print(f"  Total runs in file: {len(data['runs'])}")


if __name__ == "__main__":
    main()
