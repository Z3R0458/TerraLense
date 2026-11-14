import { aggregateYearly } from "./nasaPower.js";
import { analyzeSeries } from "./analysis.js";

export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
export function daysInMonth(item) {
  return new Date(Date.UTC(item.year, item.month, 0)).getUTCDate();
}
export function rainfallMonths(series) {
  const daily = /^mm\s*\/\s*day$/i.test(series.parameterInfo.units);
  const monthly = /^mm\s*\/\s*month$/i.test(series.parameterInfo.units);
  if (!daily && !monthly)
    throw new Error(
      `Unsupported rainfall units: ${series.parameterInfo.units}`,
    );
  return series.observations.map((item) => ({
    ...item,
    value: Number.isFinite(item.value)
      ? item.value * (daily ? daysInMonth(item) : 1)
      : null,
  }));
}
export function weightedMean(observations) {
  const valid = observations.filter((item) => Number.isFinite(item.value));
  const days = valid.reduce((sum, item) => sum + daysInMonth(item), 0);
  return days
    ? valid.reduce((sum, item) => sum + item.value * daysInMonth(item), 0) /
        days
    : null;
}
export function monthlyClimatology(observations) {
  return MONTHS.map((date, index) => {
    const values = observations.filter(
      (item) => item.month === index + 1 && Number.isFinite(item.value),
    );
    return {
      date,
      month: index + 1,
      value: values.length
        ? values.reduce((sum, item) => sum + item.value, 0) / values.length
        : null,
      count: values.length,
    };
  });
}
export function rainfallDistribution(series, grouping = "months") {
  const annual = aggregateYearly(series.observations, series.parameterInfo);
  const completeYears = new Set(
    annual.observations
      .filter((item) => Number.isFinite(item.value))
      .map((item) => item.year),
  );
  const months = rainfallMonths(series).filter((item) =>
    completeYears.has(item.year),
  );
  const groups = grouping === "seasons" ? ["DJF", "MAM", "JJA", "SON"] : MONTHS;
  const values = groups.map((name) => ({ name, value: 0 }));
  months.forEach((item) => {
    const index =
      grouping === "seasons"
        ? Math.floor((item.month % 12) / 3)
        : item.month - 1;
    values[index].value += item.value;
  });
  return {
    values,
    completeYears: completeYears.size,
    total: values.reduce((sum, item) => sum + item.value, 0),
  };
}
export function annualSeries(series) {
  return aggregateYearly(series.observations, series.parameterInfo);
}
export function filterDataset(dataset, start, end) {
  return {
    ...dataset,
    startYear: start,
    endYear: end,
    series: Object.fromEntries(
      Object.entries(dataset.series).map(([id, series]) => [
        id,
        {
          ...series,
          observations: series.observations.filter(
            (item) => item.year >= start && item.year <= end,
          ),
        },
      ]),
    ),
  };
}
const fmt = (value, digits = 2) =>
  Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: digits })
    : "unavailable";
export function climateMetrics(dataset) {
  return Object.values(dataset.series).map((series) => {
    const rain = series.parameter === "PRECTOTCORR";
    const valid = series.observations.filter((item) =>
      Number.isFinite(item.value),
    );
    const value = rain
      ? valid.length
        ? rainfallMonths(series).reduce(
            (sum, item) => sum + (item.value ?? 0),
            0,
          )
        : null
      : weightedMean(series.observations);
    const yearly = annualSeries(series);
    const analysis = analyzeSeries(
      yearly.observations,
      { ...series.parameterInfo, units: yearly.units },
      "yearly",
    );
    return {
      id: series.parameter,
      name: rain
        ? "Total precipitation"
        : `Average ${series.parameterInfo.shortName.toLowerCase()}`,
      value,
      units: rain ? "mm" : series.parameterInfo.units,
      observations: series.observations,
      note: rain
        ? `${valid.length} available months${valid.length < series.observations.length ? " / partial total" : ""}`
        : "Weighted by calendar days",
      trend: Number.isFinite(analysis.slope)
        ? `${analysis.slope > 0 ? "+" : ""}${fmt(analysis.slope, 3)} ${yearly.units}/yr; ${analysis.significant ? "p < 0.05" : "p >= 0.05"}`
        : "Not enough complete years for a trend",
    };
  });
}
export function climateInsights(dataset) {
  const items = [];
  const extremes = (id, icon, title, kind, adjective) => {
    const series = dataset.series[id],
      annual = annualSeries(series);
    const valid = annual.observations.filter((item) =>
      Number.isFinite(item.value),
    );
    if (!valid.length)
      return {
        icon,
        title,
        kind,
        text: "No complete years are available. Annual comparisons exclude years with missing months.",
      };
    const sorted = [...valid].sort((a, b) => a.value - b.value),
      low = sorted[0],
      high = sorted.at(-1);
    const label = adjective || ["Lowest", "Highest"];
    return {
      icon,
      title,
      kind,
      text: `${label[1]}: ${high.year} (${fmt(high.value)} ${annual.units}). ${label[0]}: ${low.year} (${fmt(low.value)} ${annual.units}). Based on ${valid.length} complete year${valid.length === 1 ? "" : "s"} in ${dataset.startYear}-${dataset.endYear}. Tied years may share these values.`,
    };
  };
  items.push(
    extremes(
      "T2M",
      "temperature",
      "The warmest and coolest years",
      "Historical observations",
      ["Coolest", "Warmest"],
    ),
  );
  items.push(
    extremes(
      "PRECTOTCORR",
      "rain",
      "When rainfall reached its extremes",
      "Historical observations",
      ["Driest", "Wettest"],
    ),
  );
  const temp = dataset.series.T2M,
    tempYears = annualSeries(temp),
    trend = analyzeSeries(
      tempYears.observations,
      { ...temp.parameterInfo, units: tempYears.units },
      "yearly",
    );
  items.push({
    icon: "chart",
    title: "The longer temperature pattern",
    kind: "Statistical trend",
    text:
      trend.slope === null
        ? "At least three complete years are needed for an annual trend estimate. Short records cannot establish a long-term climate trend."
        : `Theil-Sen estimate: ${fmt(trend.slope, 3)} ${tempYears.units}/year (Mann-Kendall p = ${fmt(trend.pValue, 4)}). ${trend.significant ? "Evidence meets the 0.05 threshold." : "Evidence does not meet the 0.05 threshold."} This describes the selected history, not future climate; serial correlation can affect significance.`,
  });
  const cycle = monthlyClimatology(
    rainfallMonths(dataset.series.PRECTOTCORR),
  ).filter((item) => Number.isFinite(item.value));
  const peak = [...cycle].sort((a, b) => b.value - a.value)[0];
  items.push({
    icon: "calendar",
    title: "A rhythm through the calendar",
    kind: "Monthly climatology",
    text: peak
      ? `${peak.date} has the highest mean monthly rainfall total (${fmt(peak.value)} mm across ${peak.count} available years). Calendar-month averages use available observations; coverage can differ by month. Local wet and dry seasons vary by location.`
      : "No valid rainfall months are available for a seasonal comparison.",
  });
  items.push(
    extremes(
      "ALLSKY_SFC_SW_DWN",
      "sun",
      "Changes in available solar energy",
      "Historical observations",
    ),
  );
  items.push(
    extremes(
      "RH2M",
      "humidity",
      "Humidity across the years",
      "Historical observations",
    ),
  );
  return items;
}
