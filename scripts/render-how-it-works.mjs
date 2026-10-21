// Renders the drawings in docs/ (how-it-works, project-memory) to PDFs next to their HTML, and the
// project memory blueprint to the PNG the README shows, with headless Chrome or Chromium. Set CHROME_PATH if the browser is not in a usual place. Needs network access for the
// page's Google Fonts.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const docs = path.join(import.meta.dirname, "..", "docs");
const drawings = ["how-it-works", "project-memory"].map((name) => ({
  html: path.join(docs, name, `${name}.html`),
  pdf: path.join(docs, name, `${name}.pdf`),
}));

const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);
const chrome = candidates.find((candidate) => existsSync(candidate));
if (!chrome) {
  console.error("Chrome or Chromium not found; set CHROME_PATH.");
  process.exit(1);
}

for (const { html, pdf } of drawings) {
  execFileSync(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--no-pdf-header-footer",
      "--virtual-time-budget=10000",
      `--print-to-pdf=${pdf}`,
      pathToFileURL(html).href,
    ],
    { stdio: "ignore" },
  );
  // Chrome records the browser and OS it ran on and the render time; keep the committed file free of
  // the author's machine. Each value is replaced by one of the same length, so the PDF's byte offsets
  // stay valid.
  const sameLength = (value, replacement) =>
    replacement.padEnd(value.length, " ").slice(0, value.length);
  const scrubbed = readFileSync(pdf, "latin1")
    .replace(
      /(\/Creator \()((?:\\.|[^\\)])*)(\))/,
      (_, open, value, close) => open + sameLength(value, "Chrome") + close,
    )
    .replace(/(\/(?:CreationDate|ModDate) \(D:)(\d{14})/g, (_, key) => `${key}20000101000000`);
  writeFileSync(pdf, scrubbed, "latin1");
  console.log(`wrote ${path.relative(process.cwd(), pdf)}`);
}

// The README image: the blueprint's drawing alone (#figure), at 1.5x for sharp text.
const blueprint = path.join(docs, "project-memory", "project-memory.html");
const png = path.join(docs, "project-memory", "project-memory.png");
execFileSync(
  chrome,
  [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1.5",
    "--window-size=1560,1040",
    "--virtual-time-budget=10000",
    `--screenshot=${png}`,
    `${pathToFileURL(blueprint).href}#figure`,
  ],
  { stdio: "ignore" },
);
console.log(`wrote ${path.relative(process.cwd(), png)}`);
