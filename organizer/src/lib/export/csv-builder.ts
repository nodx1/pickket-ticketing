interface CSVColumn<T> {
  key: keyof T;
  label: string;
  format?: (value: unknown, row: T) => string;
}

function escapeCSVValue(value: string) {
  // CSV 수식 인젝션 차단: =,+,-,@,탭,CR 로 시작하면 작은따옴표를 앞에 붙여 무력화.
  // (Excel/Sheets 가 =HYPERLINK(...), =cmd|... 등을 수식으로 실행하는 것을 방지)
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) {
    v = `'${v}`;
  }
  if (v.includes(",") || v.includes("\n") || v.includes("\"")) {
    return `"${v.replaceAll("\"", "\"\"")}"`;
  }
  return v;
}

export function buildCSV<T>(data: T[], columns: CSVColumn<T>[]): string {
  const headers = columns.map((column) => escapeCSVValue(column.label)).join(",");
  const rows = data.map((row) =>
    columns
      .map((column) => {
        const rawValue = row[column.key];
        const value = column.format ? column.format(rawValue, row) : String(rawValue ?? "");
        return escapeCSVValue(value);
      })
      .join(","),
  );

  return `\uFEFF${[headers, ...rows].join("\n")}`;
}

export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.csv"`,
    },
  });
}
