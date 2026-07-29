import { describe, expect, it } from "vite-plus/test";

import { consumePiJsonlRecords, encodePiJsonlRecord, tryParsePiJsonlRecord } from "./PiJsonl.ts";

describe("Pi JSONL framing", () => {
  it("splits only on LF and strips trailing CR", () => {
    const first = consumePiJsonlRecords('{"a":1}\r\n{"b":2}\n{"partial');
    expect(first.records).toEqual(['{"a":1}', '{"b":2}']);
    expect(first.rest).toBe('{"partial');

    const second = consumePiJsonlRecords(first.rest + '":true}\n');
    expect(second.records).toEqual(['{"partial":true}']);
    expect(second.rest).toBe("");
  });

  it("does not treat Unicode line separators as delimiters", () => {
    const payload = `{"text":"line\u2028still-one"}\n{"ok":true}\n`;
    const result = consumePiJsonlRecords(payload);
    expect(result.records).toHaveLength(2);
    expect(tryParsePiJsonlRecord(result.records[0]!)).toEqual({
      text: "line\u2028still-one",
    });
  });

  it("encodes records with a trailing LF only", () => {
    expect(encodePiJsonlRecord({ type: "abort" })).toBe('{"type":"abort"}\n');
  });

  it("returns undefined for empty or invalid JSON records", () => {
    expect(tryParsePiJsonlRecord("")).toBeUndefined();
    expect(tryParsePiJsonlRecord("   ")).toBeUndefined();
    expect(tryParsePiJsonlRecord("{nope")).toBeUndefined();
    expect(tryParsePiJsonlRecord('{"ok":true}')).toEqual({ ok: true });
  });
});
