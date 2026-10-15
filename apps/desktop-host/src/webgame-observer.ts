/** Preview-only frame scheduling; no game variables or executable tool arguments. */
export const WEBGAME_OBSERVER = `(() => {
  globalThis.__webGameErrors = [];
  const record = value => { if (__webGameErrors.length < 30) __webGameErrors.push(String(value).slice(0, 2000)); };
  addEventListener('error', event => record(event.message));
  addEventListener('unhandledrejection', event => record(event.reason));
  const frame = requestAnimationFrame.bind(globalThis);
  const cancel = cancelAnimationFrame.bind(globalThis);
  const pending = new Map();
  let sequence = 0, frozen = false, pausedAt = 0, pausedTotal = 0;
  const schedule = (id, entry) => {
    entry.native = frame(time => {
      entry.native = null;
      if (frozen) return;
      pending.delete(id);
      entry.callback(time - pausedTotal);
    });
  };
  globalThis.requestAnimationFrame = callback => {
    const id = ++sequence;
    const entry = { callback, native: null };
    pending.set(id, entry);
    if (!frozen) schedule(id, entry);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    const entry = pending.get(id);
    if (entry?.native !== null && entry?.native !== undefined) cancel(entry.native);
    pending.delete(id);
  };
  globalThis.__webGamePreviewClock = Object.freeze({
    nextFrame: callback => frame(callback),
    freeze: () => {
      if (!frozen) { frozen = true; pausedAt = performance.now(); }
      return { frozen, scope: 'requestAnimationFrame callbacks and frame timestamps only' };
    },
    thaw: () => {
      if (frozen) {
        pausedTotal += performance.now() - pausedAt;
        frozen = false;
        for (const [id, entry] of pending) if (entry.native === null) schedule(id, entry);
      }
      return { frozen, scope: 'requestAnimationFrame callbacks and frame timestamps only' };
    },
  });
})();`
