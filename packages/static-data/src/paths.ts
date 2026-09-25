// Folders of this package. DATA_DIR holds hand-reviewed inputs (the alias table, place short names, release keys).
// DIST_DIR holds the built datasets that ship with the app (H-1B table, place table); the build commands write them.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(PACKAGE_DIR, 'data');
export const DIST_DIR = join(PACKAGE_DIR, 'dist');
