import test from "node:test";
import assert from "node:assert/strict";
import {
  rainfallMonths,
  rainfallDistribution,
  weightedMean,
  monthlyClimatology,
  climateMetrics,
  climateInsights,
} from "../src/climateData.js";
import { latLngVector, vectorLatLng } from "../src/earthGlobe.js";

function series(id, value = 2) {
  return {
    parameter: id,
    parameterInfo: {
      id,
      units: id === "PRECTOTCORR" ? "mm/day" : "NASA unit",
      shortName: id,
    },
    observations: Array.from({ length: 24 }, (_, i) => ({
      year: 2023 + Math.floor(i / 12),
      month: (i % 12) + 1,
      date: `${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
      yearDecimal: 2023 + (i + 0.5) / 12,
      value,
    })),
  };
}
test("rainfall shares exclude incomplete years and integrate daily rates over leap years", () => {
  const rain = series("PRECTOTCORR");
  rain.observations[0].value = null;
  const result = rainfallDistribution(rain);
  assert.equal(result.completeYears, 1);
  assert.equal(result.total, 732);
  assert.equal(result.values[1].value, 58);
  assert.equal(
    rainfallDistribution(rain, "seasons").values.reduce(
      (sum, item) => sum + item.value,
      0,
    ),
    732,
  );
  assert.equal(rainfallMonths(rain)[0].value, null);
});
test("climate averages weight valid months by days and never zero-fill missing values", () => {
  const observations = [
    { year: 2024, month: 1, value: 10 },
    { year: 2024, month: 2, value: 20 },
    { year: 2024, month: 3, value: null },
  ];
  assert.equal(weightedMean(observations), (310 + 580) / 60);
  assert.equal(monthlyClimatology(observations)[2].value, null);
});
test("dashboard metrics and insights are derived from the dataset with coverage caveats", () => {
  const dataset = {
    startYear: 2023,
    endYear: 2024,
    series: Object.fromEntries(
      ["T2M", "PRECTOTCORR", "RH2M", "ALLSKY_SFC_SW_DWN", "WS2M"].map((id) => [
        id,
        series(id),
      ]),
    ),
  };
  dataset.series.PRECTOTCORR.observations[0].value = null;
  const metrics = climateMetrics(dataset);
  assert.equal(metrics.find((item) => item.id === "T2M").value, 2);
  assert.equal(
    metrics.find((item) => item.id === "PRECTOTCORR").value,
    (365 + 366 - 31) * 2,
  );
  assert.match(
    metrics.find((item) => item.id === "PRECTOTCORR").note,
    /partial total/,
  );
  const insights = climateInsights(dataset);
  assert.equal(insights.length, 6);
  assert.match(insights[1].text, /1 complete year/);
  assert.match(insights[2].text, /At least three complete years/);
});
test("globe raycast coordinate conversion round-trips known points and the dateline", () => {
  for (const [lat, lng] of [
    [14.5995, 120.9842],
    [0, 0],
    [-33.8688, 151.2093],
    [51.5, -0.1],
    [0, 179.99],
    [89, 45],
  ]) {
    const point = vectorLatLng(latLngVector(lat, lng));
    assert.ok(Math.abs(point.lat - lat) < 1e-8);
    assert.ok(Math.abs(point.lng - lng) < 1e-8);
  }
});
