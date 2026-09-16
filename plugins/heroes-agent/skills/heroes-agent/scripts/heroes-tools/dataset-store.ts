import type { DatasetManifest } from './dataset-manifest';

export type DatasetRow = Record<string, unknown>;

export interface StoredDataset {
  manifest: DatasetManifest;
  rows: DatasetRow[];
}

/** Storage boundary used by the dataset kernel and every concrete adapter. */
export interface DatasetStore {
  read(datasetId: string): Promise<StoredDataset | undefined>;
  commit(dataset: StoredDataset): Promise<void>;
  writeExport(datasetId: string, contentHash: string, csv: string): Promise<string>;
}
