
from OLAP import OLAP_queries as original
from OLAP import OLAP_queries_optimized as optimized

reports = ["R5", "R6", "R7"]

conn = original.connect(
    original._connection_settings(original.DWH_DB)
)

def execute(module, report_name, params):
    sql = module.REPORTS[report_name]["sql"]
    bound = {
        key: params.get(key)
        for key in module.ALL_PARAMS
    }

    cursor = conn.cursor()
    try:
        cursor.execute(sql, bound)
        columns = [col[0] for col in cursor.description]
        rows = cursor.fetchall()
        return columns, rows
    finally:
        cursor.close()

try:
    for report in reports:
        name = next(
            key for key in original.REPORTS
            if key.startswith(report + "_")
        )

        params = original.REPORTS[name]["example"]

        old_columns, old_rows = execute(
            original, name, params
        )

        new_columns, new_rows = execute(
            optimized, name, params
        )

        if old_columns == new_columns and old_rows == new_rows:
            print(f"{report}: PASS")
            print(f"  All {len(old_rows)} rows match exactly.")
        else:
            print(f"{report}: FAIL")
            print(f"  Original rows: {len(old_rows)}")
            print(f"  Optimized rows: {len(new_rows)}")

            if old_columns != new_columns:
                print("  Column names/order differ.")
            else:
                for index, (old, new) in enumerate(
                    zip(old_rows, new_rows), start=1
                ):
                    if old != new:
                        print(f"  First mismatch at row {index}")
                        print(f"  Original: {old}")
                        print(f"  Optimized: {new}")
                        break
finally:
    conn.close()
