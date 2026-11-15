import test from "node:test";
import assert from "node:assert/strict";
import { POWER_PARAMETERS } from "../src/nasaPower.js";

function nasaResponse(year) {
  return {
    header: { fill_value: -999 },
    properties: {
      parameter: Object.fromEntries(
        Object.keys(POWER_PARAMETERS).map((id) => [id, { [`${year}01`]: 20 }]),
      ),
    },
    parameters: Object.fromEntries(
      Object.keys(POWER_PARAMETERS).map((id) => [
        id,
        { units: id === "PRECTOTCORR" ? "mm/day" : "NASA unit", longname: id },
      ]),
    ),
  };
}

test("NASA charts fall back to direct NASA fetch when Vercel assistant storage is unavailable", async () => {
  const originalFetch = globalThis.fetch,
    originalDocument = globalThis.document,
    year = 2023;
  let nasaRequests = 0;
  globalThis.document = { baseURI: "https://terralens.example/" };
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/assistant/session"))
      return new Response(
        JSON.stringify({
          error: {
            code: "STORAGE_UNAVAILABLE",
            message: "Shared assistant storage is unavailable.",
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    if (String(url).includes("power.larc.nasa.gov")) {
      nasaRequests++;
      return new Response(JSON.stringify(nasaResponse(year)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const { fetchVerifiedPowerData } = await import(
      `../src/assistantClient.js?storage-fallback=${Date.now()}`
    );
    const result = await fetchVerifiedPowerData({
      latitude: 12.345,
      longitude: -45.678,
      startYear: year,
      endYear: year,
      parameter: "T2M",
    });
    assert.equal(result.backendUnavailable, true);
    assert.equal(result.backendError, "STORAGE_UNAVAILABLE");
    assert.equal(result.dataset.startYear, year);
    assert.equal(result.dataset.latitude, 12.345);
    assert.equal(nasaRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
