import { objectBounds, objectContainsPoint } from './editor-state.js';

const DEFAULT_SCALE = 42;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function traceShape(context, shape = {}) {
  if (shape.kind === 'circle') {
    context.arc(0, 0, shape.radius ?? 0.25, 0, Math.PI * 2);
  } else if (shape.kind === 'polygon' && shape.vertices?.length) {
    context.moveTo(shape.vertices[0].x, shape.vertices[0].y);
    shape.vertices.slice(1).forEach((vertex) => context.lineTo(vertex.x, vertex.y));
    context.closePath();
  } else {
    const width = shape.width ?? 0.5;
    const height = shape.height ?? 0.5;
    context.rect(-width / 2, -height / 2, width, height);
  }
}

export class CanvasEditor {
  constructor(canvas, state, { gridSize = 0.25, scale = DEFAULT_SCALE } = {}) {
    if (!canvas || !state?.dispatch) throw new TypeError('CanvasEditor requires a canvas and editor state');
    this.canvas = canvas;
    this.state = state;
    this.gridSize = gridSize;
    this.viewport = { x: 0, y: 0, zoom: 1 };
    this.mode = 'edit';
    this.simulation = null;
    this.playInteraction = null;
    this.scale = scale;
    this.gesture = null;
    this.destroyed = false;
    this.context = canvas.getContext?.('2d') ?? null;
    this.window = canvas.ownerDocument?.defaultView ?? globalThis.window;
    this.handlers = {
      pointerdown: (event) => this.pointerDown(event),
      pointermove: (event) => this.pointerMove(event),
      pointerup: (event) => this.pointerUp(event),
      pointercancel: (event) => this.pointerCancel(event),
      wheel: (event) => this.wheel(event),
      keydown: (event) => this.keyDown(event),
      resize: () => this.render(),
    };
    for (const [name, handler] of Object.entries(this.handlers)) {
      if (name === 'resize') this.window?.addEventListener?.(name, handler);
      else canvas.addEventListener?.(name, handler, name === 'wheel' ? { passive: false } : undefined);
    }
    canvas.setAttribute?.('tabindex', '0');
    canvas.setAttribute?.('aria-label', '关卡编辑画布');
    this.unsubscribe = state.subscribe(() => this.render());
    this.render();
  }

  worldFromEvent(event) {
    const rectangle = this.canvas.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const screenX = event.clientX - rectangle.left;
    const screenY = event.clientY - rectangle.top;
    return {
      x: (screenX - this.viewport.x) / (this.scale * this.viewport.zoom),
      y: (screenY - this.viewport.y) / (this.scale * this.viewport.zoom),
      screenX,
      screenY,
    };
  }

  originalWorldFromEvent(event) {
    const rectangle = this.canvas.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 360, height: 640 };
    return {
      x: ((event.clientX - rectangle.left) / rectangle.width) * 9,
      y: ((event.clientY - rectangle.top) / rectangle.height) * 16,
    };
  }

  hitTest(point) {
    return [...this.state.level.castle].reverse().find((object) => objectContainsPoint(object, point)) ?? null;
  }

  pointerDown(event) {
    if (this.mode === 'play') {
      if (event.button === 0) this.playInteraction?.fireAt?.(this.originalWorldFromEvent(event));
      return;
    }
    if (this.mode !== 'edit') return;
    if (event.button !== 0 && event.button !== 1) return;
    this.canvas.focus?.();
    this.canvas.setPointerCapture?.(event.pointerId);
    const point = this.worldFromEvent(event);
    const selection = this.state.selection;
    if (event.button === 1 || event.spaceKey || event.altKey) {
      this.gesture = { type: 'pan', start: point, viewport: { ...this.viewport }, selection };
      return;
    }
    const hit = this.hitTest(point);
    if (hit) {
      const mode = event.ctrlKey || event.metaKey || event.shiftKey ? 'toggle' : 'replace';
      if (!this.state.selection.includes(hit.id) || mode === 'toggle') {
        this.state.dispatch({ type: 'select', ids: [hit.id], mode });
      }
      this.gesture = { type: 'drag', start: point, last: point, selection };
    } else {
      this.gesture = { type: 'box', start: point, last: point, additive: event.ctrlKey || event.metaKey || event.shiftKey, selection };
      if (!this.gesture.additive) this.state.dispatch({ type: 'select', ids: [] });
      this.render();
    }
  }

  pointerMove(event) {
    if (this.mode === 'play') {
      this.playInteraction?.aimAt?.(this.originalWorldFromEvent(event));
      return;
    }
    if (this.mode !== 'edit') return;
    if (!this.gesture) return;
    const point = this.worldFromEvent(event);
    if (this.gesture.type === 'pan') {
      this.viewport.x = this.gesture.viewport.x + point.screenX - this.gesture.start.screenX;
      this.viewport.y = this.gesture.viewport.y + point.screenY - this.gesture.start.screenY;
      this.render();
    } else if (this.gesture.type === 'drag') {
      this.gesture.last = point;
      this.render();
    } else {
      this.gesture.last = point;
      this.render();
    }
  }

  pointerUp(event) {
    if (this.mode !== 'edit') return;
    if (!this.gesture) return;
    if (this.gesture.type === 'drag') {
      const end = this.worldFromEvent(event);
      const moved = Math.hypot(end.screenX - this.gesture.start.screenX, end.screenY - this.gesture.start.screenY) >= 3;
      if (moved) {
        this.state.dispatch({
          type: 'move',
          dx: end.x - this.gesture.start.x,
          dy: end.y - this.gesture.start.y,
          snap: true,
        });
      }
    } else if (this.gesture.type === 'box') {
      const end = this.worldFromEvent(event);
      const bounds = {
        left: Math.min(this.gesture.start.x, end.x),
        right: Math.max(this.gesture.start.x, end.x),
        top: Math.min(this.gesture.start.y, end.y),
        bottom: Math.max(this.gesture.start.y, end.y),
      };
      this.state.dispatch({ type: 'selectBox', bounds, mode: this.gesture.additive ? 'add' : 'replace' });
    }
    this.gesture = null;
    this.canvas.releasePointerCapture?.(event.pointerId);
    this.render();
  }

  pointerCancel(event) {
    if (this.mode !== 'edit') return;
    if (!this.gesture) return;
    if (this.gesture.type === 'pan') this.viewport = { ...this.gesture.viewport };
    this.state.dispatch({ type: 'select', ids: this.gesture.selection });
    this.gesture = null;
    this.canvas.releasePointerCapture?.(event.pointerId);
    this.render();
  }

  wheel(event) {
    if (this.mode !== 'edit') return;
    event.preventDefault?.();
    const point = this.worldFromEvent(event);
    const nextZoom = clamp(this.viewport.zoom * Math.exp(-event.deltaY * 0.0015), 0.25, 4);
    this.viewport.x = point.screenX - point.x * this.scale * nextZoom;
    this.viewport.y = point.screenY - point.y * this.scale * nextZoom;
    this.viewport.zoom = nextZoom;
    this.render();
  }

  keyDown(event) {
    if (this.mode !== 'edit') return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault?.();
      event.shiftKey ? this.state.redo() : this.state.undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'd') {
      event.preventDefault?.();
      this.state.dispatch({ type: 'duplicate' });
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault?.();
      this.state.dispatch({ type: 'delete' });
      return;
    }
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault?.();
    const distance = event.shiftKey ? this.gridSize * 4 : this.gridSize;
    this.state.dispatch({ type: 'move', dx: direction[0] * distance, dy: direction[1] * distance, snap: false });
  }

  render() {
    const context = this.context;
    if (!context || this.destroyed) return;
    const rectangle = this.canvas.getBoundingClientRect?.() ?? { width: this.canvas.clientWidth || 800, height: this.canvas.clientHeight || 500 };
    const ratio = this.window?.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rectangle.width * ratio));
    const height = Math.max(1, Math.round(rectangle.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rectangle.width, rectangle.height);
    context.save();
    context.translate(this.viewport.x, this.viewport.y);
    context.scale(this.scale * this.viewport.zoom, this.scale * this.viewport.zoom);
    this.drawGrid(context, rectangle);
    const dragOffset = this.gesture?.type === 'drag' ? {
      x: this.gesture.last.x - this.gesture.start.x,
      y: this.gesture.last.y - this.gesture.start.y,
    } : null;
    const castle = this.mode === 'edit' ? this.state.level.castle : (this.simulation?.bodies ?? this.simulation?.castle ?? []);
    for (const object of castle) {
      const selected = this.mode === 'edit' && this.state.selection.includes(object.id);
      this.drawObject(context, selected && dragOffset ? { ...object, x: object.x + dragOffset.x, y: object.y + dragOffset.y } : object, selected);
      if (this.mode === 'debug') this.drawDebugObject(context, object);
    }
    if (this.mode !== 'edit') this.drawProjectiles(context, this.simulation?.projectiles ?? []);
    if (this.mode !== 'edit') this.drawSpecialEffects(context, this.simulation);
    if (this.mode === 'debug') this.drawExplosionRadii(context, this.simulation?.explosionEvents ?? []);
    if (this.gesture?.type === 'box') this.drawSelectionBox(context, this.gesture.start, this.gesture.last);
    context.restore();
  }

  drawGrid(context, rectangle) {
    const span = 50;
    context.beginPath();
    context.lineWidth = 1 / (this.scale * this.viewport.zoom);
    context.strokeStyle = 'rgba(126, 153, 177, 0.14)';
    for (let coordinate = -span; coordinate <= span; coordinate += this.gridSize) {
      context.moveTo(coordinate, -span);
      context.lineTo(coordinate, span);
      context.moveTo(-span, coordinate);
      context.lineTo(span, coordinate);
    }
    context.stroke();
  }

  drawObject(context, object, selected) {
    const shape = object.shape ?? {};
    context.save();
    context.translate(object.x, object.y);
    context.rotate(object.angle || 0);
    context.beginPath();
    traceShape(context, shape);
    context.fillStyle = object.color || '#718da8';
    context.fill();
    context.lineWidth = (selected ? 3 : 1) / (this.scale * this.viewport.zoom);
    context.strokeStyle = selected ? '#ffb36e' : 'rgba(255,255,255,.48)';
    context.stroke();
    if (selected) {
      const bounds = objectBounds({ ...object, x: 0, y: 0, angle: 0 });
      context.setLineDash([0.08, 0.05]);
      context.strokeStyle = '#67c5c1';
      context.strokeRect(bounds.left - 0.08, bounds.top - 0.08, bounds.right - bounds.left + 0.16, bounds.bottom - bounds.top + 0.16);
    }
    context.restore();
  }

  drawProjectiles(context, projectiles) {
    for (const projectile of projectiles) {
      context.save();
      context.beginPath();
      context.arc(projectile.position?.x ?? 0, projectile.position?.y ?? 0, projectile.radius ?? 0.2, 0, Math.PI * 2);
      const colors = { explosive: '#ff784f', split: '#37c7d9', splitChild: '#75e1ed', blackHole: '#7b4ce2' };
      context.fillStyle = colors[projectile.type] ?? '#d8e1ea';
      context.fill();
      context.lineWidth = 0.04;
      context.strokeStyle = projectile.type === 'blackHole' ? '#1a082c' : 'rgba(255,255,255,.7)';
      context.stroke();
      context.restore();
    }
  }

  drawSpecialEffects(context, simulation = {}) {
    for (const effect of simulation?.specialEffects ?? []) {
      const alpha = Math.max(0, Math.min(1, effect.remainingMs / 260));
      context.save();
      context.translate(effect.position.x, effect.position.y);
      context.strokeStyle = `rgba(255,245,170,${alpha})`;
      context.lineWidth = 0.08;
      for (let index = 0; index < 8; index += 1) {
        const angle = index * Math.PI / 4;
        context.beginPath();
        context.moveTo(Math.cos(angle) * 0.12, Math.sin(angle) * 0.12);
        context.lineTo(Math.cos(angle) * 0.5, Math.sin(angle) * 0.5);
        context.stroke();
      }
      context.restore();
    }
    for (const blackHole of simulation?.blackHoles ?? []) {
      const config = this.simulation?.blackHoleConfig ?? {};
      const rotation = (blackHole.ageMs ?? 0) / 260;
      context.save();
      context.translate(blackHole.position.x, blackHole.position.y);
      context.rotate(rotation);
      context.strokeStyle = '#9a65ff';
      context.lineWidth = 0.13;
      context.beginPath();
      context.arc(0, 0, Number(config.consumeRadius ?? 0.65) * 1.15, 0.35, Math.PI * 1.75);
      context.stroke();
      context.rotate(Math.PI);
      context.strokeStyle = '#5e2bb7';
      context.beginPath();
      context.arc(0, 0, Number(config.consumeRadius ?? 0.65) * 0.92, 0.2, Math.PI * 1.7);
      context.stroke();
      context.fillStyle = '#0b0615';
      context.beginPath();
      context.arc(0, 0, Number(config.consumeRadius ?? 0.65) * 0.58, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  }

  drawDebugObject(context, object) {
    context.save();
    context.translate(object.x, object.y);
    context.rotate(object.angle || 0);
    context.beginPath();
    traceShape(context, object.shape);
    context.setLineDash([0.06, 0.04]);
    context.lineWidth = 2 / (this.scale * this.viewport.zoom);
    context.strokeStyle = '#67c5c1';
    context.stroke();
    context.restore();

    const velocity = object.velocity ?? { x: 0, y: 0 };
    context.save();
    context.font = `${11 / (this.scale * this.viewport.zoom)}px monospace`;
    context.fillStyle = '#dce9f3';
    context.fillText(`${object.id} · HP ${object.hp ?? object.maxHp ?? '—'}`, object.x + 0.08, object.y - 0.16);
    context.fillText(`v ${Number(velocity.x ?? 0).toFixed(2)},${Number(velocity.y ?? 0).toFixed(2)}`, object.x + 0.08, object.y + 0.1);
    context.restore();
  }

  drawExplosionRadii(context, events) {
    for (const event of events) {
      context.save();
      context.beginPath();
      context.arc(event.position?.x ?? 0, event.position?.y ?? 0, event.radius ?? 0, 0, Math.PI * 2);
      context.setLineDash([0.1, 0.06]);
      context.lineWidth = 2 / (this.scale * this.viewport.zoom);
      context.strokeStyle = '#ff784f';
      context.stroke();
      context.restore();
    }
  }

  captureEditContext() {
    return Object.freeze({ selection: Object.freeze(this.state.selection), viewport: Object.freeze({ ...this.viewport }) });
  }

  restoreEditContext(context) {
    if (!context || !Array.isArray(context.selection) || !context.viewport) return;
    this.state.dispatch({ type: 'select', ids: context.selection, mode: 'replace' });
    this.viewport = { ...context.viewport };
    this.render();
  }

  setMode(mode, simulation = null) {
    if (!['edit', 'play', 'debug'].includes(mode)) throw new RangeError(`Unknown canvas mode: ${mode}`);
    this.gesture = null;
    this.mode = mode;
    this.simulation = mode === 'edit' ? null : simulation;
    this.canvas.dataset && (this.canvas.dataset.mode = mode);
    this.render();
  }

  setPlayInteraction(interaction) {
    if (interaction !== null && (typeof interaction?.aimAt !== 'function' || typeof interaction?.fireAt !== 'function')) {
      throw new TypeError('Play interaction requires aimAt() and fireAt()');
    }
    this.playInteraction = interaction;
  }

  drawSelectionBox(context, start, end) {
    context.save();
    context.fillStyle = 'rgba(103,197,193,.12)';
    context.strokeStyle = '#67c5c1';
    context.lineWidth = 1 / (this.scale * this.viewport.zoom);
    context.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
    context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
    context.restore();
  }

  destroy() {
    this.destroyed = true;
    this.unsubscribe?.();
    for (const [name, handler] of Object.entries(this.handlers)) {
      if (name === 'resize') this.window?.removeEventListener?.(name, handler);
      else this.canvas.removeEventListener?.(name, handler);
    }
  }
}
