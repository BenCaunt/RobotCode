import type { Tile } from "./tile.ts";

// This page also runs in Robot Code's opaque-origin HTML preview. All inputs travel with the page.
export function renderTile(tile: Tile): string {
  const title = tile.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const bindings = new Set<string>();
  for (const widget of tile.rows.flat()) {
    bindings.add(widget.source);
    if (widget.kind === "map" && widget.background) bindings.add(widget.background);
  }
  const sources = Object.fromEntries([...bindings].map((id) => [id, tile.sources[id]]));
  const encoded = Buffer.from(JSON.stringify({ ...tile, sources }), "utf8").toString("base64");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><title>${title}</title><style>${styles}</style></head><body>
<main>
<header><div><p id="subtitle"></p><h1 id="title"></h1></div><span class="clock" id="time"></span></header>
<div id="rows"></div>
<footer><button id="play" aria-label="Play recording" title="Play recording">▶</button>
<input id="seek" type="range" aria-label="Recording time in seconds" step="any"><span class="clock" id="end"></span></footer>
</main><script type="application/octet-stream" id="recording">${encoded}</script><script>${client}</script></body></html>`;
}

const styles = `
* {
  box-sizing: border-box;
}
html {
  color-scheme: light dark;
}
body {
  margin: 0;
  color: var(--foreground, light-dark(#19292a, #e8f2ee));
  font: 14px var(--font-sans, system-ui, sans-serif);
  background: var(--background, light-dark(#f5f7f5, #11191a));
}
main {
  max-width: 1050px;
  margin: auto;
  padding: clamp(12px, 2.5vw, 24px);
}
header,
footer,
.widget-heading,
.caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
header {
  padding: 2px 0 16px;
  border-bottom: 1px solid var(--border, light-dark(#cbd6d1, #344542));
}
h1 {
  margin: 0;
  font-size: clamp(22px, 4vw, 34px);
  font-weight: 640;
  line-height: 1.12;
  letter-spacing: -0.045em;
}
#subtitle,
.caption,
footer {
  color: var(--muted-foreground, light-dark(#516364, #a5b9b6));
}
#subtitle {
  font: 11px var(--font-mono, monospace);
  margin: 0 0 7px;
  letter-spacing: 0.035em;
}
.clock,
output,
.caption {
  font: 12px var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
}
#time {
  font-size: 16px;
  color: var(--foreground, inherit);
}
.row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr));
  gap: clamp(15px, 3vw, 28px);
  margin: 14px 0 18px;
}
section {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.widget-heading,
.caption {
  padding: 6px 0;
}
.widget-heading {
  min-height: 32px;
}
h2 {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
}
output {
  color: var(--muted-foreground, inherit);
  text-align: right;
}
.stage {
  flex: 1 0 auto;
  position: relative;
  height: 156px;
  background: #162124;
  overflow: hidden;
  color: #d9e6e1;
}
.map .stage {
  height: clamp(170px, 30vw, 260px);
}
.plot .stage {
  color: var(--muted-foreground, light-dark(#526767, #b6cac4));
  background: transparent;
}
.stage svg,
.stage img {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}
.stage img {
  object-fit: contain;
}
.stage img[hidden] {
  display: none;
}
.stage span {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font: 12px var(--font-mono, monospace);
}
.stage span[hidden] {
  display: none;
}
.caption {
  min-height: 24px;
  font-size: 11px;
  letter-spacing: 0.025em;
  line-height: 1.3;
}
.plot svg {
  cursor: crosshair;
}
footer {
  gap: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border, light-dark(#cbd6d1, #344542));
}
button {
  width: 34px;
  height: 30px;
  border: 1px solid var(--border, #657675);
  border-radius: 7px;
  background: var(--card, transparent);
  color: inherit;
  cursor: pointer;
}
input {
  flex: 1;
  min-width: 40px;
  accent-color: light-dark(#29766f, #80d6bf);
}
:focus-visible {
  outline: 2px solid var(--ring, #5fb99f);
  outline-offset: 2px;
}
@media (max-width: 400px) {
  main {
    padding: 10px;
  }
  .row {
    gap: 14px;
  }
  .stage {
    height: 136px;
  }
}
`;

const client = String.raw`
"use strict";
const tile = JSON.parse(
  new TextDecoder().decode(
    Uint8Array.from(atob(document.querySelector("#recording").textContent), (c) => c.charCodeAt(0)),
  ),
);
const seek = document.querySelector("#seek");
const play = document.querySelector("#play");
const updates = [];
const timed = tile.rows.flat().map((widget) => tile.sources[widget.source].samples);
const first = timed.reduce((min, rows) => Math.min(min, rows[0][0]), Infinity);
const last = timed.reduce((max, rows) => Math.max(max, rows[rows.length - 1][0]), -Infinity);
let time = Math.max(first, Math.min(last, tile.initialTime ?? first));
let timer;
function element(tag, parent, text, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}
function svgNode(tag, parent, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  parent.append(node);
  return node;
}
function number(value) {
  return Number(value.toFixed(2)).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function seconds(value) {
  return number(value) + " s";
}
// Latest observation at or before the cursor. Different sources may have different sample rates.
function latest(rows, t) {
  let low = 0,
    high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid][0] <= t) low = mid + 1;
    else high = mid;
  }
  return rows[low - 1];
}
function drawTime(t, report = true) {
  time = Math.max(first, Math.min(last, t));
  seek.value = time;
  document.querySelector("#time").textContent = seconds(time);
  for (const update of updates) update(time);
  if (report && window.parent !== window)
    window.parent.postMessage({ type: "robot-code.tile.cursor", seconds: time }, "*");
}
function pause() {
  clearInterval(timer);
  timer = undefined;
  play.textContent = "▶";
  play.setAttribute("aria-label", "Play recording");
  play.title = "Play recording";
}
function camera(source, stage, readout, left, right) {
  const image = element("img", stage);
  image.alt = stage.parentNode.querySelector("h2").textContent;
  const empty = element("span", stage, "Awaiting first frame");
  left.textContent = source.samples.length + " frames";
  let displayed;
  return (t) => {
    const row = latest(source.samples, t);
    if (row !== displayed) {
      if (row) image.src = row[1];
      else image.removeAttribute("src");
      displayed = row;
    }
    empty.hidden = !!row;
    image.hidden = !row;
    readout.textContent = row ? seconds(row[0]) : "…";
    right.textContent = row ? seconds(t - row[0]) + " old" : "";
  };
}
function graph(widget, source, stage, readout, left, right) {
  const map = widget.kind === "map";
  const raster = widget.background && tile.sources[widget.background];
  const rows = source.samples;
  const svg = svgNode("svg", stage, { role: "img", "aria-label": widget.title });
  const color = map ? "#abf3ca" : "var(--chart-2,light-dark(#18786e,#7cd8be))";
  const xIndex = map ? 1 : 0,
    yIndex = map ? 2 : 1;
  let minX = map ? Infinity : first,
    maxX = map ? -Infinity : last,
    minY = Infinity,
    maxY = -Infinity;
  for (const row of rows) {
    minX = Math.min(minX, row[xIndex]);
    maxX = Math.max(maxX, row[xIndex]);
    minY = Math.min(minY, row[yIndex]);
    maxY = Math.max(maxY, row[yIndex]);
  }
  if (raster) {
    minX = Math.min(minX, raster.bounds[0]);
    minY = Math.min(minY, raster.bounds[1]);
    maxX = Math.max(maxX, raster.bounds[2]);
    maxY = Math.max(maxY, raster.bounds[3]);
  }
  if (map) {
    left.textContent = source.frame;
    right.textContent = source.unit;
  } else {
    left.textContent = seconds(first);
    right.textContent = seconds(last);
  }
  const bg = raster && svgNode("image", svg, { href: raster.image, preserveAspectRatio: "none" });
  const grid = svgNode("path", svg, {
    fill: "none",
    stroke: map ? "#b6cfc2" : "currentColor",
    opacity: ".13",
  });
  const line = svgNode("polyline", svg, {
    fill: "none",
    stroke: color,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "stroke-width": 2,
  });
  const scaleText = svgNode("text", svg, {
    x: 5,
    y: 11,
    fill: "currentColor",
    "font-family": "monospace",
    "font-size": 10,
  });
  scaleText.textContent = map ? "" : number(maxY) + " " + source.unit;
  if (!map && minY !== maxY) {
    const lowerLabel = svgNode("text", svg, {
      x: 5,
      y: "99%",
      fill: "currentColor",
      "font-family": "monospace",
      "font-size": 10,
    });
    lowerLabel.textContent = number(minY) + " " + source.unit;
  }
  const cursor = map
    ? null
    : svgNode("line", svg, { stroke: "currentColor", opacity: ".56", "stroke-dasharray": "3 4" });
  const dot = svgNode("circle", svg, {
    r: 4.5,
    fill: color,
    stroke: map ? "#12231b" : "var(--card,#263634)",
    "stroke-width": 2,
  });
  let projectX, projectY;
  function update(t) {
    const row = latest(rows, t);
    dot.style.display = row ? "" : "none";
    if (row) {
      dot.setAttribute("cx", projectX(row[xIndex]));
      dot.setAttribute("cy", projectY(row[yIndex]));
      readout.textContent =
        (map ? number(row[1]) + ", " : "") + number(row[yIndex]) + " " + source.unit;
    } else readout.textContent = "…";
    if (cursor) {
      cursor.setAttribute("x1", projectX(t));
      cursor.setAttribute("x2", projectX(t));
    }
  }
  function resize() {
    const width = Math.max(stage.clientWidth, 1),
      height = Math.max(stage.clientHeight, 1),
      padding = 14;
    const sx = Math.max(1, width - 2 * padding) / (maxX - minX || 1);
    const sy = Math.max(1, height - 2 * padding) / (maxY - minY || 1);
    const scaleX = map ? Math.min(sx, sy) : sx,
      scaleY = map ? Math.min(sx, sy) : sy;
    projectX = (x) => width / 2 + (x - (minX + maxX) / 2) * scaleX;
    projectY = (y) => height / 2 - (y - (minY + maxY) / 2) * scaleY;
    svg.setAttribute("viewBox", [0, 0, width, height].join(" "));
    if (map) {
      const raw = Math.max(1, width / 6) / scaleX;
      const base = 10 ** Math.floor(Math.log10(raw));
      const length = (raw / base >= 5 ? 5 : raw / base >= 2 ? 2 : 1) * base;
      right.textContent = number(length) + " " + source.unit;
      right.style.borderTop = "1px solid currentColor";
      right.style.width = length * scaleX + "px";
      right.style.textAlign = "right";
      right.style.whiteSpace = "nowrap";
    }
    if (bg) {
      const [x0, y0, x1, y1] = raster.bounds;
      bg.setAttribute("x", projectX(x0));
      bg.setAttribute("y", projectY(y1));
      bg.setAttribute("width", (x1 - x0) * scaleX);
      bg.setAttribute("height", (y1 - y0) * scaleY);
    }
    let lines = "";
    for (let i = 1; i < 5; i++)
      lines += "M0 " + (height * i) / 5 + "H" + width + "M" + (width * i) / 5 + " 0V" + height;
    grid.setAttribute("d", lines);
    line.setAttribute(
      "points",
      rows
        .map((row) => projectX(row[xIndex]).toFixed(2) + "," + projectY(row[yIndex]).toFixed(2))
        .join(" "),
    );
    if (cursor) {
      cursor.setAttribute("y1", 0);
      cursor.setAttribute("y2", height);
    }
    update(time);
  }
  resize();
  new ResizeObserver(resize).observe(stage);
  if (!map)
    svg.addEventListener("click", (event) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 28) return;
      pause();
      drawTime(first + ((last - first) * (event.clientX - rect.left - 14)) / (rect.width - 28));
    });
  return update;
}
document.querySelector("#title").textContent = tile.title;
document.querySelector("#subtitle").textContent = tile.subtitle ?? "";
for (const widgets of tile.rows) {
  const row = element("div", document.querySelector("#rows"), undefined, "row");
  for (const widget of widgets) {
    const section = element("section", row, undefined, widget.kind);
    const head = element("div", section, undefined, "widget-heading");
    element("h2", head, widget.title);
    const value = element("output", head);
    const stage = element("div", section, undefined, "stage");
    const caption = element("div", section, undefined, "caption");
    const left = element("span", caption),
      right = element("span", caption);
    const source = tile.sources[widget.source];
    updates.push(
      widget.kind === "camera"
        ? camera(source, stage, value, left, right)
        : graph(widget, source, stage, value, left, right),
    );
  }
}
seek.min = first;
seek.max = last;
seek.disabled = first === last;
play.disabled = seek.disabled;
document.querySelector("#end").textContent = seconds(last);
seek.addEventListener("input", () => {
  pause();
  drawTime(Number(seek.value));
});
play.addEventListener("click", () => {
  if (timer !== undefined) {
    pause();
    return;
  }
  if (time >= last) drawTime(first);
  const started = performance.now(),
    initial = time;
  play.textContent = "Ⅱ";
  play.setAttribute("aria-label", "Pause recording");
  play.title = "Pause recording";
  timer = setInterval(() => {
    drawTime(initial + (performance.now() - started) / 1000);
    if (time >= last) pause();
  }, 80);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});
window.addEventListener("message", (event) => {
  if (
    event.source === window.parent &&
    event.data?.type === "robot-code.tile.restore" &&
    Number.isFinite(event.data.seconds)
  )
    drawTime(event.data.seconds, false);
});
drawTime(time, false);
`;
