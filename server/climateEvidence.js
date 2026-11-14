import { analyzeSeries } from "../src/analysis.js";
import { POWER_PARAMETERS } from "../src/nasaPower.js";
import {
  annualSeries,
  rainfallMonths,
  monthlyClimatology,
  weightedMean,
  filterDataset,
  rainfallDistribution,
} from "../src/climateData.js";
import { ApiError } from "./errors.js";

export function validateChart(chart, dataset) {
  if (!chart || typeof chart !== "object" || Array.isArray(chart))
    throw new ApiError(400, "INVALID_CHART", "Select a valid climate chart.");
  if (
    Object.keys(chart).some(
      (key) =>
        ![
          "type",
          "parameter",
          "resolution",
          "startYear",
          "endYear",
          "grouping",
        ].includes(key),
    )
  )
    throw new ApiError(
      400,
      "INVALID_CHART",
      "Chart context must not contain supplied measurements.",
    );
  const {
    type = "line",
    parameter = "T2M",
    resolution = "monthly",
    startYear = dataset.startYear,
    endYear = dataset.endYear,
    grouping = "months",
  } = chart;
  if (
    !["line", "bar", "area", "heatmap", "pie", "donut", "combined"].includes(
      type,
    ) ||
    !POWER_PARAMETERS[parameter] ||
    !["monthly", "yearly"].includes(resolution) ||
    !["months", "seasons"].includes(grouping) ||
    !Number.isInteger(startYear) ||
    !Number.isInteger(endYear) ||
    startYear > endYear ||
    startYear < dataset.startYear ||
    endYear > dataset.endYear
  )
    throw new ApiError(
      400,
      "INVALID_CHART",
      "The chart parameter, type, or period does not match the verified dataset.",
    );
  return {
    type,
    parameter,
    resolution: ["heatmap", "pie", "donut"].includes(type)
      ? "monthly"
      : resolution,
    startYear,
    endYear,
    grouping,
  };
}
const number = (value) =>
  Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: 6 })
    : "unavailable";
export function computeEvidence(dataset, chart, question = "") {
  const filtered = filterDataset(dataset, chart.startYear, chart.endYear),
    facts = [];
  const add = (id, text) => facts.push({ id, text });
  add(
    "context",
    `NASA POWER point ${dataset.latitude}, ${dataset.longitude}; loaded period ${dataset.startYear}-${dataset.endYear}; chart period ${chart.startYear}-${chart.endYear}. Retrieved ${dataset.retrievedAt}. Community AG. Gridded model/assimilation products, not station measurements.`,
  );
  add(
    "limitations",
    "Missing values are excluded, never zero-filled. Annual statistics require all 12 months. Means are weighted by calendar days. Rainfall daily rates are integrated over calendar days. Monthly seasonality and serial correlation can affect trend significance. Historical observations are not predictions.",
  );
  add(
    "chart",
    `Selected chart: ${chart.type}; parameter ${chart.parameter}; time scale ${chart.resolution}; ${chart.startYear}-${chart.endYear}. ${chart.type === "combined" ? "Temperature and rainfall use separate axes; monthly rainfall is converted to mm/month." : chart.type === "heatmap" ? "Colors show within-period values, not climatological anomalies." : ["pie", "donut"].includes(chart.type) ? "Slices are rainfall contributions from complete years only." : ""}`,
  );
  const requestedYears = new Set(
    (question.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number),
  );
  for (const [id, series] of Object.entries(filtered.series)) {
    const { units, shortName } = series.parameterInfo,
      valid = series.observations.filter((item) => Number.isFinite(item.value));
    const annual = annualSeries(series),
      complete = annual.observations.filter((item) =>
        Number.isFinite(item.value),
      );
    add(
      `${id}.coverage`,
      `${shortName} (${id}): ${valid.length} valid and ${series.observations.length - valid.length} missing months; ${complete.length} complete years. Original NASA units: ${units}.`,
    );
    add(
      `${id}.mean`,
      `${shortName} day-weighted mean across available months in ${chart.startYear}-${chart.endYear}: ${number(weightedMean(series.observations))} ${units}.`,
    );
    if (id === "PRECTOTCORR")
      add(
        `${id}.total`,
        `Precipitation total over ${valid.length} available months in ${chart.startYear}-${chart.endYear}: ${valid.length ? number(rainfallMonths(series).reduce((sum, item) => sum + (item.value ?? 0), 0)) : "unavailable"} mm.${valid.length < series.observations.length ? " This is a partial total because some months are missing." : ""}`,
      );
    const sortedMonths = [...valid].sort((a, b) => a.value - b.value);
    if (valid.length) {
      add(
        `${id}.minimum`,
        `${shortName} lowest monthly mean/rate: ${number(sortedMonths[0].value)} ${units} in ${sortedMonths[0].date}.`,
      );
      add(
        `${id}.maximum`,
        `${shortName} highest monthly mean/rate: ${number(sortedMonths.at(-1).value)} ${units} in ${sortedMonths.at(-1).date}.`,
      );
    }
    const sortedYears = [...complete].sort((a, b) => a.value - b.value);
    if (complete.length) {
      const low = sortedYears[0],
        high = sortedYears.at(-1);
      const lows = complete
          .filter((item) => item.value === low.value)
          .map((item) => item.year),
        highs = complete
          .filter((item) => item.value === high.value)
          .map((item) => item.year);
      add(
        `${id}.lowestYear`,
        `${shortName} lowest complete-year ${id === "PRECTOTCORR" ? "total" : "day-weighted mean"}: ${number(low.value)} ${annual.units}; year(s): ${lows.join(", ")}.`,
      );
      add(
        `${id}.highestYear`,
        `${shortName} highest complete-year ${id === "PRECTOTCORR" ? "total" : "day-weighted mean"}: ${number(high.value)} ${annual.units}; year(s): ${highs.join(", ")}.`,
      );
    } else
      add(
        `${id}.annualUnavailable`,
        `${shortName}: no complete years are available, so annual extremes and trends cannot be reported.`,
      );
    for (const item of annual.observations)
      add(
        `${id}.year.${item.year}`,
        `${shortName} ${item.year}: ${number(item.value)} ${annual.units}${item.value === null ? " (incomplete year; excluded from annual statistics)" : ""}.`,
      );
    const cycle = monthlyClimatology(
      id === "PRECTOTCORR" ? rainfallMonths(series) : series.observations,
    );
    for (const item of cycle)
      add(
        `${id}.calendar.${item.month}`,
        `${shortName}, ${item.date} calendar mean across ${item.count} available years: ${number(item.value)} ${id === "PRECTOTCORR" ? "mm/month" : units}. Coverage can differ by calendar month.`,
      );
    const trend = analyzeSeries(
      annual.observations,
      { ...series.parameterInfo, units: annual.units },
      "yearly",
    );
    add(
      `${id}.annualTrend`,
      trend.slope === null
        ? `${shortName}: insufficient complete years for an annual trend estimate (minimum 3).`
        : `${shortName} annual Theil-Sen slope: ${number(trend.slope)} ${annual.units}/year; estimated fitted change ${number(trend.totalChange)} ${annual.units}; Mann-Kendall p=${number(trend.pValue)}; ${trend.significant ? "meets" : "does not meet"} the 0.05 significance threshold. Based on ${trend.validCount} complete years. ${trend.caveat}`,
    );
    if (id === chart.parameter && chart.resolution === "monthly") {
      const monthlyTrend = analyzeSeries(
        series.observations,
        series.parameterInfo,
      );
      add(
        `${id}.monthlyTrend`,
        monthlyTrend.slope === null
          ? `${shortName}: fewer than 24 valid months; monthly trend is unavailable.`
          : `${shortName} monthly Theil-Sen slope ${number(monthlyTrend.slope)} ${units}/year; fitted change ${number(monthlyTrend.totalChange)} ${units}; Mann-Kendall p=${number(monthlyTrend.pValue)}. ${monthlyTrend.caveat}`,
      );
    }
    // Supply the structured selected graph and specifically requested years, not client readings.
    if (
      (id === chart.parameter && chart.resolution === "monthly") ||
      (chart.type === "combined" && ["T2M", "PRECTOTCORR"].includes(id)) ||
      requestedYears.size
    ) {
      const observations =
        chart.type === "combined" && id === "PRECTOTCORR"
          ? rainfallMonths(series)
          : series.observations;
      const relevant = observations.filter(
        (item) =>
          (id === chart.parameter && chart.resolution === "monthly") ||
          (chart.type === "combined" && ["T2M", "PRECTOTCORR"].includes(id)) ||
          requestedYears.has(item.year),
      );
      for (const item of relevant)
        add(
          `${id}.month.${item.date}`,
          `${shortName}, ${item.date}: ${number(item.value)} ${chart.type === "combined" && id === "PRECTOTCORR" ? "mm/month" : units}${item.value === null ? " (missing)" : ""}.`,
        );
    }
  }
  if (["pie", "donut"].includes(chart.type)) {
    const distribution = rainfallDistribution(
      filtered.series.PRECTOTCORR,
      chart.grouping,
    );
    for (const item of distribution.values)
      add(
        `rainfallShare.${item.name}`,
        `${item.name}: ${number(item.value)} mm, ${distribution.total > 0 ? number((item.value / distribution.total) * 100) : "unavailable"}% of rainfall across ${distribution.completeYears} complete years. Calendar groups do not define local wet/dry seasons.`,
      );
  }
  return facts;
}
