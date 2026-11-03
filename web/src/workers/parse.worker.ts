/// <reference lib="webworker" />
import Papa from 'papaparse';
import { readSheet } from 'read-excel-file/web-worker';
import { checkFile, normalizeTable, type ParseResult } from '../lib/importParse';

export type WorkerIn = { file: File };
export type WorkerOut = { ok: true; result: ParseResult } | { ok: false; error: string };

async function parse(file: File): Promise<ParseResult> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const kind = checkFile(file, head);
  if ('error' in kind) throw new Error(kind.error);
  if (kind.kind === 'csv') {
    const raw = await file.text();
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;      // strip a UTF-8 byte-order mark
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
    return normalizeTable(parsed.data as unknown[][]);
  }
  const sheet = await readSheet(file);
  return normalizeTable(sheet as unknown[][]);
}

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  try {
    const result = await parse(e.data.file);
    (self as unknown as Worker).postMessage({ ok: true, result } satisfies WorkerOut);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : 'Could not read the file.' } satisfies WorkerOut);
  }
};
