import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatasetStore, StoredDataset } from './dataset-store';

const DATASET_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

function datasetDirectory(workspace: string, datasetId: string): string {
  if (!DATASET_KEY.test(datasetId)) throw new Error(`Invalid dataset key: ${datasetId}`);
  return join(workspace, 'self', 'datasets', datasetId);
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Open the filesystem adapter rooted at one user workspace. */
export function openLocalDatasetStore(workspace: string): DatasetStore {
  return {
    async read(datasetId) {
      const path = join(datasetDirectory(workspace, datasetId), 'index.json');
      if (!existsSync(path)) return undefined;
      return JSON.parse(readFileSync(path, 'utf8')) as StoredDataset;
    },

    async commit(dataset) {
      const path = join(datasetDirectory(workspace, dataset.manifest.dataset), 'index.json');
      writeAtomically(path, `${JSON.stringify(dataset, null, 2)}\n`);
    },

    async writeExport(datasetId, contentHash, csv) {
      const path = join(datasetDirectory(workspace, datasetId), 'exports', `${contentHash}.csv`);
      if (existsSync(path)) {
        if (readFileSync(path, 'utf8') !== csv) {
          throw new Error(`Existing dataset export does not match its content hash: ${contentHash}`);
        }
      } else {
        writeAtomically(path, csv);
      }
      return path;
    },
  };
}
