import { createAssistantAnswer } from "./assistant.js";

export function buildCsv(context) {
  const { dataset } = context;
  const rows = [
    ["TerraLens export"],
    ["latitude", dataset.latitude],
    ["longitude", dataset.longitude],
    [
      "source",
      "NASA POWER monthly point API; original monthly values and metadata units",
    ],
    ["retrieved_at", dataset.retrievedAt],
    [],
    [
      "latitude",
      "longitude",
      "date",
      "parameter",
      "value",
      "units",
      "source_url",
    ],
    ...Object.values(dataset.series).flatMap((series) =>
      series.observations.map((item) => [
        dataset.latitude,
        dataset.longitude,
        item.date,
        series.parameter,
        item.value ?? "",
        series.parameterInfo.units,
        dataset.sourceUrl,
      ]),
    ),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

export function openPrintableReport(context) {
  const { startYear, endYear, analysis, dataset } = context;
  const location = {
    ...context.location,
    name: htmlText(context.location.name),
  };
  const variable = Object.fromEntries(
    Object.entries(context.variable).map(([key, value]) => [
      key,
      htmlText(value),
    ]),
  );
  const html = `<!doctype html><html><head><title>TerraLens Report</title><style>
    body{font-family:Arial,sans-serif;margin:32px;line-height:1.45;color:#122}
    h1{margin-bottom:0}.meta{color:#456}.box{border:1px solid #ccd;padding:14px;margin:14px 0}
  </style></head><body>
    <h1>TerraLens Investigation Report</h1>
    <p class="meta">Historical climate investigation using NASA POWER monthly point data.</p>
    <div class="box"><strong>Location:</strong> ${location.name} (${dataset.latitude.toFixed(4)}, ${dataset.longitude.toFixed(4)})<br>
    <strong>Variable:</strong> ${variable.label} (${variable.id}), ${variable.units}<br>
    <strong>Period:</strong> ${startYear}-${endYear}<br>
    <strong>Retrieved:</strong> ${new Date(dataset.retrievedAt).toLocaleString()}</div>
    <div class="box"><strong>Valid observations:</strong> ${analysis.validCount}<br>
    <strong>Trend method:</strong> Theil-Sen slope estimator<br>
    <strong>Slope:</strong> ${format(analysis.slope)} ${variable.units}/year<br>
    <strong>Estimated change:</strong> ${format(analysis.totalChange)} ${variable.units}<br>
    <strong>Mann-Kendall p-value:</strong> ${format(analysis.pValue, 4)}</div>
    <p>${htmlText(createAssistantAnswer("trend", context))}</p>
    <p><strong>Limitations:</strong> ${analysis.caveat}</p>
    <p><strong>Source:</strong> ${variable.source}. NASA POWER monthly point API: ${htmlText(dataset.sourceUrl)}</p>
    <script>window.addEventListener('load',()=>window.print())</script>
  </body></html>`;
  const report = window.open("", "_blank");
  if (!report)
    throw new Error(
      "Allow pop-ups for TerraLens to open the printable report.",
    );
  if (report) {
    report.opener = null;
    report.document.write(html);
    report.document.close();
  }
}

function htmlText(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function format(value, digits = 3) {
  return Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: digits })
    : "not available";
}
