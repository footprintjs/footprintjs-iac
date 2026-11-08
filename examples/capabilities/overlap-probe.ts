/** A barrier measures overlapping provider calls without relying on a short timing threshold. */
export function overlapProbe() {
  let active = 0, peak = 0, entered = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return {
    get peak() { return peak; },
    async afterEffect() {
      active++;
      peak = Math.max(active, peak);
      if (++entered === 2) release();
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Independent capability resources did not overlap')), 3000);
          void gate.then(() => { clearTimeout(timer); resolve(); });
        });
      } finally { active--; }
    },
  };
}
