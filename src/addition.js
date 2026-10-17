import {validateLibrary} from './model.js';
// Unknown responses are not failures: preserve the exact intent for retry.
export async function resolveAddition(payload, {send, confirm}) {
  const completed = result => {
    if (result?.state !== 'completed' || result.requestId !== payload.requestId || result.entryId !== payload.entry.id || result.revision !== payload.revision+1 || !Number.isSafeInteger(result.library?.revision) || result.library.revision < result.revision) return false;
    try { validateLibrary(result.library.entries);return true; } catch { return false; }
  };
  let cause;
  try {
    const result=await send(payload);
    if (completed(result)) return {state:'completed',result};
    cause=Error('添加响应无法核对');
  } catch (error) { cause=error; }
  // Even a later 409 can follow an earlier successful write whose response
  // was lost. Consult the receipt before deciding that editing is safe.
  try {
    const result=await confirm(payload.requestId);
    if (completed(result)) return {state:'completed',result};
    if (result?.state === 'unknown' && result.requestId === payload.requestId && Number.isInteger(cause.status) && cause.status >= 400 && cause.status < 500 && !cause.migrationPending) return {state:'rejected',error:cause};
  } catch { /* Keep the frozen draft when confirmation is unavailable. */ }
  return {state:'pending',error:cause};
}
