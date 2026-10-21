"""
perf_baseline.py - STADVDB MCO1 performance testing helper.

Runs the OLAP reports from your OLAP script several times, logs the execution times, and saves the
EXPLAIN / EXPLAIN ANALYZE output of every report. Run it once as 'baseline', change the database
(indexes) or the SQL, then run it again with another label (for example 'indexed') and compare.

Does not change your OLAP script. It imports REPORTS, connect() and the other helpers from it.

Examples (run from the folder that holds your OLAP script):
  python perf_baseline.py --module olap_reports --label baseline
  python perf_baseline.py --module olap_reports --label baseline --report R1 R5 --runs 5
  python perf_baseline.py --module olap_reports --label indexed
  python perf_baseline.py --compare baseline indexed
"""
import sys

sys.dont_write_bytecode = True

import argparse
import csv
import datetime
import importlib
import json
import os
import platform
import statistics
import time

OUT_DIR = os.environ.get("PERF_OUT", "perf_results")


def now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def bound_params(mod, params):
    return {name: params.get(name) for name in mod.ALL_PARAMS}


def time_report(conn, mod, name, params, runs, warmup):
    """Run one report warmup+runs times. Returns a list of (milliseconds, row_count) for the timed runs."""
    sql = mod.REPORTS[name]["sql"]
    bound = bound_params(mod, params)
    results = []
    for i in range(warmup + runs):
        cur = conn.cursor()
        start = time.perf_counter()
        cur.execute(sql, bound)
        rows = cur.fetchall()          # fetch everything, like the real report does
        elapsed = (time.perf_counter() - start) * 1000.0
        cur.close()
        if i >= warmup:
            results.append((elapsed, len(rows)))
    return results


def explain_report(conn, mod, name, params):
    """Return the text of EXPLAIN, EXPLAIN FORMAT=TREE and EXPLAIN ANALYZE for one report."""
    sql = mod.REPORTS[name]["sql"].strip()
    bound = bound_params(mod, params)
    parts = []
    for title, prefix in (("EXPLAIN (table form)", "EXPLAIN "),
                          ("EXPLAIN FORMAT=TREE", "EXPLAIN FORMAT=TREE "),
                          ("EXPLAIN ANALYZE (actually runs the query)", "EXPLAIN ANALYZE ")):
        parts.append("=" * 78)
        parts.append(title)
        parts.append("=" * 78)
        try:
            cur = conn.cursor()
            cur.execute(prefix + sql, bound)
            cols = [c[0] for c in cur.description]
            rows = cur.fetchall()
            cur.close()
            if title.startswith("EXPLAIN (table"):
                parts.append(" | ".join(cols))
                for row in rows:
                    parts.append(" | ".join("" if v is None else str(v) for v in row))
            else:
                for row in rows:
                    parts.append("\n".join(str(v) for v in row))
        except Exception as exc:  # old MySQL versions do not have FORMAT=TREE / ANALYZE
            parts.append("could not run: %s" % exc)
        parts.append("")
    return "\n".join(parts)


def write_environment(conn, path, label):
    lines = ["label: %s" % label, "date: %s" % now(),
             "python: %s" % platform.python_version(),
             "os: %s %s" % (platform.system(), platform.release()),
             "machine: %s" % platform.machine(),
             "cpu cores (logical): %s" % os.cpu_count()]
    for what, sql in (("mysql version", "SELECT VERSION()"),
                      ("innodb_buffer_pool_size (bytes)", "SELECT @@innodb_buffer_pool_size"),
                      ("current database", "SELECT DATABASE()")):
        try:
            cur = conn.cursor()
            cur.execute(sql)
            lines.append("%s: %s" % (what, cur.fetchone()[0]))
            cur.close()
        except Exception as exc:
            lines.append("%s: unavailable (%s)" % (what, exc))
    lines.append("")
    lines.append("Add by hand for the report: CPU model, RAM, disk type (SSD/HDD).")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def run_label(args):
    mod = importlib.import_module(args.module)
    overrides = mod.parse_overrides(args.param)
    selected = mod.select_reports(args.report)
    os.makedirs(OUT_DIR, exist_ok=True)
    explain_dir = os.path.join(OUT_DIR, "explain_" + args.label)
    if not args.no_explain:
        os.makedirs(explain_dir, exist_ok=True)

    conn = mod.connect(mod._connection_settings(mod.DWH_DB))
    try:
        write_environment(conn, os.path.join(OUT_DIR, "environment_%s.txt" % args.label), args.label)
        runs_path = os.path.join(OUT_DIR, "timings_%s.csv" % args.label)
        summary_path = os.path.join(OUT_DIR, "summary_%s.csv" % args.label)
        summary = []
        with open(runs_path, "w", newline="", encoding="utf-8") as runs_file:
            runs_writer = csv.writer(runs_file)
            runs_writer.writerow(["label", "report", "run", "ms", "rows", "parameters", "timestamp"])
            for name in selected:
                params = dict(mod.REPORTS[name]["example"])
                params.update(overrides)
                shown = json.dumps({k: v for k, v in params.items() if v is not None})
                print("[%s] %s  %s" % (args.label, name, shown), flush=True)
                try:
                    results = time_report(conn, mod, name, params, args.runs, args.warmup)
                except Exception as exc:
                    print("   FAILED: %s" % exc)
                    summary.append([name, args.runs, "", "", "", "", "", "FAILED: %s" % exc])
                    continue
                times = [ms for ms, _ in results]
                rows = results[-1][1]
                for i, (ms, n) in enumerate(results, 1):
                    runs_writer.writerow([args.label, name, i, "%.2f" % ms, n, shown, now()])
                summary.append([name, len(times), "%.2f" % min(times), "%.2f" % statistics.median(times),
                                "%.2f" % statistics.mean(times), "%.2f" % max(times), rows, "ok"])
                print("   runs=%d  min=%.1f  median=%.1f  max=%.1f ms  rows=%d"
                      % (len(times), min(times), statistics.median(times), max(times), rows), flush=True)
                if not args.no_explain:
                    path = os.path.join(explain_dir, name + ".txt")
                    with open(path, "w", encoding="utf-8") as handle:
                        handle.write("%s  (label: %s, %s)\nparameters: %s\n\n"
                                     % (name, args.label, now(), shown))
                        handle.write(explain_report(conn, mod, name, params))
        with open(summary_path, "w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["report", "runs", "min_ms", "median_ms", "mean_ms", "max_ms", "rows", "status"])
            writer.writerows(summary)
    finally:
        conn.close()
    print("\nSaved to %s/: timings_%s.csv, summary_%s.csv, environment_%s.txt%s"
          % (OUT_DIR, args.label, args.label, args.label,
             "" if args.no_explain else ", explain_%s/" % args.label))


def read_summary(label):
    path = os.path.join(OUT_DIR, "summary_%s.csv" % label)
    with open(path, newline="", encoding="utf-8") as handle:
        return {row["report"]: row for row in csv.DictReader(handle)}


def compare(before, after):
    a, b = read_summary(before), read_summary(after)
    print("%-34s %12s %12s %10s" % ("report", before + " (ms)", after + " (ms)", "speed-up"))
    for name in a:
        if name not in b or not a[name]["median_ms"] or not b[name]["median_ms"]:
            continue
        x, y = float(a[name]["median_ms"]), float(b[name]["median_ms"])
        print("%-34s %12.1f %12.1f %9.2fx" % (name, x, y, x / y if y else float("inf")))
    print("(median of the timed runs; speed-up = before / after)")


def parse_args(argv):
    p = argparse.ArgumentParser(description="Time the OLAP reports and capture EXPLAIN output.")
    p.add_argument("--module", default="olap_reports",
                   help="name of your OLAP script without .py (default olap_reports)")
    p.add_argument("--label", default="baseline", help="name for this run: baseline, indexed, rewritten ...")
    p.add_argument("--runs", type=int, default=10, help="timed runs per report (default 10)")
    p.add_argument("--warmup", type=int, default=1,
                   help="untimed runs first, so caches are warm (default 1; use 0 to include the cold first run)")
    p.add_argument("--report", nargs="*", help="reports to run, e.g. R1 R5 (default all)")
    p.add_argument("--param", nargs="*", metavar="NAME=VALUE", help="override report parameters")
    p.add_argument("--no-explain", action="store_true", help="skip the EXPLAIN capture")
    p.add_argument("--compare", nargs=2, metavar=("BEFORE", "AFTER"),
                   help="compare two saved labels and print the speed-up, then stop")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.compare:
        compare(*args.compare)
        return 0
    sys.path.insert(0, os.getcwd())
    run_label(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
