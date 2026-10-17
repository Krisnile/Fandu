import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Only files created by Fandu's atomic writers are eligible.  Broad `*.tmp`
// cleanup could destroy a file that the user deliberately placed beside the
// archive, so each directory has its own deliberately narrow allow-list.
const archiveTemporary = /^(?:library|backup-[0-2]|manual-[a-f0-9-]{36}|recovery-[a-f0-9-]{36}|migration-pending|migration-receipts|entry-drafts)\.json\.[a-f0-9-]{36}\.tmp$/;
const coverTemporary = /^(?:index\.json|[a-f0-9]{64}\.(?:jpg|png|webp))\.tmp-\d+-[a-f0-9]+$/;
const sourceIconTemporary = /^\.index-\d+-\d+-[a-z0-9]+\.tmp$/;

async function removeMatching(dir, pattern) {
  let names;
  try { names = await readdir(dir); }
  catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try { await unlink(join(dir, name)); removed += 1; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return removed;
}

export async function cleanupStorageTemporaryFiles(dataDir) {
  const [archive, covers, sourceIcons] = await Promise.all([
    removeMatching(dataDir, archiveTemporary),
    removeMatching(join(dataDir, 'covers'), coverTemporary),
    removeMatching(join(dataDir, 'source-icons'), sourceIconTemporary)
  ]);
  return { archive, covers, sourceIcons, total: archive + covers + sourceIcons };
}
