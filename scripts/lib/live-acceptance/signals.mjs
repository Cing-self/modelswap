// Best-effort SIGINT/SIGTERM cleanup for the live-acceptance CLI (P1).
//
// A Ctrl-C during a guest sweep would otherwise orphan the dedicated Chrome
// and leak the throwaway profile directory. On signal we run the driver's
// dispose (kills the Chrome we launched, removes temporary profiles) under a
// hard 3s budget, then exit with the conventional 130/143 code.
//
// SIGKILL cannot be intercepted by design; that limitation and the manual
// cleanup command are documented in docs/testing/provider-live-acceptance.md.

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
const CLEANUP_BUDGET_MS = 3000;

export function registerSignalCleanup({ driver, logger = console } = {}) {
  if (!driver) return () => undefined;
  let cleaning = false;
  const handle = (signal) => {
    if (cleaning) return;
    cleaning = true;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      process.exit(SIGNAL_EXIT_CODES[signal] || 128);
    };
    const timer = setTimeout(finish, CLEANUP_BUDGET_MS);
    Promise.resolve()
      .then(() => driver.dispose({ keepOpen: false }))
      .catch((error) => {
        try { logger.log(`warn\t信号清理失败：${error?.message || error}`); } catch { /* best effort */ }
      })
      .then(() => {
        clearTimeout(timer);
        finish();
      });
  };
  const onSigint = () => handle('SIGINT');
  const onSigterm = () => handle('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
}
