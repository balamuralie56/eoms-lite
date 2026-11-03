import type { ParseResult } from './importParse';
import type { WorkerOut } from '../workers/parse.worker';

/**
 * Parses the chosen file in a Web Worker so large spreadsheets never freeze the page.
 * Rejects with a readable message for unreadable or unsupported files.
 */
export function parseImportFile(file: File): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/parse.worker.ts', import.meta.url), { type: 'module' });
    const done = () => worker.terminate();
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      done();
      if (e.data.ok) resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    worker.onerror = () => { done(); reject(new Error('Could not read the file.')); };
    worker.postMessage({ file });
  });
}
