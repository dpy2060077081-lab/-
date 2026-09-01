export function createEditorBootCoordinator({ window: ownerWindow, startDesktop, startBrowser }) {
  let mounted = false;
  let starting = null;
  let pendingDesktop = false;

  const start = desktop => {
    if (mounted) return Promise.resolve(true);
    if (desktop) pendingDesktop = true;
    if (starting) return starting;
    starting = (async () => {
      let useDesktop = desktop;
      while (!mounted) {
        if (useDesktop) pendingDesktop = false;
        const ok = await (useDesktop ? startDesktop() : startBrowser());
        if (ok !== false) { mounted = true; return true; }
        if (!pendingDesktop) return false;
        useDesktop = true;
      }
      return true;
    })()
      .finally(() => { starting = null; });
    return starting;
  };
  const desktopReady = () => Boolean(ownerWindow?.pywebview?.api?.files);
  const onBridgeReady = () => desktopReady() ? start(true) : Promise.resolve(false);

  return {
    start() {
      ownerWindow?.addEventListener?.('pywebviewready', onBridgeReady);
      if (desktopReady()) return start(true);
      return ['http:', 'https:'].includes(ownerWindow?.location?.protocol) ? start(false) : Promise.resolve(false);
    },
    onBridgeReady,
    get mounted() { return mounted; },
  };
}

