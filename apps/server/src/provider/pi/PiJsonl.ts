/**
 * Strict LF-only JSONL framing for Pi RPC mode.
 *
 * Pi documents that only `\n` is a record delimiter. Generic line readers
 * (Node readline, Unicode line separators) are not protocol-compliant
 * because U+2028 / U+2029 are valid inside JSON strings.
 *
 * @module provider/pi/PiJsonl
 */

export interface PiJsonlParseResult {
  readonly records: ReadonlyArray<string>;
  readonly rest: string;
}

/**
 * Consume complete LF-delimited records from a buffer.
 * Trailing CR on a record is stripped so `\r\n` inputs are accepted.
 */
export function consumePiJsonlRecords(buffer: string): PiJsonlParseResult {
  const records: string[] = [];
  let start = 0;

  while (true) {
    const newlineAt = buffer.indexOf("\n", start);
    if (newlineAt < 0) {
      return {
        records,
        rest: buffer.slice(start),
      };
    }

    let record = buffer.slice(start, newlineAt);
    if (record.endsWith("\r")) {
      record = record.slice(0, -1);
    }
    records.push(record);
    start = newlineAt + 1;
  }
}

export function encodePiJsonlRecord(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function tryParsePiJsonlRecord(record: string): unknown | undefined {
  const trimmed = record.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
