import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

export const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

export function loadProjectEnvironment({ envFile = resolve(APP_ROOT, '.env'), load = loadEnvFile } = {}) {
  try {
    load(envFile);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function resolveDataDirectory({ env = process.env, appRoot = APP_ROOT } = {}) {
  const configured = typeof env.FANDU_DATA_DIR === 'string' ? env.FANDU_DATA_DIR.trim() : '';
  if (!configured) return resolve(appRoot, 'data');
  return isAbsolute(configured) ? resolve(configured) : resolve(appRoot, configured);
}
