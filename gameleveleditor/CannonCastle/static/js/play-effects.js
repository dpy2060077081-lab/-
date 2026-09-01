const FRAGMENT_VELOCITIES = [
  [-1.1, -0.9],
  [-0.55, -1.25],
  [0.25, -1.4],
  [0.9, -1.05],
  [1.25, -0.45],
  [-1.3, -0.3],
];
const EXPLOSION_LIFE = 350;
const OUT_OF_ARC_LIFE = 500;

const clone = value => structuredClone(value);

function textParticle(event) {
  const destroyed = event.type === 'destroyed';
  return {
    x: Number(event.position.x),
    y: Number(event.position.y),
    vx: 0,
    vy: -0.8,
    life: 650,
    initialLife: 650,
    kind: 'text',
    text: destroyed ? '破碎' : '-1',
    color: destroyed ? '#d93855' : '#ef476f',
  };
}

function fragmentParticles(event) {
  return FRAGMENT_VELOCITIES.map(([vx, vy]) => ({
    x: Number(event.position.x),
    y: Number(event.position.y),
    vx,
    vy,
    life: 500,
    initialLife: 500,
    kind: 'fragment',
    color: '#d93855',
  }));
}

export function createPlayEffects() {
  let particles = [];
  let explosionRings = [];
  let outOfArcLife = 0;
  return Object.freeze({
    ingest(events = []) {
      for (const event of events) {
        if (!event?.position || !['hit', 'destroyed'].includes(event.type)) continue;
        particles.push(textParticle(event));
        if (event.type === 'destroyed') particles.push(...fragmentParticles(event));
      }
    },
    ingestExplosions(events = []) {
      for (const event of events) {
        if (!event?.position || event.startsWave === false) continue;
        explosionRings.push({
          x: Number(event.position.x),
          y: Number(event.position.y),
          radius: Number(event.radius),
          life: EXPLOSION_LIFE,
          initialLife: EXPLOSION_LIFE,
        });
      }
    },
    showOutOfArc() { outOfArcLife = OUT_OF_ARC_LIFE; },
    advance(elapsedMs) {
      const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
      for (const particle of particles) {
        particle.life -= elapsed;
        particle.x += particle.vx * elapsed / 1000;
        particle.y += particle.vy * elapsed / 1000;
      }
      particles = particles.filter(({ life }) => life > 0);
      for (const ring of explosionRings) ring.life -= elapsed;
      explosionRings = explosionRings.filter(({ life }) => life > 0);
      outOfArcLife = Math.max(0, outOfArcLife - elapsed);
    },
    reset() {
      particles = [];
      explosionRings = [];
      outOfArcLife = 0;
    },
    snapshot() { return clone({ particles, explosionRings, outOfArcLife }); },
  });
}

export function drawPlayEffects(context, snapshot, {
  layout, viewport = {}, launcherPosition = { x: 4.5, y: 0.45 },
}) {
  const zoom = Number(viewport.zoom || 1);
  const scale = layout.scale * zoom;
  const fragmentSize = 4 / scale;
  const { particles = [], explosionRings = [], outOfArcLife = 0 } = snapshot || {};
  context.save();
  context.translate(layout.left + Number(viewport.x || 0), layout.top + Number(viewport.y || 0));
  context.scale(scale, scale);
  for (const ring of explosionRings) {
    const progress = 1 - ring.life / ring.initialLife;
    context.save();
    context.globalAlpha = Math.max(0, ring.life / ring.initialLife);
    context.strokeStyle = '#d93855';
    context.lineWidth = 2 / scale;
    context.beginPath();
    context.arc(ring.x, ring.y, ring.radius * progress, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
  for (const particle of particles) {
    context.save();
    context.globalAlpha = Math.max(0, particle.life / particle.initialLife);
    context.fillStyle = particle.color;
    if (particle.kind === 'text') {
      context.font = `700 ${14 / scale}px ui-monospace, monospace`;
      context.textAlign = 'center';
      context.fillText(particle.text ?? '', particle.x, particle.y);
    } else {
      context.fillRect(
        particle.x - fragmentSize / 2,
        particle.y - fragmentSize / 2,
        fragmentSize,
        fragmentSize,
      );
    }
    context.restore();
  }
  if (outOfArcLife > 0) {
    context.save();
    context.globalAlpha = Math.min(1, outOfArcLife / 150);
    context.fillStyle = '#d93855';
    context.font = `700 ${14 / scale}px ui-monospace, monospace`;
    context.textAlign = 'center';
    context.fillText('超出射界', launcherPosition.x, launcherPosition.y + 32 / 40);
    context.restore();
  }
  context.restore();
}
