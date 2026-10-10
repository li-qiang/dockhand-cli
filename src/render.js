/**
 * Output rendering. `json` is the default because the CLI is meant to be
 * driven by agents and scripts; `table` and `raw` exist for humans.
 */

export function render(result, mode, { color = false, fields } = {}) {
  if (mode === 'raw') return result.text;
  if (mode === 'ndjson') return result.data === undefined ? result.text : JSON.stringify(result.data);

  if (result.data !== undefined) {
    if (mode === 'table') return renderTable(result.data, { color, fields });
    if (mode === 'auto') return autoDetect(result);
    return JSON.stringify(result.data, null, 2);
  }

  // Non-JSON payloads (tar exports, SVGs, log text, Prometheus metrics).
  if (mode === 'table' || mode === 'auto') return result.text;
  return result.text;
}

function autoDetect(result) {
  if (Array.isArray(result.data) && result.data.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    return renderTable(result.data);
  }
  if (result.data && typeof result.data === 'object') return renderKeyValue(result.data);
  return JSON.stringify(result.data ?? result.text, null, 2);
}

/** Column-aligned table for arrays of flat objects; key/value otherwise. */
export function renderTable(data, { color = false, fields } = {}) {
  if (data === null || data === undefined) return '';
  if (Array.isArray(data)) {
    if (data.length === 0) return color ? dim('(0 rows)') : '(0 rows)';
    const rows = data.map((row) => (row && typeof row === 'object' && !Array.isArray(row) ? row : { value: row }));
    const wanted = fields?.length ? fields : null;
    const columns = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!columns.includes(key)) columns.push(key);
      }
    }
    const selected = wanted
      ? columns.filter((col) => wanted.includes(col))
      : columns.filter((col) => !columns.every((c) => c === col) || rows.some((row) => row[col] !== undefined && row[col] !== null));
    if (wanted) {
      for (const col of wanted) if (!columns.includes(col)) throw new Error(`--fields: no column named "${col}" (available: ${columns.join(', ')})`);
    }
    const cells = rows.map((row) => selected.map((col) => formatCell(row[col])));
    const widths = selected.map((col, i) => Math.max(displayWidth(col), ...cells.map((row) => displayWidth(row[i]))));
    const style = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
    const head = style(selected.map((col, i) => col.padEnd(widths[i])).join('  ').trimEnd());
    const body = cells.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd());
    return [head, ...body].join('\n');
  }
  if (typeof data === 'object') return renderKeyValue(data);
  return String(data);
}

function renderKeyValue(object) {
  const entries = Object.entries(object).filter(([, value]) => value !== undefined);
  const width = Math.max(0, ...entries.map(([key]) => key.length));
  return entries.map(([key, value]) => {
    const rendered = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    return `${key.padEnd(width)}  ${rendered}`;
  }).join('\n');
}

function formatCell(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    if (value.length === 0) return '-';
    return `${value.length}× ${value.slice(0, 2).map((v) => (typeof v === 'object' ? '{…}' : v)).join(', ')}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`;
  }
  return String(value).replace(/\s+/g, ' ').slice(0, 60);
}

const displayWidth = (text) => [...String(text)].reduce(
  (sum, char) => sum + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(char) ? 2 : 1),
  0,
);

function dim(text) {
  return `\x1b[2m${text}\x1b[0m`;
}