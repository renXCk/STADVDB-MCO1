"""verify_all.py - checks that the original and optimized queries return identical results for R1 to R7
(using each report's example parameters). Run from the OLAP folder:  python verify_all.py
Numbers are compared with a tolerance of 0.005 because sums may be added in a different order."""
import sys
sys.dont_write_bytecode = True
import os
sys.path.insert(0, os.getcwd())
import OLAP_queries as original
import OLAP_queries_optimized as optimized
from decimal import Decimal

def same(a, b):
    if isinstance(a, (int, float, Decimal)) and isinstance(b, (int, float, Decimal)) and not isinstance(a, bool):
        return abs(float(a) - float(b)) <= 0.005
    return a == b

def run(module, name, params):
    bound = {k: params.get(k) for k in module.ALL_PARAMS}
    cur = conn.cursor()
    try:
        cur.execute(module.REPORTS[name]["sql"], bound)
        return [c[0] for c in cur.description], cur.fetchall()
    finally:
        cur.close()

conn = original.connect(original._connection_settings(original.DWH_DB))
failed = 0
try:
    for name in original.REPORTS:
        params = original.REPORTS[name]["example"]
        oc, orow = run(original, name, params)
        nc, nrow = run(optimized, name, params)
        ok = oc == nc and len(orow) == len(nrow) and all(
            len(x) == len(y) and all(same(p, q) for p, q in zip(x, y)) for x, y in zip(orow, nrow))
        print("%-34s %s (%d rows)" % (name, "PASS" if ok else "FAIL", len(orow)))
        if not ok:
            failed += 1
            if oc != nc:
                print("   column names differ:", oc, nc)
            for i, (x, y) in enumerate(zip(orow, nrow), 1):
                if not all(same(p, q) for p, q in zip(x, y)):
                    print("   first mismatch at row %d\n   original : %s\n   optimized: %s" % (i, x, y))
                    break
finally:
    conn.close()
print("\nALL REPORTS MATCH" if not failed else "\n%d REPORT(S) DIFFER" % failed)
sys.exit(1 if failed else 0)
