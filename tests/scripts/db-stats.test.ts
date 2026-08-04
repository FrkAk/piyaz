import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  formatClassSummary,
  formatDbStatsReport,
  formatMs,
  renderStatementsTable,
  renderTable,
  sanitizeQueryText,
  type ClassSummaryRow,
  type DbStatsReport,
  type StatementRow,
} from "../../scripts/db-stats";

/**
 * Build a statement row with overridable fields.
 *
 * @param overrides - Field overrides.
 * @returns A complete statement row.
 */
function statement(overrides: Partial<StatementRow> = {}): StatementRow {
  return {
    calls: "10",
    total_exec_time: 123.456,
    mean_exec_time: 12.3456,
    rows: "100",
    shared_blks_hit: "5",
    shared_blks_read: "2",
    shared_blks_dirtied: "1",
    temp_blks_read: "0",
    temp_blks_written: "0",
    wal_bytes: "2048",
    query: "SELECT * FROM tasks WHERE id = $1",
    ...overrides,
  };
}

describe("sanitizeQueryText", () => {
  test("collapses whitespace runs and newlines to single spaces", () => {
    expect(sanitizeQueryText("SELECT *\n  FROM   tasks\t WHERE id = $1")).toBe(
      "SELECT * FROM tasks WHERE id = $1",
    );
  });

  test("truncates with an ellipsis at the requested width", () => {
    const out = sanitizeQueryText(
      "SELECT column_a, column_b FROM somewhere",
      20,
    );
    expect(out.length).toBe(20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("SELECT column_a")).toBe(true);
  });

  test("leaves short text untouched", () => {
    expect(sanitizeQueryText("SELECT 1", 20)).toBe("SELECT 1");
  });
});

describe("formatMs", () => {
  test("renders two decimals", () => {
    expect(formatMs(0)).toBe("0.00");
    expect(formatMs(1234.567)).toBe("1234.57");
  });
});

describe("formatBytes", () => {
  test("keeps small counts in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes("1023")).toBe("1023 B");
  });

  test("scales binary units with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });

  test("accepts driver string input", () => {
    expect(formatBytes("2048")).toBe("2.0 KiB");
  });

  test("passes non-numeric input through", () => {
    expect(formatBytes("n/a")).toBe("n/a");
  });
});

describe("renderTable", () => {
  test("pads columns and honors alignment", () => {
    const out = renderTable(
      ["name", "count"],
      [
        ["a", "1"],
        ["long", "100"],
      ],
      [0],
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("name  count");
    expect(lines[1]).toBe("a         1");
    expect(lines[2]).toBe("long    100");
  });
});

describe("formatClassSummary", () => {
  const rows: ClassSummaryRow[] = [
    {
      statement_class: "read",
      statements: "12",
      calls: "3400",
      total_exec_time: 900.5,
    },
    {
      statement_class: "control",
      statements: "3",
      calls: "5000",
      total_exec_time: 42.1,
    },
  ];

  test("renders one aggregate row per class without query text", () => {
    const out = formatClassSummary(rows);
    expect(out).toContain("read");
    expect(out).toContain("control");
    expect(out).toContain("900.50");
    expect(out).not.toContain("SELECT");
    expect(out).not.toContain("SET");
  });

  test("renders a placeholder when nothing was recorded", () => {
    expect(formatClassSummary([])).toBe("(no statements recorded)");
  });
});

describe("renderStatementsTable", () => {
  test("emits exactly the required columns", () => {
    const out = renderStatementsTable([statement()]);
    const header = out.split("\n")[0];
    for (const column of [
      "calls",
      "total ms",
      "mean ms",
      "rows",
      "blk hit",
      "blk read",
      "blk dirty",
      "tmp rd",
      "tmp wr",
      "wal",
      "query",
    ]) {
      expect(header).toContain(column);
    }
    expect(out).toContain("SELECT * FROM tasks WHERE id = $1");
    expect(out).toContain("2.0 KiB");
  });

  test("renders a placeholder when the section is empty", () => {
    expect(renderStatementsTable([])).toBe("(no statements recorded)");
  });
});

describe("formatDbStatsReport", () => {
  const report: DbStatsReport = {
    statsReset: new Date("2026-08-01T03:00:00Z"),
    classSummary: [
      {
        statement_class: "control",
        statements: "2",
        calls: "900",
        total_exec_time: 10,
      },
    ],
    readsByTime: [statement()],
    readsByCalls: [],
    writesByTime: [statement({ query: "UPDATE tasks SET title = $1" })],
    writesByCalls: [],
  };

  test("always leads with the stats_reset observation window", () => {
    expect(formatDbStatsReport(report)).toContain(
      "window since 2026-08-01T03:00:00.000Z",
    );
    expect(formatDbStatsReport({ ...report, statsReset: null })).toContain(
      "window since unknown (stats_reset unavailable)",
    );
  });

  test("includes every section header and empty placeholders", () => {
    const out = formatDbStatsReport(report);
    for (const section of [
      "statement classes",
      "top reads by total time",
      "top reads by calls",
      "top writes by total time",
      "top writes by calls",
    ]) {
      expect(out).toContain(section);
    }
    expect(out).toContain("(no statements recorded)");
  });

  test("prints query text only inside read/write sections", () => {
    const out = formatDbStatsReport(report);
    const classSection = out.split("top reads by total time")[0];
    expect(classSection).not.toContain("SELECT * FROM tasks");
    expect(out).toContain("UPDATE tasks SET title = $1");
  });
});
