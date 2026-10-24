"""compare_uniform.py - prints and saves the baseline vs optimized comparison.
Run from the OLAP folder after both perf_baseline.py runs:
    python compare_uniform.py uniform_baseline uniform_optimized
"""
import csv, os, sys

OUT = os.environ.get("PERF_OUT", "perf_results")

def read(label):
    with open(os.path.join(OUT, "summary_%s.csv" % label), newline="", encoding="utf-8") as f:
        return {r["report"]: r for r in csv.DictReader(f)}

def main(before, after):
    a, b = read(before), read(after)
    rows = []
    print("%-34s %10s %10s %10s %9s %10s %s" % ("report", "before ms", "after ms", "saved ms", "speed-up", "improved", "rows"))
    for name in a:
        if name not in b or a[name]["status"] != "ok" or b[name]["status"] != "ok":
            print("%-34s  (missing or failed)" % name)
            continue
        x, y = float(a[name]["median_ms"]), float(b[name]["median_ms"])
        same = "same" if a[name]["rows"] == b[name]["rows"] else "DIFFERENT (%s vs %s)" % (a[name]["rows"], b[name]["rows"])
        print("%-34s %10.1f %10.1f %10.1f %8.2fx %9.2f%% %s" % (name, x, y, x - y, x / y, 100 * (x - y) / x, same))
        rows.append([name, a[name]["runs"], b[name]["runs"], "%.1f" % x, "%.1f" % y, "%.1f" % (x - y),
                     "%.2f" % (x / y), "%.2f" % (100 * (x - y) / x), same])
    path = os.path.join(OUT, "uniform_comparison.csv")
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["report", "runs_before", "runs_after", "median_before_ms", "median_after_ms",
                    "time_saved_ms", "speedup_x", "improvement_pct", "row_count"])
        w.writerows(rows)
    print("\nMedians of the timed runs (1 warm-up each). Saved to %s" % path)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python compare_uniform.py <baseline_label> <optimized_label>")
    main(sys.argv[1], sys.argv[2])
