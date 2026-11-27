export interface PanelRow {
  label: string;
  act?: (fraction: number) => void;
  value?: number;
  id?: string;
  active?: boolean;
  detail?: string;
  style?: "travel" | "primary" | "secondary" | "choice";
  icon?: "yard" | "garage" | "rooms" | "comfort" | "camera" | "map" | "find" | "fit" | "service";
}
export interface PanelPage {
  title: string;
  lines: string[];
  rows: PanelRow[];
  corners?: readonly (readonly number[])[];
  planEdge?: number;
  wallPicker?: {
    walls: { index: number; x: number; z: number; picked: boolean; enabled: boolean }[];
    openings: { x: number; z: number; kind: "door" | "window" }[];
    choose: (index: number) => void;
  };
  keyboard?: {
    text: string;
    placeholder: string;
    keys: readonly (readonly PanelKey[])[];
    status?: string;
    resultSlots?: number;
  };
  back?: () => void;
  close?: () => void;
}

export interface PanelKey extends PanelRow {
  id: string;
  span?: number;
  keyTone?: "utility" | "confirm";
}

export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelButton extends PanelRow, PanelRect {
  key: string;
  kind: "row" | "back" | "home" | "exit" | "close";
  keycap?: true;
  keyTone?: PanelKey["keyTone"];
}

export interface PanelLayout {
  title: string;
  height: number;
  body: PanelRect;
  track: PanelRect;
  maxScroll: number;
  lines: string[];
  plan: PanelRect | null;
  corners: PanelPage["corners"];
  planEdge?: number;
  wallTargets: PanelButton[];
  openings: { x: number; y: number; kind: "door" | "window" }[];
  keyboard: {
    field: PanelRect;
    text: string;
    placeholder: string;
    status?: string;
    statusY: number;
  } | null;
  rows: PanelButton[];
  footer: PanelButton[];
}

export const PANEL_WIDTH = 896;
const MAX_HEIGHT = 948;
const INSET = 30;
const HEADER = 101;
const FOOTER = 93;
const NORMAL_ROW = 74;
const SLIDER_ROW = 86;
const GAP = 10;
const SCROLL_GUTTER = 42;
const LINE_HEIGHT = 32;
const KEY_HEIGHT = 55;
const KEY_GAP = 7;

export function contains(rect: PanelRect, x: number, y: number, slack = 0) {
  return x >= rect.x - slack && y >= rect.y - slack &&
    x <= rect.x + rect.width + slack && y <= rect.y + rect.height + slack;
}

function wrap(text: string, width: number, measure: (text: string) => number) {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? line + " " + word : word;
    if (line && measure(next) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export function layoutPanel(
  page: PanelPage,
  measure: (text: string) => number,
  home: () => void,
  exit: () => void,
): PanelLayout {
  const fullWidth = PANEL_WIDTH - 2 * INSET;
  const backIndex = page.rows.findIndex(
    (row) => row.act && (row.id === "back" || /^(Back(?: to .+)?|Survey tools)$/.test(row.label)),
  );
  const promoted = backIndex >= 0 && !page.back ? page.rows[backIndex] : undefined;
  const back = page.back ?? promoted?.act;
  const items = page.rows.filter((item) => item !== promoted);
  const arrangeBody = (rowWidth: number) => {
    let plan = page.corners?.length
      ? { x: INSET + rowWidth - 218, y: HEADER + 13, width: 218, height: 146 }
      : null;
    const infoWidth = plan && !page.wallPicker ? plan.x - INSET - 24 : rowWidth;
    const lines = page.lines.flatMap((line) => wrap(line, infoWidth - 24, measure));
    const textHeight = lines.length ? lines.length * LINE_HEIGHT + 24 : 0;
    if (page.wallPicker) plan = { x: INSET, y: HEADER + textHeight + 8, width: rowWidth, height: 350 };
    const intro = page.wallPicker ? textHeight + 366 : Math.max(plan ? plan.height + 24 : 0, textHeight);
    let cursor = HEADER + intro + 8;
    const rows: PanelButton[] = [];
    let keyboard: PanelLayout["keyboard"] = null;
    if (page.keyboard) {
      const { text, placeholder, status, keys } = page.keyboard;
      const field = { x: INSET, y: cursor + 3, width: rowWidth, height: 62 };
      cursor += field.height + 16;
      const unit = (rowWidth - KEY_GAP * 9) / 10;
      for (const line of keys) {
        const widths = line.map((key) => unit * (key.span ?? 1));
        const width = widths.reduce((sum, value) => sum + value, 0) + KEY_GAP * (line.length - 1);
        let x = INSET + (rowWidth - width) / 2;
        for (const [index, key] of line.entries()) {
          const width = widths[index]!;
          rows.push({
            ...key,
            x,
            y: cursor,
            width,
            height: KEY_HEIGHT,
            kind: "row",
            keycap: true,
            key: page.title + "/key/" + key.id,
          });
          x += width + KEY_GAP;
        }
        cursor += KEY_HEIGHT + KEY_GAP;
      }
      keyboard = { field, text, placeholder, status, statusY: cursor + 28 };
      cursor += status === undefined ? 6 : 44;
    }
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      const next = items[index + 1];
      const pair =
        !!next &&
        next.style === item.style &&
        (item.style === "travel" || item.style === "secondary" || item.style === "choice");
      const width = pair ? (rowWidth - GAP) / 2 : rowWidth;
      const height =
        item.style === "travel"
          ? 177
          : item.style === "choice"
            ? 110
            : item.style === "primary"
              ? 90
              : item.value === undefined
                ? NORMAL_ROW
                : SLIDER_ROW;
      const add = (value: PanelRow, x: number, ordinal: number) =>
        rows.push({
          ...value,
          x,
          y: cursor,
          width,
          height,
          kind: "row",
          key:
            page.title +
            "/row/" +
            (value.id ?? (value.value === undefined ? value.label + "/" + ordinal : "slider-" + ordinal)),
        });
      add(item, INSET, index);
      if (pair) add(next, INSET + width + GAP, ++index);
      cursor += height + GAP;
    }
    cursor += Math.max(0, (page.keyboard?.resultSlots ?? 0) - items.length) * (NORMAL_ROW + GAP);
    return { plan, lines, rows, keyboard, contentHeight: Math.max(76, cursor - HEADER + 4), rowWidth };
  };
  const fullBody = arrangeBody(fullWidth);
  const { plan, lines, rows, keyboard, contentHeight, rowWidth } =
    fullBody.contentHeight > MAX_HEIGHT - HEADER - FOOTER
      ? arrangeBody(fullWidth - SCROLL_GUTTER)
      : fullBody;
  const height = Math.min(MAX_HEIGHT, HEADER + contentHeight + FOOTER);
  const project = plan && page.wallPicker && page.corners?.length ? planProjection(plan, page.corners) : null;
  const wallTargets: PanelButton[] = [];
  const openings: PanelLayout["openings"] = [];
  if (project && page.wallPicker) {
    const picker = page.wallPicker;
    for (const wall of picker.walls) {
      const [x,y] = project(wall.x,wall.z);
      wallTargets.push({ kind: "row", key: page.title + "/wall/" + wall.index, label: String(wall.index+1),
        act: wall.enabled ? () => picker.choose(wall.index) : undefined, active: wall.picked, keycap: true,
        x:x-19, y:y-19, width:38, height:38 });
    }
    for (const opening of picker.openings) {
      const [x,y] = project(opening.x,opening.z);
      openings.push({x,y,kind:opening.kind});
    }
  }
  const body: PanelRect = { x: INSET, y: HEADER, width: rowWidth, height: height - FOOTER - HEADER };
  const track: PanelRect = {
    x: PANEL_WIDTH - INSET - 23,
    y: body.y + 14,
    width: 24,
    height: body.height - 28,
  };
  const nav: Array<{ kind: "back" | "home" | "exit" | "close"; label: string; act: () => void }> = [
    ...(back ? [{ kind: "back" as const, label: "Back", act: () => back(0) }] : []),
    page.close
      ? { kind: "close", label: "Close menu", act: page.close }
      : { kind: "home", label: "Main menu", act: home },
    { kind: "exit", label: back ? "Exit headset" : "Exit immersive view", act: exit },
  ];
  const navWidth = (PANEL_WIDTH - INSET * 2 - (nav.length - 1) * GAP) / nav.length;
  const footer = nav.map((item, index): PanelButton => ({
    ...item,
    key: item.kind,
    x: INSET + (navWidth + GAP) * index,
    y: height - FOOTER + 16,
    width: navWidth,
    height: 55,
  }));
  return {
    title: page.title,
    height,
    body,
    track,
    maxScroll: contentHeight - body.height,
    lines,
    plan,
    corners: page.corners,
    planEdge: page.planEdge,
    wallTargets, openings,
    keyboard,
    rows,
    footer,
  };
}

export function visibleRow(layout: PanelLayout, row: PanelButton, offset: number): PanelButton | undefined {
  if (row.kind !== "row") return row;
  const top = Math.max(row.y - offset, layout.body.y);
  const bottom = Math.min(row.y - offset + row.height, layout.body.y + layout.body.height);
  if (bottom <= top) return undefined;
  return { ...row, y: top, height: bottom - top };
}

export function scrollThumb(layout: PanelLayout, offset: number): PanelRect {
  const { track, body, maxScroll } = layout;
  const height = Math.min(track.height, Math.max(52, track.height * body.height / (body.height + maxScroll)));
  return { ...track, y: track.y + (maxScroll ? offset / maxScroll * (track.height - height) : 0), height };
}

export function sliderRange(row: PanelRect): [number, number] {
  return [row.x + 23, row.x + row.width - 23];
}

function rounded(context: CanvasRenderingContext2D, rect: PanelRect, radius: number) {
  context.beginPath();
  context.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
}

function fill(context: CanvasRenderingContext2D, rect: PanelRect, radius: number, color: string | CanvasGradient) {
  context.fillStyle = color;
  rounded(context, rect, radius);
  context.fill();
}

function stroke(context: CanvasRenderingContext2D, rect: PanelRect, radius: number, color: string, width = 1) {
  context.strokeStyle = color;
  context.lineWidth = width;
  rounded(context, rect, radius);
  context.stroke();
}

function text(context: CanvasRenderingContext2D, value: string, x: number, y: number, width: number) {
  if (context.measureText(value).width <= width) {
    context.fillText(value, x, y);
    return;
  }
  let length = value.length;
  while (length > 0 && context.measureText(value.slice(0, length) + "…").width > width) length--;
  context.fillText(value.slice(0, length) + "…", x, y);
}

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function planProjection(box: PanelRect, points: NonNullable<PanelPage["corners"]>) {
  const xs = points.map((p) => p[0]!);
  const zs = points.map((p) => p[2]!);
  const minX = Math.min(...xs), minZ = Math.min(...zs);
  const width = Math.max(.01, Math.max(...xs) - minX);
  const height = Math.max(.01, Math.max(...zs) - minZ);
  const scale = Math.min((box.width - 43) / width, (box.height - 45) / height);
  return (x: number, z: number) => [
    box.x + (box.width - width * scale) / 2 + (x - minX) * scale,
    box.y + (box.height - height * scale) / 2 + (z - minZ) * scale,
  ] as const;
}
function paintPlan(c: CanvasRenderingContext2D, box: PanelRect, points: NonNullable<PanelPage["corners"]>, edge?: number, plain = false) {
  const project = planProjection(box, points);
  const plot = points.map(p => project(p[0]!, p[2]!));
  fill(c, box, 15, "#101c27");
  stroke(c, box, 15, "#364854", 1.3);
  c.strokeStyle = "#76d8c4";
  c.fillStyle = "#23464a";
  c.lineWidth = 2.5;
  c.beginPath();
  plot.forEach(([x, y], index) => index ? c.lineTo(x, y) : c.moveTo(x, y));
  c.closePath();
  c.fill();
  c.stroke();
  if (plain) return;
  if (edge !== undefined && plot[edge]) {
    const a = plot[edge]!, b = plot[(edge+1)%plot.length]!;
    c.strokeStyle = "#ffcc81";
    c.lineWidth = 8;
    c.beginPath(); c.moveTo(a[0],a[1]); c.lineTo(b[0],b[1]); c.stroke();
    return;
  }
  c.font = `650 16px ${FONT}`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  for (const [i, [x, y]] of plot.entries()) {
    c.fillStyle = "#143439";
    c.beginPath();
    c.arc(x, y, 11, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.fillStyle = "#e5faf2";
    c.fillText(String(i + 1), x, y + .5);
  }
  c.textAlign = "left";
  c.textBaseline = "alphabetic";
}

function drawArrow(c: CanvasRenderingContext2D, x: number, y: number, kind: PanelButton["kind"]) {
  c.beginPath();
  if (kind === "back") {
    c.moveTo(x + 8, y - 6); c.lineTo(x + 2, y); c.lineTo(x + 8, y + 6);
    c.moveTo(x + 2, y); c.lineTo(x + 17, y);
  } else if (kind === "home") {
    c.moveTo(x, y); c.lineTo(x + 9, y - 8); c.lineTo(x + 18, y);
    c.moveTo(x + 3, y - 2); c.lineTo(x + 3, y + 8); c.lineTo(x + 15, y + 8); c.lineTo(x + 15, y - 2);
  } else if (kind === "exit") {
    c.moveTo(x + 4, y - 8); c.lineTo(x, y - 8); c.lineTo(x, y + 8); c.lineTo(x + 4, y + 8);
    c.moveTo(x + 5, y); c.lineTo(x + 17, y);
    c.moveTo(x + 11, y - 6); c.lineTo(x + 17, y); c.lineTo(x + 11, y + 6);
  } else if (kind === "close") {
    c.moveTo(x + 3, y - 6); c.lineTo(x + 15, y + 6);
    c.moveTo(x + 15, y - 6); c.lineTo(x + 3, y + 6);
  } else {
    c.moveTo(x + 6, y - 7); c.lineTo(x + 13, y); c.lineTo(x + 6, y + 7);
  }
  c.strokeStyle = kind === "exit" ? "#e4a995" : "#99bdb9";
  c.lineCap = "round";
  c.lineJoin = "round";
  c.lineWidth = 2.6;
  c.stroke();
}

function polygon(c: CanvasRenderingContext2D, x: number, y: number, points: readonly (readonly [number, number])[], color: string) {
  c.fillStyle = color;
  c.beginPath();
  points.forEach(([dx, dy], index) => index ? c.lineTo(x + dx, y + dy) : c.moveTo(x + dx, y + dy));
  c.closePath();
  c.fill();
}

function travelArt(c: CanvasRenderingContext2D, x: number, y: number, icon: PanelRow["icon"], enabled: boolean) {
  c.save();
  c.globalAlpha = enabled ? 1 : .38;
  if (icon === "garage") {
    polygon(c, x, y, [[0, 104], [82, 79], [133, 95], [48, 126]], "#3a302d");
    polygon(c, x, y, [[8, 55], [56, 20], [102, 49], [99, 97], [12, 110]], "#a78f70");
    polygon(c, x, y, [[12, 54], [57, 21], [101, 49], [99, 96], [12, 110]], "#b8a386");
    polygon(c, x, y, [[101, 49], [127, 39], [125, 86], [99, 97]], "#806e5e");
    polygon(c, x, y, [[53, 16], [79, 6], [132, 39], [103, 54]], "#b99571");
    polygon(c, x, y, [[5, 55], [53, 16], [103, 54], [99, 61], [53, 29], [12, 60]], "#e3c7a3");
    polygon(c, x, y, [[26, 63], [85, 57], [85, 98], [26, 107]], "#473d38");
    for (let slat = 0; slat < 4; slat++) {
      const z = slat * 9;
      polygon(c, x, y, [[30, 65 + z], [81, 60 + z], [81, 66 + z], [30, 72 + z]], "#937e6a");
    }
  } else {
    polygon(c, x, y, [[0, 85], [72, 53], [133, 80], [65, 118]], "#23463f");
    polygon(c, x, y, [[0, 84], [72, 50], [133, 77], [65, 111]], "#5e8971");
    polygon(c, x, y, [[12, 83], [33, 74], [95, 94], [77, 104]], "#a7b597");
    polygon(c, x, y, [[67, 91], [88, 81], [107, 90], [87, 100]], "#c0c6a6");
    for (const [tx, ty, size] of [[31, 33, 23], [76, 23, 27], [108, 48, 18]] as const) {
      polygon(c, x + tx, y + ty, [[-3, 16], [3, 15], [3, 46], [-3, 49]], "#8c9777");
      polygon(c, x + tx, y + ty, [[0, -size], [size, 23], [0, 32], [-size, 23]], "#437766");
      polygon(c, x + tx, y + ty, [[0, -size], [0, 32], [-size, 23]], "#8db294");
    }
  }
  c.restore();
}

function drawToolIcon(c: CanvasRenderingContext2D, icon: PanelRow["icon"], x: number, y: number) {
  c.strokeStyle = "#a6cdc5";
  c.lineWidth = 2.6;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.beginPath();
  if (icon === "rooms") {
    c.rect(x, y, 28, 26);
    c.moveTo(x + 13, y);
    c.lineTo(x + 13, y + 17);
    c.moveTo(x + 13, y + 11);
    c.lineTo(x + 28, y + 11);
    c.moveTo(x, y + 19);
    c.lineTo(x + 7, y + 19);
  } else if (icon === "map") {
    c.moveTo(x, y + 7);
    c.lineTo(x + 10, y + 2);
    c.lineTo(x + 19, y + 7);
    c.lineTo(x + 29, y + 2);
    c.lineTo(x + 29, y + 22);
    c.lineTo(x + 19, y + 27);
    c.lineTo(x + 10, y + 22);
    c.lineTo(x, y + 27);
    c.closePath();
    c.moveTo(x + 10, y + 2);
    c.lineTo(x + 10, y + 22);
    c.moveTo(x + 19, y + 7);
    c.lineTo(x + 19, y + 27);
  } else if (icon === "find") {
    c.arc(x + 11, y + 10, 9, 0, 2 * Math.PI);
    c.moveTo(x + 18, y + 17);
    c.lineTo(x + 28, y + 27);
  } else if (icon === "fit") {
    c.moveTo(x, y + 7);
    c.lineTo(x + 14, y);
    c.lineTo(x + 28, y + 7);
    c.lineTo(x + 14, y + 14);
    c.closePath();
    c.lineTo(x, y + 20);
    c.lineTo(x + 14, y + 27);
    c.lineTo(x + 28, y + 20);
    c.lineTo(x + 28, y + 7);
    c.moveTo(x + 14, y + 14);
    c.lineTo(x + 14, y + 27);
  } else if (icon === "service") {
    c.roundRect(x + 2, y + 3, 24, 23, 3);
    c.moveTo(x + 7, y + 15);
    c.lineTo(x + 12, y + 20);
    c.lineTo(x + 21, y + 10);
  } else if (icon === "camera") {
    c.roundRect(x, y + 5, 29, 20, 4);
    c.moveTo(x + 7, y + 5);
    c.lineTo(x + 10, y + 1);
    c.lineTo(x + 19, y + 1);
    c.lineTo(x + 22, y + 5);
    c.moveTo(x + 19.5, y + 15);
    c.arc(x + 14.5, y + 15, 5, 0, Math.PI * 2);
  } else {
    c.moveTo(x, y + 6);
    c.lineTo(x + 29, y + 6);
    c.moveTo(x, y + 20);
    c.lineTo(x + 29, y + 20);
    c.moveTo(x + 9, y + 1);
    c.lineTo(x + 9, y + 11);
    c.moveTo(x + 21, y + 15);
    c.lineTo(x + 21, y + 25);
  }
  c.stroke();
}

function paintHomeButton(c: CanvasRenderingContext2D, row: PanelButton, rect: PanelRect) {
  const { x, y, width, height } = rect;
  if (row.style === "choice") {
    fill(c, rect, 14, row.active ? "#254d49" : "#202d40");
    stroke(c, rect, 14, row.active ? "#82d5b9" : "#577093", row.active ? 2.5 : 1.4);
    c.fillStyle = row.active ? "#a6eed0" : "#bbcce6";
    c.font = `640 30px ${FONT}`;
    text(c, row.label, x + 20, y + 41, width - 40);
    c.font = `510 21px ${FONT}`;
    c.fillStyle = "#d7e1e8";
    text(c, row.detail ?? "", x + 20, y + 78, width - 40);
    return;
  }
  if (row.style === "travel") {
    const yard = row.icon === "yard";
    const gradient = c.createLinearGradient(x, y, x + width, y + height);
    gradient.addColorStop(0, yard ? "#294940" : "#504039");
    gradient.addColorStop(1, yard ? "#1c342e" : "#332c2d");
    fill(c, rect, 14, gradient);
    stroke(c, rect, 14, yard ? "#597f6c" : "#816959", 1.5);
    travelArt(c, x + width - 159, y + 31, row.icon, !!row.act);
    c.fillStyle = row.act ? "#f2f7f4" : "#afbab9";
    c.font = `680 37px ${FONT}`;
    text(c, row.label, x + 23, y + 61, width - 170);
    c.fillStyle = yard ? "#a6c5b5" : "#d5b8a3";
    c.font = `510 21px ${FONT}`;
    text(c, row.act ? (row.detail ?? "") : "Unavailable", x + 24, y + 95, width - 165);
    if (row.act) drawArrow(c, x + 17, y + 133, "row");
    return;
  }
  const primary = row.style === "primary";
  fill(c, rect, 14, primary ? "#244746" : "#1b2936");
  stroke(c, rect, 14, primary ? "#689f95" : "#405669", primary ? 2 : 1.4);
  drawToolIcon(c, row.icon, x + 22, y + height / 2 - 13);
  c.fillStyle = "#edf6f9";
  c.font = `650 ${primary ? 32 : 24}px ${FONT}`;
  text(c, row.label, x + 68, y + height / 2 + (primary ? 11 : 8), width - (primary ? 127 : 90));
  if (primary) drawArrow(c, x + width - 37, y + height / 2, "row");
}

function paintKey(c: CanvasRenderingContext2D, row: PanelButton, rect: PanelRect) {
  const { x, y, width, height } = rect;
  const accent = !!row.act && (row.active || row.keyTone === "confirm");
  fill(c, rect, 11, accent ? "#24544c" : row.keyTone === "utility" ? "#233544" : "#2a4154");
  stroke(c, rect, 11, accent ? "#7bdaca" : row.act ? "#4f697e" : "#364b5c", 1.4);
  c.fillStyle = row.act ? (accent ? "#d6fff2" : "#f0f8fc") : "#859aa9";
  c.font = `${row.keyTone ? "640 23" : "660 30"}px ${FONT}`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(row.label, x + width / 2, y + height / 2 + 1, width - 10);
  c.textAlign = "left";
  c.textBaseline = "alphabetic";
}

function paintKeyboardField(
  c: CanvasRenderingContext2D,
  keyboard: NonNullable<PanelLayout["keyboard"]>,
  offset: number,
) {
  const { field, status, statusY, placeholder } = keyboard;
  const rect = { ...field, y: field.y - offset };
  fill(c, rect, 13, "#101f2b");
  stroke(c, rect, 13, "#5ba99b", 1.7);
  c.font = `550 32px ${FONT}`;
  const width = rect.width - 51;
  let value = keyboard.text;
  if (c.measureText(value).width > width) {
    let start = 1;
    while (start < value.length && c.measureText("…" + value.slice(start)).width > width) start++;
    value = "…" + value.slice(start);
  }
  c.fillStyle = value ? "#e9fbf8" : "#9bb2c1";
  text(c, value || placeholder, rect.x + 19, rect.y + 41, width);
  if (value)
    fill(
      c,
      { x: rect.x + 23 + c.measureText(value).width, y: rect.y + 16, width: 2, height: 29 },
      1,
      "#90e8d5",
    );
  if (status) {
    c.font = `550 22px ${FONT}`;
    c.fillStyle = "#aaccd1";
    text(c, status, rect.x + 6, statusY - offset, rect.width - 12);
  }
}

function paintButton(c: CanvasRenderingContext2D, row: PanelButton, offset = 0) {
  const y = row.y - offset;
  const { label, act, x, width, height, kind, value } = row;
  const active = row.active ?? /^(✓\s|Selected · )/.test(label);
  const rect = { x, y, width, height };
  if (row.keycap) {
    paintKey(c, row, rect);
    return;
  }
  if (kind !== "row") {
    fill(c, rect, 13, kind === "exit" ? "#33262b" : "#273645");
    stroke(c, rect, 13, kind === "exit" ? "#78504b" : "#42566b", 1.5);
    drawArrow(c, x + 16, y + height / 2, kind);
    c.fillStyle = kind === "exit" ? "#ffd7c5" : "#e6eef5";
    c.font = `650 23px ${FONT}`;
    text(c, label, x + 43, y + 35, width - 56);
    return;
  }
  if (row.style) {
    paintHomeButton(c, row, rect);
    return;
  }
  const gradient = c.createLinearGradient(x, y, x, y + height);
  gradient.addColorStop(0, active ? "#244945" : act ? "#293f52" : "#212e3b");
  gradient.addColorStop(1, active ? "#1d3c39" : act ? "#233647" : "#1d2834");
  fill(c, rect, 14, gradient);
  stroke(c, rect, 14, active ? "#70cbbb" : act ? "#456075" : "#344350", active ? 2 : 1.3);
  if (active) fill(c, { x: x + 6, y: y + 14, width: 4, height: height - 28 }, 2, "#78d6bd");
  let labelWidth = width - 82;
  if (row.detail) {
    c.font = `530 21px ${FONT}`;
    const badgeWidth = Math.min(width * 0.36, c.measureText(row.detail).width + 24);
    const badgeX = x + width - badgeWidth - 47;
    fill(c, { x: badgeX, y: y + 22, width: badgeWidth, height: 30 }, 5, "#1a2a37");
    c.fillStyle = "#b6c9d7";
    text(c, row.detail, badgeX + 12, y + 44, badgeWidth - 24);
    labelWidth -= badgeWidth;
  }
  c.fillStyle = act ? "#f2f7fc" : "#a9b9c7";
  c.font = `600 29px ${FONT}`;
  text(c, label.replace(/^✓\s+/, ""), x + 23, y + (value === undefined ? 47 : 36), labelWidth);
  if (value !== undefined) {
    const [start, end] = sliderRange(row);
    const fraction = Math.max(0, Math.min(1, value));
    const fillEnd = start + fraction * (end - start);
    fill(c, { x: start, y: y + 57, width: end - start, height: 7 }, 3.5, "#132431");
    if (fraction > 0)
      fill(c, { x: start, y: y + 57, width: fillEnd - start, height: 7 }, 3.5, act ? "#68c9b8" : "#66847f");
    fill(c, { x: fillEnd - 6, y: y + 53, width: 12, height: 15 }, 6, act ? "#b3f0df" : "#839e99");
  } else if (act) drawArrow(c, x + width - 38, y + height / 2, kind);
}

/** Draw the same screen-space rectangles the ray hit test uses. Only visible rows are rendered. */
export function paintPanel(
  c: CanvasRenderingContext2D,
  layout: PanelLayout,
  offset = 0,
  thumbHeld = false,
) {
  const { title, height, body, plan, corners, keyboard, rows, footer, track } = layout;
  c.clearRect(0, 0, PANEL_WIDTH, height);
  const gradient = c.createLinearGradient(0, 0, PANEL_WIDTH * 0.8, height);
  gradient.addColorStop(0, "#233a4a");
  gradient.addColorStop(0.35, "#172632");
  gradient.addColorStop(1, "#101a25");
  fill(c, { x: 1, y: 1, width: PANEL_WIDTH - 2, height: height - 2 }, 26, gradient);
  stroke(c, { x: 2, y: 2, width: PANEL_WIDTH - 4, height: height - 4 }, 25, "#546c7e", 2);
  fill(c, { x: INSET + 1, y: 22, width: 36, height: 4 }, 2, "#7ad2be");
  c.fillStyle = "#f6fbff";
  c.font = `700 44px ${FONT}`;
  text(c, title, INSET, 73, PANEL_WIDTH - INSET * 2);
  fill(c, { x: INSET, y: HEADER - 2, width: PANEL_WIDTH - INSET * 2, height: 1 }, 0.5, "#3d5262");

  c.save();
  c.beginPath();
  c.rect(INSET - 1, body.y, PANEL_WIDTH - INSET * 2 + 2, body.height);
  c.clip();
  c.font = `430 25px ${FONT}`;
  c.fillStyle = "#c8dae5";
  const largePlan = !!plan && plan.width === body.width;
  const infoWidth = plan && !largePlan ? plan.x - INSET - 26 : body.width - 24;
  layout.lines.forEach((line, index) =>
    text(c, line, INSET + 9, HEADER + 36 + LINE_HEIGHT * index - offset, infoWidth),
  );
  if (plan && corners) paintPlan(c, { ...plan, y: plan.y - offset }, corners, layout.planEdge, largePlan);
  if (largePlan) {
    for (const o of layout.openings) {
      c.fillStyle = o.kind === "window" ? "#87caff" : "#ffcf81";
      c.fillRect(o.x - 4, o.y - offset - 4, 8, 8);
    }
    for (const target of layout.wallTargets) {
      const box = { ...target, y: target.y - offset };
      fill(c, box, 17, target.active ? "#317f77" : target.act ? "#21485c" : "#20313b");
      stroke(c, box, 17, target.act ? "#a4e6dc" : "#4d666e", 2);
      c.fillStyle = target.act || target.active ? "#ecfff9" : "#8d9da5";
      c.font = `650 19px ${FONT}`;
      c.textAlign = "center";
      c.fillText(target.label, box.x + box.width/2, box.y + box.height/2 + 6);
    }
    c.textAlign = "left";
  }
  if (keyboard) paintKeyboardField(c, keyboard, offset);
  for (const row of rows) {
    if (row.y + row.height - offset > body.y && row.y - offset < body.y + body.height)
      paintButton(c, row, offset);
  }
  c.restore();

  if (layout.maxScroll > 0.1) {
    if (offset > 0) {
      const fade = c.createLinearGradient(0, body.y, 0, body.y + 12);
      fade.addColorStop(0, "#182935cc");
      fade.addColorStop(1, "#18293500");
      c.fillStyle = fade;
      c.fillRect(body.x - 1, body.y, body.width + 2, 12);
    }
    if (offset < layout.maxScroll) {
      const end = body.y + body.height;
      const fade = c.createLinearGradient(0, end - 16, 0, end);
      fade.addColorStop(0, "#13202b00");
      fade.addColorStop(1, "#13202be8");
      c.fillStyle = fade;
      c.fillRect(body.x - 1, end - 16, body.width + 2, 16);
    }
    const lane = (r: PanelRect, width: number) => ({ ...r, x: r.x + (r.width - width) / 2, width });
    fill(c, lane(track, 7), 3.5, "#0c151d");
    fill(c, lane(scrollThumb(layout, offset), thumbHeld ? 11 : 8), 4, thumbHeld ? "#acf2df" : "#71a39f");
  }

  const footerTop = height - FOOTER;
  fill(c, { x: INSET, y: footerTop + 1, width: PANEL_WIDTH - INSET * 2, height: 1 }, 0.5, "#3a4a57");
  for (const row of footer) paintButton(c, row);
}

export function panelFont(c: CanvasRenderingContext2D) {
  c.font = `430 25px ${FONT}`;
}
