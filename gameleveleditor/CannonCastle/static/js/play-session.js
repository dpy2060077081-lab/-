import { createOriginalRuntime } from './original-runtime-adapter.js';

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function sessionOptions(draftOrOptions, legacyFactory, globalPhysics) {
  if (draftOrOptions?.draft && typeof draftOrOptions === 'object' && !Array.isArray(draftOrOptions)) {
    return { ...draftOrOptions, legacy: false };
  }
  return {
    draft: draftOrOptions,
    runtimeFactory: legacyFactory,
    globalPhysics,
    legacy: Boolean(legacyFactory),
  };
}

/** Owns one disposable simulation and never exposes a writable editor draft. */
export function createPlaySession(draftOrOptions, legacyFactory, globalPhysics = null) {
  const options = sessionOptions(draftOrOptions, legacyFactory, globalPhysics);
  const { draft, config = null, assets = null } = options;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new TypeError('createPlaySession requires a draft object');
  }
  if (options.runtimeFactory !== undefined && typeof options.runtimeFactory !== 'function') {
    throw new TypeError('createPlaySession requires a runtime factory');
  }

  const editDraft = clone(draft);
  const runtimeInput = { level: clone(editDraft), config: clone(config), assets: clone(assets), globalPhysics: clone(options.globalPhysics) };
  const game = options.runtimeFactory
    ? (options.legacy ? options.runtimeFactory(runtimeInput.level) : options.runtimeFactory(runtimeInput))
    : createOriginalRuntime(runtimeInput);
  for (const method of ['snapshot', 'selectProjectile', 'aim', 'fire', 'step', 'reset']) {
    if (typeof game?.[method] !== 'function') throw new TypeError(`Play runtime must implement ${method}()`);
  }

  const subscribers = new Set();
  let current = clone(game.snapshot());
  let debug = {};
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new Error('Play session is closed');
  };
  const publish = (snapshot = game.snapshot()) => {
    current = clone(snapshot);
    for (const subscriber of subscribers) subscriber(clone(current));
    return clone(current);
  };
  const interact = (method, ...args) => {
    assertOpen();
    const result = game[method](...args);
    publish(method === 'step' || method === 'reset' ? result : game.snapshot());
    return result;
  };

  return Object.freeze({
    get closed() { return closed; },
    get debug() { return clone(debug); },
    snapshot() { assertOpen(); return clone(current); },
    getSnapshot() { assertOpen(); return clone(current); },
    refresh() { assertOpen(); return publish(); },
    selectProjectile(type) { return interact('selectProjectile', type); },
    aim(deltaDegrees) { return interact('aim', deltaDegrees); },
    aimAt(point) {
      if (typeof game.aimAt !== 'function') throw new TypeError('Play runtime must implement aimAt()');
      return interact('aimAt', clone(point));
    },
    fire() { return interact('fire'); },
    fireAt(point) {
      if (typeof game.fireAt !== 'function') throw new TypeError('Play runtime must implement fireAt()');
      return interact('fireAt', clone(point));
    },
    step(elapsedMs) { interact('step', elapsedMs); return clone(current); },
    reset() { interact('reset'); return clone(current); },
    setDebug(nextDebug) {
      assertOpen();
      if (!nextDebug || typeof nextDebug !== 'object' || Array.isArray(nextDebug)) {
        throw new TypeError('Debug state must be an object');
      }
      debug = clone(nextDebug);
      return clone(debug);
    },
    subscribe(subscriber) {
      assertOpen();
      if (typeof subscriber !== 'function') throw new TypeError('Play subscribers must be functions');
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    exit() {
      if (!closed) {
        game.dispose?.();
        closed = true;
        subscribers.clear();
        debug = {};
      }
      return clone(editDraft);
    },
  });
}

/** Coordinates retry/next without allowing a runtime snapshot to replace a draft. */
export function createPlaySequence({
  levels,
  initialIndex = 0,
  config = null,
  assets = null,
  runtimeFactory,
  onLevelChange = () => {},
} = {}) {
  if (!Array.isArray(levels) || levels.length === 0) throw new TypeError('Play sequence requires levels');
  if (!Number.isInteger(initialIndex) || initialIndex < 0 || initialIndex >= levels.length) {
    throw new RangeError('Initial play level is out of range');
  }
  const subscribers = new Set();
  let index = initialIndex;
  let session;
  let unsubscribe;
  let current;
  let closed = false;

  const publish = (snapshot) => {
    current = clone(snapshot);
    for (const subscriber of subscribers) subscriber(clone(current));
    return clone(current);
  };
  const open = () => {
    session = createPlaySession({ draft: levels[index], config, assets, runtimeFactory });
    current = session.snapshot();
    unsubscribe = session.subscribe(publish);
    publish(current);
  };
  const replace = (nextIndex) => {
    unsubscribe?.();
    session?.exit();
    index = nextIndex;
    open();
  };
  const assertOpen = () => {
    if (closed) throw new Error('Play sequence is closed');
  };
  open();

  return Object.freeze({
    get index() { return index; },
    get closed() { return closed; },
    snapshot() { assertOpen(); return clone(current); },
    getSnapshot() { assertOpen(); return clone(current); },
    refresh() { assertOpen(); return publish(session.refresh()); },
    selectProjectile(type) { assertOpen(); return session.selectProjectile(type); },
    aim(delta) { assertOpen(); return session.aim(delta); },
    aimAt(point) { assertOpen(); return session.aimAt(point); },
    fire() { assertOpen(); return session.fire(); },
    fireAt(point) { assertOpen(); return session.fireAt(point); },
    step(milliseconds) { assertOpen(); return session.step(milliseconds); },
    retry() { assertOpen(); replace(index); return clone(current); },
    next() {
      assertOpen();
      if (current.phase !== 'won' || index >= levels.length - 1) return false;
      const nextIndex = index + 1;
      replace(nextIndex);
      onLevelChange(nextIndex, clone(levels[nextIndex]));
      return true;
    },
    subscribe(subscriber) {
      assertOpen();
      if (typeof subscriber !== 'function') throw new TypeError('Play subscribers must be functions');
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    exit() {
      if (!closed) {
        unsubscribe?.();
        session.exit();
        subscribers.clear();
        closed = true;
      }
      return clone(levels[index]);
    },
  });
}
