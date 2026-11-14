const ENDPOINT = "https://power.larc.nasa.gov/api/temporal/monthly/point";
const cache = new Map();
const source = "NASA POWER monthly point API (MERRA-2 meteorology / CERES solar products)";
export const POWER_PARAMETERS = Object.fromEntries([
  ["T2M", "Temperature", "Air temperature at 2 meters"],
  ["PRECTOTCORR", "Precipitation", "Corrected precipitation"],
  ["RH2M", "Relative humidity", "Relative humidity at 2 meters"],
  ["ALLSKY_SFC_SW_DWN", "Solar radiation", "All sky surface shortwave downward radiation"],
  ["WS2M", "Wind speed", "Wind speed at 2 meters"],
].map(([id, shortName, label]) => [id, { id, shortName, label, units: "", source }]));

export function validatePowerRequest({ latitude, longitude, startYear, endYear, parameter = "T2M" }) {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error("Enter latitude from -90 to 90 and longitude from -180 to 180.");
  const latest = new Date().getUTCFullYear() - 1;
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || startYear < 1981 || endYear > latest || startYear > endYear) throw new Error(`Choose a valid historical year range between 1981 and ${latest}.`);
  if (!POWER_PARAMETERS[parameter]) throw new Error(`Unsupported POWER parameter: ${parameter}`);
}

export async function fetchMonthlyPowerData(request) {
  validatePowerRequest(request);
  const { latitude, longitude, startYear, endYear, parameter = "T2M" } = request;
  const query = new URLSearchParams({ parameters: Object.keys(POWER_PARAMETERS).join(","), community: "AG", format: "JSON", latitude, longitude, start: startYear, end: endYear });
  const url = `${ENDPOINT}?${query}`;
  if (cache.has(url)) return selectPowerParameter(cache.get(url), parameter);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    let raw;
    try { raw = await response.json(); } catch { throw new Error(`NASA POWER returned an invalid response (HTTP ${response.status}). Try again shortly.`); }
    if (!response.ok) throw new Error(`NASA POWER HTTP ${response.status}: ${Array.isArray(raw.messages) ? raw.messages.join(" ") : "The selected period or location could not be retrieved."}`);
    const dataset = normalizePowerResponse(raw, { ...request, parameter, url, retrievedAt: new Date().toISOString() });
    cache.set(url, dataset);
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    return dataset;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("NASA POWER took too long to respond. Try again or select a shorter period.");
    if (error instanceof TypeError) throw new Error("Could not reach NASA POWER. Check your connection and try again.");
    throw error;
  } finally { clearTimeout(timer); }
}

export function normalizePowerResponse(raw, request) {
  const series = {};
  const fill = raw?.header?.fill_value ?? -999;
  for (const [id, defaults] of Object.entries(POWER_PARAMETERS)) {
    const block = raw?.properties?.parameter?.[id];
    if (!block || typeof block !== "object") throw new Error(`NASA POWER response did not include ${id}.`);
    const metadata = raw?.parameters?.[id];
    if (!metadata?.units) throw new Error(`NASA POWER response is missing units for ${id}.`);
    const observations = [];
    for (let year = request.startYear; year <= request.endYear; year++) {
      for (let month = 1; month <= 12; month++) {
        const mm = String(month).padStart(2, "0");
        const key = `${year}${mm}`;
        const value = block[key];
        observations.push({ key, date: `${year}-${mm}`, year, month, yearDecimal: year + (month - 0.5) / 12,
          value: typeof value === "number" && Number.isFinite(value) && value !== fill && value !== -999 ? value : null });
      }
    }
    series[id] = { parameter: id, parameterInfo: { ...defaults, label: metadata.longname || defaults.label, units: metadata.units }, observations,
      validCount: observations.filter(item => item.value !== null).length, missingCount: observations.filter(item => item.value === null).length };
  }
  if (!Object.values(series).some(item => item.validCount)) throw new Error("NASA POWER has no available observations for this location and historical period.");
  return selectPowerParameter({ latitude: request.latitude, longitude: request.longitude, startYear: request.startYear, endYear: request.endYear,
    sourceUrl: request.url, retrievedAt: request.retrievedAt, rawHeader: raw.header, messages: raw.messages || [], series }, request.parameter || "T2M");
}

export function selectPowerParameter(dataset, parameter) {
  return { ...dataset, ...dataset.series[parameter] };
}

export function aggregateYearly(observations, parameterInfo) {
  const groups = new Map();
  for (const item of observations) {
    if (!groups.has(item.year)) groups.set(item.year, []);
    groups.get(item.year).push(item);
  }
  const precipitation = parameterInfo.id === "PRECTOTCORR";
  const dailyRain = /^mm\s*\/\s*day$/i.test(parameterInfo.units);
  const monthlyRain = /^mm\s*\/\s*month$/i.test(parameterInfo.units);
  if (precipitation && !dailyRain && !monthlyRain) throw new Error(`Cannot aggregate precipitation units: ${parameterInfo.units}`);
  return { units: precipitation ? "mm/year" : parameterInfo.units,
    observations: [...groups].map(([year, items]) => {
      const complete = items.length === 12 && items.every(item => Number.isFinite(item.value));
      const days = month => new Date(Date.UTC(year, month, 0)).getUTCDate();
      const weighted = items.reduce((sum, item) => sum + (item.value ?? 0) * (monthlyRain ? 1 : days(item.month)), 0);
      const yearDays = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
      return { key: String(year), date: String(year), year, yearDecimal: year + 0.5, value: complete ? (precipitation ? weighted : weighted / yearDays) : null };
    }) };
}
