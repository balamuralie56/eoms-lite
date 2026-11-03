import type { AllocationInfo, PublicConfig } from './types';
import { formatExamDate, formatIst, sessionName } from './time';
import { safeName } from './csv';

/** A4-landscape-ish proportions at ~200 dpi: 1800 x 1100 px, plenty for printing and phone screens. */
export const SLIP_WIDTH = 1800;
export const SLIP_HEIGHT = 1100;

export type Measure = (text: string) => number;

/**
 * Greedy word wrap with an ellipsis on the last line when the text still does not fit. Pure (takes a measuring
 * function), so layout is unit-testable without a canvas. Single words longer than a line are hard-split.
 */
export function wrapLines(measure: Measure, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  const push = (s: string) => lines.push(s);
  for (let w of words) {
    while (measure(w) > maxWidth) {                 // a single over-long token: split it
      let cut = w.length - 1;
      while (cut > 1 && measure(w.slice(0, cut)) > maxWidth) cut -= 1;
      if (cur) { push(cur); cur = ''; }
      push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const next = cur ? `${cur} ${w}` : w;
    if (measure(next) <= maxWidth) cur = next;
    else { push(cur); cur = w; }
  }
  if (cur) push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && measure(last + '…') > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = last.replace(/\s+$/, '') + '…';
  return kept;
}

/** Largest font size (px) <= start that makes the text fit the width, never below min. */
export function fitFontSize(measureAt: (size: number, text: string) => number, text: string, maxWidth: number, start: number, min: number): number {
  let size = start;
  while (size > min && measureAt(size, text) > maxWidth) size -= 2;
  return size;
}

export function slipFilename(a: Pick<AllocationInfo, 'employee_id' | 'exam_date' | 'session'>): string {
  return `allocation-slip_${safeName(a.employee_id)}_${safeName(a.exam_date)}_${a.session}.png`;
}

const NAVY = '#1e3a8a';
const INK = '#0f172a';
const MUTED = '#475569';
const LINE = '#cbd5e1';

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export type SlipBrand = Pick<PublicConfig, 'institution_name' | 'exam_cell_name' | 'logo_data_url' | 'contact_instructions'>;

/** Draws the allocation slip. Returns a canvas of SLIP_WIDTH x SLIP_HEIGHT. */
export async function renderSlipCanvas(a: AllocationInfo, brand: SlipBrand, now: Date = new Date()): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = SLIP_WIDTH;
  canvas.height = SLIP_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser');
  const font = (size: number, weight = 400, family = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif') =>
    `${weight} ${size}px ${family}`;
  const measureAt = (size: number, weight: number) => (t: string) => { ctx.font = font(size, weight); return ctx.measureText(t).width; };

  // page + frame
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SLIP_WIDTH, SLIP_HEIGHT);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, SLIP_WIDTH - 48, SLIP_HEIGHT - 48);

  // header band
  ctx.fillStyle = NAVY;
  ctx.fillRect(24, 24, SLIP_WIDTH - 48, 190);
  let textX = 80;
  if (brand.logo_data_url) {
    const img = await loadImage(brand.logo_data_url);
    if (img) {
      const box = 130;
      const scale = Math.min(box / img.width, box / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(70, 54, box + 20, box + 20);
      ctx.drawImage(img, 80 + (box - w) / 2, 64 + (box - h) / 2, w, h);
      textX = 70 + box + 20 + 36;
    }
  }
  const headW = SLIP_WIDTH - 48 - (textX - 24) - 56;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  const instLines = wrapLines(measureAt(46, 700), brand.institution_name, headW, 2);
  ctx.font = font(46, 700);
  instLines.forEach((l, i) => ctx.fillText(l, textX, 100 + i * 54));
  ctx.fillStyle = '#c7d2fe';
  ctx.font = font(32, 500);
  const cell = wrapLines(measureAt(32, 500), brand.exam_cell_name, headW, 1)[0] ?? '';
  ctx.fillText(cell, textX, instLines.length > 1 ? 100 + 54 + 46 : 100 + 46);

  // title
  ctx.fillStyle = MUTED;
  ctx.font = font(30, 700);
  ctx.fillText('INVIGILATION ROOM ALLOCATION', 80, 290);

  // left: the room, large
  ctx.strokeStyle = NAVY;
  ctx.lineWidth = 4;
  ctx.strokeRect(80, 320, 700, 520);
  ctx.fillStyle = MUTED;
  ctx.font = font(34, 700);
  ctx.fillText('ROOM', 120, 380);
  const roomSize = fitFontSize((s, t) => measureAt(s, 800)(t), a.room_code, 620, 260, 70);
  ctx.fillStyle = NAVY;
  ctx.font = font(roomSize, 800);
  ctx.fillText(a.room_code, 120, 380 + 40 + roomSize * 0.85, 620);
  const where = [a.building, a.floor ? `Floor ${a.floor}` : null].filter(Boolean).join(' · ');
  if (where) {
    ctx.fillStyle = INK;
    const lines = wrapLines(measureAt(40, 600), where, 620, 2);
    ctx.font = font(40, 600);
    lines.forEach((l, i) => ctx.fillText(l, 120, 770 + i * 48));
  }

  // right: details
  const colX = 840;
  const colW = SLIP_WIDTH - 80 - colX;
  let y = 340;
  const block = (title: string, value: string, maxLines = 1, size = 42) => {
    ctx.fillStyle = MUTED;
    ctx.font = font(26, 700);
    ctx.fillText(title.toUpperCase(), colX, y);
    ctx.fillStyle = INK;
    const lines = wrapLines(measureAt(size, 700), value || '-', colW, maxLines);
    ctx.font = font(size, 700);
    lines.forEach((l, i) => ctx.fillText(l, colX, y + 50 + i * (size + 8)));
    y += 50 + lines.length * (size + 8) + 26;
  };
  block('Employee name', a.employee_name || '-', 2);
  block('Employee ID', a.employee_id);
  block('Department', a.department || '-', 2, 38);
  block('Examination date', formatExamDate(a.exam_date));
  block('Session', sessionName(a.session));

  // footer
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(80, 900); ctx.lineTo(SLIP_WIDTH - 80, 900); ctx.stroke();
  ctx.fillStyle = INK;
  ctx.font = font(40, 800, 'ui-monospace, Menlo, Consolas, monospace');
  ctx.fillText(`REF ${a.reference}`, 80, 960);
  ctx.fillStyle = MUTED;
  ctx.font = font(28, 500);
  const gen = `Generated ${formatIst(now.toISOString())} IST`;
  ctx.fillText(gen, SLIP_WIDTH - 80 - ctx.measureText(gen).width, 960);
  const note = 'This slip is a convenience copy and can be edited by anyone. The examination cell can confirm your allocation. ' + (brand.contact_instructions || '');
  const noteLines = wrapLines(measureAt(24, 500), note, SLIP_WIDTH - 160, 2);
  ctx.font = font(24, 500);
  noteLines.forEach((l, i) => ctx.fillText(l, 80, 1010 + i * 32));
  return canvas;
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the image'))), 'image/png');
  });
}
