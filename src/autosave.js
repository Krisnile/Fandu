// Coalesce pending edits; never discard a newer edit when an older request finishes.
export function createAutosave({ write, state = () => {}, delay = 300 }) {
  let pending = {}, timer, running = null, failed = false;
  const hasPending = () => Object.keys(pending).length > 0;
  function schedule(patch) {
    pending = { ...pending, ...patch }; failed = false;
    clearTimeout(timer); state('pending'); timer = setTimeout(flush, delay);
  }
  async function flush() {
    clearTimeout(timer);
    if (running) { await running; if (hasPending() && !failed) return flush(); return !failed; }
    if (!hasPending()) return !failed;
    const patch = pending; pending = {}; state('saving');
    running = (async () => {
      try {
        await write(patch); failed = false;
      } catch (error) {
        pending = { ...patch, ...pending }; failed = true; state('error', error);
      }
    })();
    await running; running = null;
    if (failed) return false;
    if (hasPending()) return flush();
    state('saved'); return true;
  }
  async function cancel() {
    clearTimeout(timer);pending={};
    if(running)await running;
    clearTimeout(timer);pending={};failed=false;state('canceled');
  }
  return { schedule, flush, cancel, get dirty() { return Boolean(running || hasPending()); } };
}
