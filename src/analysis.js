export function analyzeSeries(observations, parameterInfo = { units: "" }, resolution = "monthly") {
  const valid = observations.filter((item) => Number.isFinite(item.value));
  const values = valid.map((item) => item.value);
  const base = {
    validCount: valid.length,
    firstDate: valid[0]?.date || null,
    lastDate: valid.at(-1)?.date || null,
    mean: mean(values),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    slope: null,
    intercept: null,
    totalChange: null,
    direction: "insufficient",
    test: "Mann-Kendall",
    statistic: null,
    pValue: null,
    significant: false,
    interpretation: "Insufficient data for reliable trend assessment.",
    caveat:
      "Monthly observations may contain seasonality and serial correlation. This MVP uses a transparent Mann-Kendall test and Theil-Sen slope on monthly values; interpret p-values cautiously.",
  };
  if (resolution === "yearly") base.caveat = "Annual means are weighted by calendar days; precipitation uses annual totals. Incomplete years are excluded. Short series and serial correlation can limit trend inference.";
  if (valid.length < (resolution === "yearly" ? 3 : 24)) return base;

  const slope = theilSenSlope(valid);
  const intercept = median(valid.map((item) => item.value - slope * item.yearDecimal));
  const firstX = valid[0].yearDecimal;
  const lastX = valid.at(-1).yearDecimal;
  const mk = mannKendall(values);
  const direction = Math.abs(slope) < 1e-12 ? "flat" : slope > 0 ? "positive" : "negative";
  const significant = mk.pValue < 0.05;
  return {
    ...base,
    slope,
    intercept,
    totalChange: slope * (lastX - firstX),
    direction,
    statistic: mk.z,
    pValue: mk.pValue,
    significant,
    interpretation:
      significant
        ? `The estimated ${parameterInfo.shortName?.toLowerCase() || "variable"} trend is ${direction}, with statistically significant evidence of a monotonic trend at the 0.05 threshold.`
        : `The estimated ${parameterInfo.shortName?.toLowerCase() || "variable"} trend is ${direction}, but the available evidence does not meet the 0.05 significance threshold.`,
  };
}

export function theilSenSlope(points) {
  const slopes = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dx = points[j].yearDecimal - points[i].yearDecimal;
      if (dx !== 0) slopes.push((points[j].value - points[i].value) / dx);
    }
  }
  return median(slopes);
}

export function mannKendall(values) {
  let s = 0;
  for (let i = 0; i < values.length - 1; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      s += Math.sign(values[j] - values[i]);
    }
  }
  const ties = new Map();
  values.forEach((value) => ties.set(value, (ties.get(value) || 0) + 1));
  const n = values.length;
  const tieAdjustment = [...ties.values()].reduce((sum, count) => sum + count * (count - 1) * (2 * count + 5), 0);
  const variance = (n * (n - 1) * (2 * n + 5) - tieAdjustment) / 18;
  if (variance <= 0) return { s, z: 0, pValue: 1 };
  const z = s > 0 ? (s - 1) / Math.sqrt(variance) : s < 0 ? (s + 1) / Math.sqrt(variance) : 0;
  return { s, z, pValue: 2 * (1 - normalCdf(Math.abs(z))) };
}

export function comparePeriods(observations, periods) {
  const group = (start, end) => observations.filter((item) => item.year >= start && item.year <= end && Number.isFinite(item.value));
  const a = group(periods.aStart, periods.aEnd);
  const b = group(periods.bStart, periods.bEnd);
  if (a.length < 3 || b.length < 3) return { ok: false, message: "Insufficient data for one or both comparison periods." };
  const aMean = mean(a.map((item) => item.value));
  const bMean = mean(b.map((item) => item.value));
  return { ok: true, aMean, bMean, difference: bMean - aMean, aCount: a.length, bCount: b.length };
}

export function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function erf(x) {
  const sign = Math.sign(x) || 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
  return sign * y;
}
