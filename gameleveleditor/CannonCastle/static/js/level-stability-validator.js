import { createOriginalRuntime } from './original-runtime-adapter.js';
import { objectBounds, placementConstants } from './placement-collision.js';

const DEFAULTS = Object.freeze({
  stepMs: 1000 / 60, maxMs: 8000, settleLinearSpeed: 0.12, settleAngularSpeed: 0.12,
  settleDurationMs: 1200, maxDisplacement: 0.08, maxAngle: 3 * Math.PI / 180,
});

export async function validateLevelStability(level, {
  config, assets, signal, createRuntime = createOriginalRuntime, thresholds = {},
  yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)), yieldEverySteps = 16,
} = {}) {
  const options = { ...DEFAULTS, ...thresholds };
  let runtime;
  try {
    runtime = createRuntime({ level, config, assets, globalPhysics: config?.runtime });
    const initial = new Map((level.castle ?? []).map(object => [object.id, { ...object, hp: null }]));
    const initialSnapshot = runtime.snapshot();
    for (const body of initialSnapshot.bodies ?? []) if (initial.has(body.id)) initial.get(body.id).hp = body.hp;
    let settledFor = 0;
    let maximumDisplacement = 0;
    let maximumAngle = 0;
    let displacementObjectId = null;
    let angleObjectId = null;
    let steps = 0;
    for (let elapsed = 0; elapsed < options.maxMs; elapsed += options.stepMs) {
      if (signal?.aborted) return { ok: false, reason: 'cancelled', elapsedMs: elapsed };
      const snapshot = runtime.step(options.stepMs);
      steps += 1;
      const bodies = (snapshot.bodies ?? []).filter(body => initial.has(body.id));
      if (bodies.length !== initial.size || Number(snapshot.remainingTargets) !== initial.size) return { ok: false, reason: 'missing', elapsedMs: elapsed };
      if ((snapshot.damageEvents?.length ?? 0) || (snapshot.explosionEvents?.length ?? 0) || bodies.some(body => body.hp !== initial.get(body.id).hp)) return { ok: false, reason: 'damage', elapsedMs: elapsed };
      let quiet = true;
      for (const body of bodies) {
        const source = initial.get(body.id);
        const displacement = Math.hypot(body.x - source.x, body.y - source.y);
        const angle = source.shape?.kind === 'circle' ? 0 : Math.abs(Math.atan2(Math.sin(body.angle - source.angle), Math.cos(body.angle - source.angle)));
        if (displacement > maximumDisplacement) { maximumDisplacement = displacement; displacementObjectId = body.id; }
        if (angle > maximumAngle) { maximumAngle = angle; angleObjectId = body.id; }
        const bounds = objectBounds({ ...source, x: body.x, y: body.y, angle: body.angle });
        if (bounds.minX < placementConstants.WORLD_MIN_X || bounds.maxX > placementConstants.WORLD_MAX_X || bounds.minY < 0 || bounds.maxY > placementConstants.PLATFORM_TOP_Y + 0.01) return { ok: false, reason: 'unstableBounds', elapsedMs: elapsed, objectId: body.id, bounds };
        if (Math.hypot(body.vx, body.vy) >= options.settleLinearSpeed || Math.abs(body.angularVelocity) >= options.settleAngularSpeed) quiet = false;
      }
      if (maximumDisplacement > options.maxDisplacement) return { ok: false, reason: 'displacement', elapsedMs: elapsed, maximumDisplacement, maximumAngle, objectId: displacementObjectId };
      if (maximumAngle > options.maxAngle) return { ok: false, reason: 'angle', elapsedMs: elapsed, maximumDisplacement, maximumAngle, objectId: angleObjectId };
      settledFor = quiet ? settledFor + options.stepMs : 0;
      if (settledFor >= options.settleDurationMs) {
        return { ok: true, elapsedMs: elapsed, settledForMs: settledFor, maximumDisplacement, maximumAngle };
      }
      if (steps % Math.max(1, yieldEverySteps) === 0) {
        await yieldControl();
        if (signal?.aborted) return { ok: false, reason: 'cancelled', elapsedMs: elapsed + options.stepMs };
      }
    }
    return { ok: false, reason: 'timeout', elapsedMs: options.maxMs, maximumDisplacement, maximumAngle };
  } catch (error) {
    return { ok: false, reason: signal?.aborted ? 'cancelled' : 'runtime', error: error?.message ?? String(error) };
  } finally {
    runtime?.dispose?.();
  }
}

