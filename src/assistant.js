export function createAssistantAnswer(question, context) {
  if (!context?.dataset || !context?.analysis) {
    return "No NASA POWER dataset has been loaded yet, so I cannot answer with measurements or statistical results.";
  }
  const { location, variable, startYear, endYear, analysis, dataset } = context;
  const slope = format(analysis.slope);
  const change = format(analysis.totalChange);
  if (question === "pvalue") {
    return analysis.pValue == null
      ? "There are not enough valid observations to report a reliable Mann-Kendall p-value."
      : `For ${location.name}, the Mann-Kendall p-value is ${format(analysis.pValue, 4)}. In this app, p < 0.05 is treated as statistically significant evidence of a monotonic trend, not proof of causation.`;
  }
  if (question === "limits") {
    return `Key limitations: the request is a single coordinate point, ${variable.id} is a NASA POWER ${variable.source} parameter, monthly values can be seasonal and autocorrelated, and the current comparison does not formally test whether locations differ from each other. Missing values: ${dataset.missingCount}.`;
  }
  return `For ${location.name} (${startYear}-${endYear}), ${variable.label} has an estimated Theil-Sen slope of ${slope} ${variable.units}/year and an estimated total change of ${change} ${variable.units}. ${analysis.interpretation}`;
}

function format(value, digits = 3) {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : "not available";
}
