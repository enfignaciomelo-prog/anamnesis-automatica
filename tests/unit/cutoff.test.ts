import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localParts, nextDailyCutoff, periodOf } from "../../shared/cutoff";

const iso = (ms: number) => new Date(ms).toISOString();

describe("corte diario 23:59 America/Santiago", () => {
  it("horario de verano (UTC-3) e invierno (UTC-4)", () => {
    assert.equal(iso(nextDailyCutoff(Date.parse("2026-11-26T12:00:00Z"))), "2026-11-27T02:59:00.000Z");
    assert.equal(iso(nextDailyCutoff(Date.parse("2026-07-01T15:00:00Z"))), "2026-07-02T03:59:00.000Z");
  });

  it("justo en el corte o después pasa al día siguiente (sin bucle de cierre)", () => {
    const cut = nextDailyCutoff(Date.parse("2026-11-26T12:00:00Z"));
    assert.equal(iso(nextDailyCutoff(cut)), "2026-11-28T02:59:00.000Z");
    assert.equal(iso(nextDailyCutoff(cut + 1000)), "2026-11-28T02:59:00.000Z");
    assert.equal(iso(nextDailyCutoff(cut - 1000)), iso(cut));
  });

  it("todos los días de 2025 a 2027 cortan a las 23:59:00 locales, con 23 a 25 h entre cortes", () => {
    let t = Date.parse("2025-01-01T12:00:00Z");
    let prev = nextDailyCutoff(t);
    const gaps = new Set<number>();
    for (let i = 0; i < 365 * 3; i++) {
      const l = localParts(prev);
      assert.deepEqual([l.h, l.mi, l.s], [23, 59, 0], iso(prev));
      const next = nextDailyCutoff(prev);
      const hours = (next - prev) / 36e5;
      assert.ok(hours >= 23 && hours <= 25, `${iso(prev)} → ${iso(next)}`);
      gaps.add(hours);
      prev = next;
      t = next;
    }
    // Hubo cambios de horario estacional en el período (días de 23 y 25 horas).
    assert.ok(gaps.has(23) && gaps.has(25), [...gaps].join(","));
  });

  it("el período es la fecha local del corte", () => {
    assert.equal(periodOf(Date.parse("2026-11-26T12:00:00Z")), "2026-11-26");
    // 23:59:30 locales del 26 ya pertenece al período del 27.
    assert.equal(periodOf(Date.parse("2026-11-27T02:59:30Z")), "2026-11-27");
  });
});
