import { spawn } from 'node:child_process';

export class SmokeTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SmokeTimeoutError';
    this.code = 'SMOKE_TIMEOUT';
  }
}

export class EnvironmentBlockedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'EnvironmentBlockedError';
    this.code = 'ENVIRONMENT_BLOCKED';
  }
}

export class SmokeCleanupError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SmokeCleanupError';
    this.code = 'SMOKE_CLEANUP_FAILED';
  }
}

function abortError(signal, fallback = 'Operation aborted') {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

export function abortableDelay(milliseconds, signal, { unref = false } = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(finish, milliseconds);
    if (unref) timer.unref?.();
    const onAbort = () => finish(abortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    function finish(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error instanceof Error) rejectDelay(error);
      else resolveDelay();
    }
  });
}

function settleWithin(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SmokeTimeoutError(`${label} did not settle after cleanup within ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runStage(label, action, {
  timeoutMs = 20_000,
  settleTimeoutMs = 5_000,
  parentSignal,
  cleanup = async () => {},
  logger = console,
} = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(abortError(parentSignal));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new SmokeTimeoutError(`${label} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timer.unref?.();
  logger.log?.(`[smoke] START ${label} (timeout ${timeoutMs}ms)`);

  const operation = Promise.resolve().then(() => action(controller.signal));
  const aborted = new Promise((_, reject) => {
    const rejectAbort = () => reject(abortError(controller.signal));
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });

  try {
    const result = await Promise.race([operation, aborted]);
    logger.log?.(`[smoke] PASS  ${label} (${Date.now() - startedAt}ms)`);
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      const failures = [error];
      try { await cleanup(error); } catch (cleanupError) { failures.push(cleanupError); }
      try { await settleWithin(operation.catch(() => undefined), settleTimeoutMs, label); } catch (settleError) { failures.push(settleError); }
      if (failures.length > 1) error = new AggregateError(failures, `${label} abort cleanup failed`);
    }
    logger.error?.(`[smoke] FAIL  ${label} (${Date.now() - startedAt}ms): ${error.message}`);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export async function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

export function runTaskkill(pid, {
  timeoutMs = 5_000,
  spawnProcess = spawn,
} = {}) {
  return new Promise((resolveExit, rejectExit) => {
    const killer = spawnProcess('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer.removeListener('error', onError);
      killer.removeListener('exit', onExit);
      if (error) rejectExit(error);
      else resolveExit(code ?? 1);
    };
    const onError = error => finish(error);
    const onExit = code => finish(null, code);
    const timer = setTimeout(() => {
      try { killer.kill?.('SIGKILL'); } catch {}
      finish(new SmokeTimeoutError(`taskkill for process ${pid} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    killer.once('error', onError);
    killer.once('exit', onExit);
    killer.unref?.();
  });
}

export class SmokeResourceTracker {
  constructor() {
    this.browsers = new Set();
    this.servers = new Set();
    this.cdps = new Set();
  }

  get isEmpty() {
    return this.browsers.size === 0 && this.servers.size === 0 && this.cdps.size === 0;
  }

  trackBrowser(browser) { this.browsers.add(browser); return browser; }
  trackServer(server) { this.servers.add(server); return server; }
  trackCdp(cdp) { this.cdps.add(cdp); return cdp; }

  async closeBrowser(browser, { timeoutMs = 20_000 } = {}) {
    if (!browser) return;
    await settleWithin(Promise.resolve().then(() => browser.close()), timeoutMs, `Browser PID ${browser.pid ?? 'unknown'} close`);
    this.browsers.delete(browser);
  }

  async closeServer(server, { timeoutMs = 15_000 } = {}) {
    if (!server) return;
    await settleWithin(Promise.resolve().then(() => server.close()), timeoutMs, 'HTTP server close');
    this.servers.delete(server);
  }

  async closeCdp(cdp, { timeoutMs = 5_000 } = {}) {
    if (!cdp) return;
    await settleWithin(Promise.resolve().then(() => cdp.close()), timeoutMs, 'DevTools WebSocket did not close');
    this.cdps.delete(cdp);
  }
}

export function spawnTrackedBrowser(spawnProcess, spawnArguments, tracker, createBrowser) {
  const [executable, args, options] = spawnArguments;
  const child = spawnProcess(executable, args, options);
  const browser = createBrowser(child);
  tracker.trackBrowser(browser);
  return { child, browser };
}

export async function terminateStartedProcessTree(child, {
  platform = process.platform,
  runTaskkill: taskkill = runTaskkill,
  isProcessAlive: processAlive = isProcessAlive,
  timeoutMs = 10_000,
  pollMs = 50,
  signal,
} = {}) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!await processAlive(pid)) return;

  let terminationExit = 0;
  if (platform === 'win32') terminationExit = await taskkill(pid);
  else if (child.kill?.('SIGKILL') === false) terminationExit = 1;

  const deadline = Date.now() + timeoutMs;
  while (await processAlive(pid)) {
    if (Date.now() >= deadline) {
      const detail = platform === 'win32' ? `taskkill exit ${terminationExit}; ` : '';
      throw new Error(`${detail}process ${pid} is still running after ${timeoutMs}ms`);
    }
    await abortableDelay(pollMs, signal, { unref: true });
  }
  if (terminationExit !== 0) {
    throw new Error(`taskkill exited ${terminationExit} for process ${pid}, although the PID later disappeared`);
  }
}

export class Cdp {
  constructor(url, {
    WebSocketImpl = globalThis.WebSocket,
    commandTimeoutMs = 15_000,
    connectionTimeoutMs = 10_000,
    closeTimeoutMs = 2_000,
    logger = console,
    signal,
  } = {}) {
    if (typeof WebSocketImpl !== 'function') throw new EnvironmentBlockedError('Node runtime does not provide global WebSocket');
    this.socket = new WebSocketImpl(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.unknownResponses = [];
    this.commandTimeoutMs = commandTimeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.logger = logger;
    this.signal = signal;
    this.closed = false;
    this.closing = false;
    this.closedPromise = new Promise(resolveClosed => { this.resolveClosed = resolveClosed; });
    this.onAbort = () => { void this.close(abortError(signal)).catch(() => {}); };
    signal?.addEventListener('abort', this.onAbort, { once: true });

    this.ready = new Promise((resolveReady, rejectReady) => {
      let settled = false;
      const timer = setTimeout(() => {
        const error = new SmokeTimeoutError(`DevTools WebSocket connection timed out after ${connectionTimeoutMs}ms`);
        rejectConnection(error);
        void this.close(error).catch(() => {});
      }, connectionTimeoutMs);
      timer.unref?.();
      const resolveConnection = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.rejectReady = null;
        resolveReady();
      };
      const rejectConnection = error => {
        if (settled) return;
        settled = true;
        cleanup();
        this.rejectReady = null;
        rejectReady(error);
      };
      const onOpen = resolveConnection;
      const onError = event => rejectConnection(event?.error ?? new Error('DevTools WebSocket connection failed'));
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener('open', onOpen);
        this.socket.removeEventListener('error', onError);
      };
      this.rejectReady = rejectConnection;
      this.socket.addEventListener('open', onOpen, { once: true });
      this.socket.addEventListener('error', onError, { once: true });
    });

    this.socket.addEventListener('message', ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch (error) {
        this.logger.warn?.(`Ignoring malformed DevTools message: ${error.message}`);
        return;
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          this.unknownResponses.push(message);
          this.logger.warn?.(`Ignoring unknown or late DevTools response id ${message.id}`);
          return;
        }
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else this.events.push(message);
    });
    this.socket.addEventListener('close', event => {
      const reason = event.reason ? `, reason ${event.reason}` : '';
      this.rejectPending(new Error(`DevTools socket closed (code ${event.code}${reason})`));
      this.closed = true;
      this.closing = false;
      this.resolveClosed();
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(new Error(`${error.message} while waiting for ${pending.method}`));
    this.pending.clear();
  }

  async send(method, params = {}, { signal = this.signal } = {}) {
    await this.ready;
    if (this.closed) throw new Error(`DevTools socket is closed before ${method}`);
    if (signal?.aborted) throw abortError(signal);
    const id = this.nextId++;
    const response = new Promise((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => finish(rejectResponse, new SmokeTimeoutError(`DevTools command timed out: ${method}`)), this.commandTimeoutMs);
      timeout.unref?.();
      const onAbort = () => finish(rejectResponse, abortError(signal));
      signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (settle, value) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        settle(value);
      };
      this.pending.set(id, {
        method,
        resolve: value => finish(resolveResponse, value),
        reject: error => finish(rejectResponse, error),
      });
    });
    try { this.socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { this.pending.get(id)?.reject(error); }
    return response;
  }

  async evaluate(expression, options) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, options);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  async waitFor(predicate, message, timeoutMs = 10_000, signal = this.signal) {
    const deadline = Date.now() + timeoutMs;
    do {
      const value = await this.evaluate(predicate, { signal });
      if (value) return value;
      await abortableDelay(50, signal, { unref: true });
    } while (Date.now() < deadline);
    throw new SmokeTimeoutError(message);
  }

  async close(reason = new Error('DevTools client closed')) {
    if (this.closed) return;
    if (this.closing) return this.closedPromise;
    this.closing = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.rejectReady?.(reason);
    this.rejectPending(reason);
    if (this.socket.readyState === 3) {
      this.closed = true;
      this.closing = false;
      this.resolveClosed();
      return;
    }
    try {
      if (this.socket.readyState !== 2) this.socket.close();
    } catch (error) {
      this.closing = false;
      throw error;
    }
    await settleWithin(this.closedPromise, this.closeTimeoutMs, 'DevTools WebSocket close');
  }
}
