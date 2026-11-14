import test from "node:test";
import assert from "node:assert/strict";
import { POWER_PARAMETERS, normalizePowerResponse, aggregateYearly, validatePowerRequest, fetchMonthlyPowerData } from "../src/nasaPower.js";
import { buildCsv } from "../src/report.js";

const request = { latitude: 14.5995, longitude: 120.9842, startYear: 2024, endYear: 2024, parameter: "T2M", url: "https://power.larc.nasa.gov/api/temporal/monthly/point", retrievedAt: "2026-10-24" };
// Parser fixtures are confined to tests; application data always comes from NASA.
function fixture() {
  return { header: { fill_value: -999 }, properties: { parameter: Object.fromEntries(Object.keys(POWER_PARAMETERS).map(id => [id, { "202401": 2, "202402": -999, "202403": null, "202404": "", "202405": 0, "202413": 99 }])) },
    parameters: Object.fromEntries(Object.keys(POWER_PARAMETERS).map(id => [id, { units: id === "PRECTOTCORR" ? "mm/day" : "NASA unit", longname: id }])) };
}
test("normalization excludes annual records and preserves missing months and NASA units", () => {
  const dataset = normalizePowerResponse(fixture(), request);
  assert.equal(dataset.observations.length, 12);
  assert.equal(dataset.validCount, 2);
  assert.equal(dataset.missingCount, 10);
  assert.equal(dataset.observations[4].value, 0);
  assert.equal(dataset.observations[1].value, null);
  assert.equal(dataset.series.PRECTOTCORR.parameterInfo.units, "mm/day");
  assert.equal(dataset.observations.some(item => item.month === 13), false);
});
test("all unavailable periods and malformed responses produce meaningful errors", () => {
  const raw = fixture();
  for (const id of Object.keys(raw.properties.parameter)) raw.properties.parameter[id] = {};
  assert.throws(() => normalizePowerResponse(raw, request), /no available/);
  assert.throws(() => normalizePowerResponse({}, request), /did not include/);
});
test("yearly rainfall integrates daily rates over leap-year months and excludes incomplete years", () => {
  const months = Array.from({ length: 12 }, (_, i) => ({ year: 2024, month: i + 1, value: 2 }));
  assert.equal(aggregateYearly(months, { id: "PRECTOTCORR", units: "mm/day" }).observations[0].value, 732);
  months[1].value = null;
  assert.equal(aggregateYearly(months, { id: "PRECTOTCORR", units: "mm/day" }).observations[0].value, null);
});
test("annual means weight months by calendar days", () => {
  const months = Array.from({ length: 12 }, (_, i) => ({ year: 2024, month: i + 1, value: i === 1 ? 100 : 0 }));
  assert.equal(aggregateYearly(months, { id: "T2M", units: "C" }).observations[0].value, 2900 / 366);
});
test("request validation rejects invalid coordinates, reversed years and unsupported periods", () => {
  for (const override of [{ latitude: NaN }, { longitude: 181 }, { startYear: 2025, endYear: 2024 }, { startYear: 1980 }, { endYear: 3000 }]) assert.throws(() => validatePowerRequest({ ...request, ...override }));
});
test("CSV contains all five parameters with original values, coordinates and missing cells", () => {
  const csv = buildCsv({ dataset: normalizePowerResponse(fixture(), request) });
  assert.match(csv, /latitude,longitude,date,parameter,value,units,source_url/);
  assert.match(csv, /14.5995,120.9842,2024-01,PRECTOTCORR,2,mm\/day/);
  assert.match(csv, /2024-02,T2M,,NASA unit/);
  assert.equal(csv.split("\n").filter(line => line.startsWith("14.5995,")).length, 60);
});
test("fetch sends all parameters and selected coordinates/years; surfaces NASA API errors", async t => {
  let captured;
  t.mock.method(globalThis, "fetch", async url => { captured = new URL(url); return { ok: true, json: async () => fixture() }; });
  await fetchMonthlyPowerData({ ...request, longitude: 121.123 });
  assert.equal(captured.searchParams.get("latitude"), "14.5995");
  assert.equal(captured.searchParams.get("longitude"), "121.123");
  assert.equal(captured.searchParams.get("start"), "2024");
  assert.equal(captured.searchParams.get("end"), "2024");
  assert.equal(captured.searchParams.get("community"), "AG");
  assert.equal(captured.searchParams.get("format"), "JSON");
  assert.equal(captured.searchParams.get("parameters").split(",").length, 5);
  globalThis.fetch = async () => ({ ok: false, status: 422, json: async () => ({ messages: ["Requested period unavailable"] }) });
  await assert.rejects(fetchMonthlyPowerData({ ...request, longitude: 122.123 }), /422: Requested period unavailable/);
});
