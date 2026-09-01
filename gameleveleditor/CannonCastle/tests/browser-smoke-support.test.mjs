import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

const support = await import('./browser-smoke-support.mjs');

class FakeSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(value) { this.sent.push(JSON.parse(value)); }

  respond(message) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
  }
}

class ConnectingSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
  }
}

class ClosingSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }

  close() { this.readyState = 2; }
}

test('CDP records unknown and late response ids without dereferencing missing requests', async () => {
  const warnings = [];
  const cdp = new support.Cdp('ws://fake', {
    WebSocketImpl: FakeSocket,
    commandTimeoutMs: 10,
    connectionTimeoutMs: 100,
    logger: { warn: message => warnings.push(message) },
  });
  await cdp.ready;

  cdp.socket.respond({ id: 999, result: { ignored: true } });
  const pending = cdp.send('Runtime.evaluate');
  await new Promise(resolve => setImmediate(resolve));
  const [{ id }] = cdp.socket.sent;
  await assert.rejects(pending, /timed out/);
  cdp.socket.respond({ id, result: { late: true } });

  assert.deepEqual(cdp.unknownResponses.map(message => message.id), [999, id]);
  assert.equal(warnings.length, 2);
  cdp.close();
});

test('closing a connecting CDP rejects its ready wait immediately', async () => {
  const cdp = new support.Cdp('ws://connecting', {
    WebSocketImpl: ConnectingSocket,
    connectionTimeoutMs: 100,
  });
  await cdp.close(new Error('stage aborted'));
  await assert.rejects(cdp.ready, /stage aborted/);
});

test('a CLOSING WebSocket is not treated as CLOSED or removed from tracking', async () => {
  const tracker = new support.SmokeResourceTracker();
  const cdp = new support.Cdp('ws://closing', {
    WebSocketImpl: ClosingSocket,
    connectionTimeoutMs: 100,
    closeTimeoutMs: 10,
  });
  await cdp.ready;
  tracker.trackCdp(cdp);
  await assert.rejects(() => tracker.closeCdp(cdp, { timeoutMs: 30 }), /close|settle/i);
  assert.equal(cdp.closed, false);
  assert.equal(tracker.cdps.has(cdp), true);
});

test('stage timeout aborts the operation and awaits its cleanup', async () => {
  let aborted = false;
  let cleaned = false;
  await assert.rejects(
    () => support.runStage('hung stage', signal => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }), {
      timeoutMs: 10,
      settleTimeoutMs: 50,
      cleanup: async () => { cleaned = true; },
      logger: { log() {}, error() {} },
    }),
    /hung stage timed out/,
  );
  assert.equal(aborted, true);
  assert.equal(cleaned, true);
});

test('Windows process-tree cleanup rejects when taskkill fails and the exact PID remains alive', async () => {
  let checks = 0;
  await assert.rejects(
    () => support.terminateStartedProcessTree({ pid: 4242 }, {
      platform: 'win32',
      runTaskkill: async () => 5,
      isProcessAlive: async pid => { assert.equal(pid, 4242); checks += 1; return true; },
      timeoutMs: 15,
      pollMs: 1,
    }),
    /taskkill.*5.*4242|4242.*still running/i,
  );
  assert.ok(checks > 1);
});

test('Windows process-tree cleanup waits until the exact target PID disappears', async () => {
  const alive = [true, true, false];
  let killedPid;
  await support.terminateStartedProcessTree({ pid: 4343 }, {
    platform: 'win32',
    runTaskkill: async pid => { killedPid = pid; return 0; },
    isProcessAlive: async () => alive.shift() ?? false,
    timeoutMs: 50,
    pollMs: 1,
  });
  assert.equal(killedPid, 4343);
  assert.equal(alive.length, 0);
});

test('spawned browser is tracked before startup discovery can hang', () => {
  const tracker = new support.SmokeResourceTracker();
  const child = { pid: 4545 };
  const result = support.spawnTrackedBrowser(
    () => child,
    ['edge', []],
    tracker,
    spawned => ({ pid: spawned.pid, close: async () => {} }),
  );
  assert.equal(result.child, child);
  assert.equal(tracker.browsers.has(result.browser), true);
  assert.equal(tracker.isEmpty, false);
});

test('taskkill has its own hard timeout and rejects a hung killer', async () => {
  const killer = new EventEmitter();
  killer.unref = () => {};
  killer.kill = () => true;
  await assert.rejects(
    () => support.runTaskkill(4646, { timeoutMs: 10, spawnProcess: () => killer }),
    /taskkill.*timed out/i,
  );
});

test('browser-level CDP close rejection remains tracked and prevents clean shutdown', async () => {
  const tracker = new support.SmokeResourceTracker();
  const cdp = { close: async () => { throw new Error('close rejected'); } };
  tracker.trackCdp(cdp);
  await assert.rejects(() => tracker.closeCdp(cdp, { timeoutMs: 20 }), /close rejected/);
  assert.equal(tracker.cdps.has(cdp), true);
  assert.equal(tracker.isEmpty, false);
});

test('hung browser-level CDP close remains tracked and prevents clean shutdown', async () => {
  const tracker = new support.SmokeResourceTracker();
  const cdp = { close: async () => new Promise(() => {}) };
  tracker.trackCdp(cdp);
  await assert.rejects(() => tracker.closeCdp(cdp, { timeoutMs: 10 }), /did not close/i);
  assert.equal(tracker.cdps.has(cdp), true);
  assert.equal(tracker.isEmpty, false);
});
