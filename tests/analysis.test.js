import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSeries, comparePeriods } from "../src/analysis.js";

function syntheticSeries(slope = 0.2, years = 5) {
  const observations = [];
  for (let year = 2000; year < 2000 + years; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const yearDecimal = year + (month - 0.5) / 12;
      observations.push({
        date: `${year}-${String(month).padStart(2, "0")}`,
        year,
        month,
        yearDecimal,
        value: 10 + slope * (yearDecimal - 2000),
      });
    }
  }
  return observations;
}

test("Theil-Sen trend analysis recovers a positive synthetic slope", () => {
  const result = analyzeSeries(syntheticSeries(0.4, 6), { shortName: "Temperature" });
  assert.equal(result.validCount, 72);
  assert.ok(Math.abs(result.slope - 0.4) < 0.001);
  assert.equal(result.direction, "positive");
  assert.equal(result.significant, true);
});

test("analysis reports insufficient data for short series", () => {
  const result = analyzeSeries(syntheticSeries(0.2, 1), { shortName: "Temperature" });
  assert.equal(result.slope, null);
  assert.match(result.interpretation, /Insufficient data/);
});

test("period comparison uses valid observations only", () => {
  const result = comparePeriods(syntheticSeries(1, 6), { aStart: 2000, aEnd: 2001, bStart: 2004, bEnd: 2005 });
  assert.equal(result.ok, true);
  assert.ok(result.difference > 3);
});
