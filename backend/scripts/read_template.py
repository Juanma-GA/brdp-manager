"""Rows of an .xlsx workbook as JSON -- for the Node scripts in scripts/,
which no longer have SheetJS (xlsx) to read the curated templates.

    cd backend && .venv/bin/python scripts/read_template.py ../public/brdp-template-4-2.xlsx
    cat file.xlsx | .venv/bin/python scripts/read_template.py -

Prints a JSON array with one object per data row of the first sheet, keyed
by the (trimmed) header cells, every value as text -- read exactly like the
app's Excel import does (app/services/excel_io.py: openpyxl read-only,
formulas never evaluated, Excel's _x000d_ escapes decoded, line breaks as
"\\n", XML entities in a rule left untouched). Fully empty rows are skipped.
The Node side is scripts/lib/readXlsx.mjs.
"""
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import openpyxl

from app.services.excel_io import cell_text


def read_rows(data: bytes) -> list[dict]:
    workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        rows = workbook.worksheets[0].iter_rows(values_only=True)
        header = [cell_text(h).strip() for h in next(rows, ())]
        out = []
        for raw in rows:
            values = {name: cell_text(value) for name, value in zip(header, raw) if name}
            if any(v.strip() for v in values.values()):
                out.append(values)
        return out
    finally:
        workbook.close()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: read_template.py <file.xlsx | ->", file=sys.stderr)
        return 2
    source = sys.argv[1]
    data = sys.stdin.buffer.read() if source == "-" else Path(source).read_bytes()
    # Bytes, not sys.stdout.write: on Windows stdout uses the console code
    # page (cp1252), and readXlsx.mjs decodes UTF-8 -- "Códigos" arrived as
    # "C\ufffddigos".
    sys.stdout.buffer.write(json.dumps(read_rows(data), ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
