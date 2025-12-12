import Papa from 'papaparse';
import { useCallback, useMemo, useState } from 'react';

type MetricKey = 'gross' | 'net' | 'discounts' | 'tips' | 'transactions';

type RawRow = Record<string, string>;

type DailyAggregate = {
  dateISO: string;
  gross: number;
  net: number;
  discounts: number;
  tips: number;
  transactions: number;
};

type Summary = {
  operatingDays: number;
  calendarDays: number;
  totals: Record<MetricKey, number>;
  perOperatingDay: Record<MetricKey, number>;
  perCalendarDay: Record<MetricKey, number>;
  ratios: {
    discountRate: number;
    netPerTransaction: number;
    tipsPerTransaction: number;
  };
  signals: string[];
};

const metricHints: Record<MetricKey, string[]> = {
  gross: ['gross', 'total sales', 'total gross', 'revenue'],
  net: ['net', 'total net', 'net sales'],
  discounts: ['discount', 'comp', 'promo'],
  tips: ['tip', 'gratuity'],
  transactions: ['transactions', 'orders', 'receipts', 'count'],
};

const numberish = /[-\d.,$()%]/;

function parseNumber(raw: string | number | undefined): number {
  if (raw === undefined) return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const value = raw.trim();
  if (!value) return 0;

  const normalized = value
    .replace(/[$,\s]/g, '')
    .replace(/[()]/g, '')
    .replace(/%/g, '')
    .replace(/\u00a0/g, '');

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tryParseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  const replacements = value.replace(/\//g, '-');
  const date = new Date(replacements);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10);
  }

  const parts = value.split(/[\sT]/)[0];
  const dateAlt = new Date(parts);
  if (!Number.isNaN(dateAlt.getTime())) {
    return dateAlt.toISOString().slice(0, 10);
  }

  return null;
}

function detectDateColumn(rows: RawRow[], headers: string[]): string | null {
  let best: { header: string; hits: number } | null = null;

  for (const header of headers) {
    const hits = rows.reduce((acc, row) => (tryParseDate(row[header]) ? acc + 1 : acc), 0);
    if (hits === 0) continue;
    if (!best || hits > best.hits) {
      best = { header, hits };
    }
  }

  return best?.header ?? null;
}

function detectMetricColumns(rows: RawRow[], headers: string[]): Partial<Record<MetricKey, string>> {
  const available = new Set(headers);
  const selections: Partial<Record<MetricKey, string>> = {};

  for (const [metric, hints] of Object.entries(metricHints) as [MetricKey, string[]][]) {
    let best: { header: string; score: number } | null = null;

    for (const header of available) {
      const headerLc = header.toLowerCase();
      if (!rows.some((row) => numberish.test(row[header] ?? ''))) continue;

      const score = hints.reduce((acc, hint) => (headerLc.includes(hint) ? acc + 1 : acc), 0);
      if (score === 0 && best) continue;

      const numericDensity = rows.reduce((acc, row) => {
        const cleaned = row[header];
        return numberish.test(cleaned ?? '') ? acc + 1 : acc;
      }, 0);
      const weightedScore = score * 2 + numericDensity;

      if (!best || weightedScore > best.score) {
        best = { header, score: weightedScore };
      }
    }

    if (best) {
      selections[metric] = best.header;
      available.delete(best.header);
    }
  }

  // If transactions is still missing, grab any remaining numeric column.
  if (!selections.transactions) {
    for (const header of available) {
      const numericDensity = rows.reduce((acc, row) => (numberish.test(row[header] ?? '') ? acc + 1 : acc), 0);
      if (numericDensity > rows.length / 3) {
        selections.transactions = header;
        break;
      }
    }
  }

  return selections;
}

function aggregate(rows: RawRow[]): { daily: DailyAggregate[]; summary: Summary } {
  if (rows.length === 0) {
    throw new Error('No rows detected in CSV.');
  }

  const headers = Object.keys(rows[0]);
  const dateColumn = detectDateColumn(rows, headers);

  if (!dateColumn) {
    throw new Error('Could not find a date column. Please ensure the CSV includes a date column.');
  }

  const metricColumns = detectMetricColumns(rows, headers);
  const missingMetrics = (['gross', 'net'] satisfies MetricKey[]).filter((m) => !metricColumns[m]);
  if (missingMetrics.length) {
    throw new Error(`Missing expected numeric columns: ${missingMetrics.join(', ')}`);
  }

  const bucket = new Map<string, DailyAggregate>();

  for (const row of rows) {
    const dateISO = tryParseDate(row[dateColumn]);
    if (!dateISO) continue;

    const entry = bucket.get(dateISO) ?? {
      dateISO,
      gross: 0,
      net: 0,
      discounts: 0,
      tips: 0,
      transactions: 0,
    };

    (['gross', 'net', 'discounts', 'tips', 'transactions'] as MetricKey[]).forEach((metric) => {
      const column = metricColumns[metric];
      if (!column) return;
      entry[metric] += parseNumber(row[column]);
    });

    bucket.set(dateISO, entry);
  }

  const daily = Array.from(bucket.values()).sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  if (daily.length === 0) {
    throw new Error('No usable dated rows found after parsing.');
  }

  const totals = daily.reduce(
    (acc, cur) => {
      acc.gross += cur.gross;
      acc.net += cur.net;
      acc.discounts += cur.discounts;
      acc.tips += cur.tips;
      acc.transactions += cur.transactions;
      return acc;
    },
    { gross: 0, net: 0, discounts: 0, tips: 0, transactions: 0 } as Record<MetricKey, number>,
  );

  const operatingDays = daily.length;
  const calendarDays = (() => {
    const start = new Date(daily[0].dateISO);
    const end = new Date(daily[daily.length - 1].dateISO);
    const diff = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    return diff + 1;
  })();

  const perOperatingDay = Object.fromEntries(
    (Object.entries(totals) as [MetricKey, number][]).map(([metric, value]) => [metric, value / operatingDays]),
  ) as Record<MetricKey, number>;

  const perCalendarDay = Object.fromEntries(
    (Object.entries(totals) as [MetricKey, number][]).map(([metric, value]) => [metric, value / calendarDays]),
  ) as Record<MetricKey, number>;

  const ratios = {
    discountRate: totals.gross ? totals.discounts / totals.gross : 0,
    netPerTransaction: totals.transactions ? totals.net / totals.transactions : 0,
    tipsPerTransaction: totals.transactions ? totals.tips / totals.transactions : 0,
  };

  const signals = buildSignals({ operatingDays, calendarDays, perOperatingDay, ratios });

  return {
    daily,
    summary: {
      operatingDays,
      calendarDays,
      totals,
      perOperatingDay,
      perCalendarDay,
      ratios,
      signals,
    },
  };
}

function buildSignals({
  operatingDays,
  calendarDays,
  perOperatingDay,
  ratios,
}: {
  operatingDays: number;
  calendarDays: number;
  perOperatingDay: Record<MetricKey, number>;
  ratios: Summary['ratios'];
}): string[] {
  const messages: string[] = [];

  if (operatingDays < calendarDays) {
    messages.push(
      `Operating-day normalization matters: ${operatingDays} active days across ${calendarDays} calendar days. Totals alone understate per-day performance.`,
    );
  } else {
    messages.push('Performance is normalized: every calendar day shows activity.');
  }

  const grossPerDay = perOperatingDay.gross;
  const tickets = ratios.netPerTransaction;
  const txnPace = perOperatingDay.transactions;
  if (grossPerDay && tickets && txnPace) {
    if (tickets * 1.5 > txnPace) {
      messages.push('Revenue is driven more by ticket size than transaction volume; protect average check to maintain momentum.');
    } else if (txnPace * 1.5 > tickets) {
      messages.push('Revenue is volume-led; keep an eye on traffic levers and service speed.');
    } else {
      messages.push('Ticket size and volume are balanced drivers of revenue.');
    }
  }

  if (ratios.discountRate >= 0.15) {
    messages.push('Discount pressure is material (discounts over 15% of gross). Ensure promos are intentional.');
  } else if (ratios.discountRate > 0.05) {
    messages.push('Moderate discounting detected; track whether promos are lifting ticket size or just eroding margin.');
  } else {
    messages.push('Discount impact is light; margin preservation is strong.');
  }

  if (ratios.tipsPerTransaction < 1) {
    messages.push('Tips per transaction are soft; consider service quality or customer mix changes.');
  } else if (ratios.tipsPerTransaction > 2.5) {
    messages.push('Tips per transaction are strong; service experience may be a differentiator.');
  } else {
    messages.push('Tips per transaction are steady; no major behavioral signal detected.');
  }

  return messages;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function formatDecimal(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function DropZone({ onFiles }: { onFiles: (files: FileList) => void }) {
  const [dragging, setDragging] = useState(false);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      if (event.dataTransfer.files?.length) {
        onFiles(event.dataTransfer.files);
      }
    },
    [onFiles],
  );

  return (
    <div
      className={`drop-area ${dragging ? 'dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <p>Drop a Square Sales Summary CSV here</p>
      <p>or</p>
      <label>
        <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files && onFiles(e.target.files)} />
        <button className="browse" type="button">
          Browse files
        </button>
      </label>
    </div>
  );
}

export default function App() {
  const [daily, setDaily] = useState<DailyAggregate[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');

  const handleFiles = useCallback(async (files: FileList) => {
    const file = files[0];
    if (!file) return;
    setFileName(file.name);
    try {
      const text = await file.text();
      const parsed = Papa.parse<RawRow>(text, { header: true, skipEmptyLines: true });
      if (parsed.errors.length) {
        throw new Error(parsed.errors[0].message);
      }
      const rows = parsed.data.filter((row) => Object.keys(row).length > 0);
      const { daily: aggregated, summary: builtSummary } = aggregate(rows);
      setDaily(aggregated);
      setSummary(builtSummary);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to parse CSV.';
      setError(message);
      setDaily([]);
      setSummary(null);
    }
  }, []);

  const calendarRange = useMemo(() => {
    if (!daily.length) return null;
    const start = daily[0].dateISO;
    const end = daily[daily.length - 1].dateISO;
    return `${start} → ${end}`;
  }, [daily]);

  return (
    <div className="app-shell">
      <header>
        <h1>Sales Snapshot</h1>
        <p className="subtitle">Client-only diagnostics for Square “Sales Summary” exports.</p>
      </header>

      <DropZone onFiles={handleFiles} />

      {fileName && (
        <p className="subtitle" style={{ marginTop: '0.5rem' }}>
          Loaded file: <strong>{fileName}</strong>
        </p>
      )}

      {error && <div className="error">{error}</div>}

      {summary ? (
        <div style={{ marginTop: '1.25rem' }}>
          <div className="grid">
            <div className="card">
              <h3>Normalization</h3>
              <p>
                <span className="badge">Operating</span>
                {summary.operatingDays} days
              </p>
              <p>
                <span className="badge">Calendar</span>
                {summary.calendarDays} days
              </p>
              {calendarRange && <p>Range: {calendarRange}</p>}
            </div>
            <div className="card">
              <h3>Totals</h3>
              <p>Gross: {formatCurrency(summary.totals.gross)}</p>
              <p>Net: {formatCurrency(summary.totals.net)}</p>
              <p>Transactions: {formatDecimal(summary.totals.transactions)}</p>
            </div>
            <div className="card">
              <h3>Ratios</h3>
              <p>Discount rate: {formatPercent(summary.ratios.discountRate)}</p>
              <p>Net / transaction: {formatCurrency(summary.ratios.netPerTransaction)}</p>
              <p>Tips / transaction: {formatCurrency(summary.ratios.tipsPerTransaction)}</p>
            </div>
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <h3>Per-day performance</h3>
            <div className="metrics-list">
              {(['gross', 'net', 'discounts', 'tips', 'transactions'] as MetricKey[]).map((metric) => (
                <div key={metric} className="metric-row">
                  <span className="label">{metric}</span>
                  <span>
                    {metric === 'transactions'
                      ? `${formatDecimal(summary.perOperatingDay[metric])} / operating day`
                      : `${formatCurrency(summary.perOperatingDay[metric])} / operating day`}
                    <span className="tag">
                      {metric === 'transactions'
                        ? `${formatDecimal(summary.perCalendarDay[metric])} / calendar day`
                        : `${formatCurrency(summary.perCalendarDay[metric])} / calendar day`}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <h3>Signals</h3>
            <ul className="signals">
              {summary.signals.map((signal, idx) => (
                <li key={idx}>{signal}</li>
              ))}
            </ul>
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <h3>Daily view</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Gross</th>
                    <th>Net</th>
                    <th>Discounts</th>
                    <th>Tips</th>
                    <th>Transactions</th>
                  </tr>
                </thead>
                <tbody>
                  {daily.map((row) => (
                    <tr key={row.dateISO}>
                      <td>{row.dateISO}</td>
                      <td>{formatCurrency(row.gross)}</td>
                      <td>{formatCurrency(row.net)}</td>
                      <td>{formatCurrency(row.discounts)}</td>
                      <td>{formatCurrency(row.tips)}</td>
                      <td>{formatDecimal(row.transactions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <p className="empty-state">Drop a CSV to generate per-day metrics, ratios, and signals.</p>
      )}
    </div>
  );
}
