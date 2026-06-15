/* ═══════════════════════════════════════════════════════════════════
   HERMES OS — Animation Utilities
   Particle backgrounds, typewriter, counters, transitions
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Initialize floating particle background on a canvas element.
 * Creates ~60 tiny dots that drift slowly, with faint lines connecting
 * nearby particles and subtle parallax on mouse movement.
 *
 * @param {string} canvasId — ID of the <canvas> element
 * @returns {{ destroy: Function }} Cleanup handle
 */
export function initParticleBackground(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) {
    console.warn(`[Particles] Canvas #${canvasId} not found`);
    return { destroy: () => {} };
  }

  const ctx = canvas.getContext('2d');
  let animationId = null;
  let mouseX = 0;
  let mouseY = 0;
  let width = 0;
  let height = 0;

  const PARTICLE_COUNT = 60;
  const CONNECTION_DISTANCE = 140;
  const MOUSE_INFLUENCE = 0.02;

  /** @type {{ x: number, y: number, vx: number, vy: number, size: number, opacity: number }[]} */
  const particles = [];

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;
  }

  function createParticles() {
    particles.length = 0;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        size: Math.random() * 1.5 + 0.5,
        opacity: Math.random() * 0.4 + 0.1,
      });
    }
  }

  function onMouseMove(e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    // Update and draw particles
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      // Subtle parallax — drift toward mouse very slowly
      const dx = mouseX - p.x;
      const dy = mouseY - p.y;
      p.vx += dx * MOUSE_INFLUENCE * 0.001;
      p.vy += dy * MOUSE_INFLUENCE * 0.001;

      // Damping
      p.vx *= 0.99;
      p.vy *= 0.99;

      p.x += p.vx;
      p.y += p.vy;

      // Wrap around edges
      if (p.x < -10) p.x = width + 10;
      if (p.x > width + 10) p.x = -10;
      if (p.y < -10) p.y = height + 10;
      if (p.y > height + 10) p.y = -10;

      // Draw particle
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0, 240, 255, ${p.opacity})`;
      ctx.fill();

      // Draw connections to nearby particles
      for (let j = i + 1; j < particles.length; j++) {
        const p2 = particles[j];
        const dist = Math.hypot(p.x - p2.x, p.y - p2.y);

        if (dist < CONNECTION_DISTANCE) {
          const lineOpacity = (1 - dist / CONNECTION_DISTANCE) * 0.08;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.strokeStyle = `rgba(0, 240, 255, ${lineOpacity})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }

    animationId = requestAnimationFrame(draw);
  }

  // Initialize
  resize();
  createParticles();
  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', onMouseMove);
  draw();

  return {
    destroy() {
      if (animationId) cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouseMove);
    },
  };
}


/**
 * Typewriter effect — types text character by character.
 *
 * @param {HTMLElement} element — Target element
 * @param {string} text — Text to type
 * @param {number} speed — ms per character (default 30)
 * @returns {Promise<void>} Resolves when complete
 */
export function typeWriter(element, text, speed = 30) {
  return new Promise((resolve) => {
    element.textContent = '';
    let i = 0;

    function type() {
      if (i < text.length) {
        element.textContent += text.charAt(i);
        i++;
        setTimeout(type, speed);
      } else {
        resolve();
      }
    }

    type();
  });
}


/**
 * Animate a number counting up from 0 to target.
 *
 * @param {HTMLElement} element — Target element to update
 * @param {number} target — Final value
 * @param {number} duration — Animation duration in ms (default 1500)
 * @param {string} [prefix=''] — Prefix (e.g. '$')
 * @param {string} [suffix=''] — Suffix (e.g. '%')
 * @returns {Promise<void>}
 */
export function countUp(element, target, duration = 1500, prefix = '', suffix = '') {
  if (typeof duration === 'object' && duration !== null) {
    const options = duration;
    duration = options.duration ?? 1500;
    prefix = options.prefix ?? '';
    suffix = options.suffix ?? '';
  }

  const numericTarget = Number(target);
  if (!Number.isFinite(numericTarget)) {
    element.textContent = `${prefix}${target ?? 0}${suffix}`;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const start = performance.now();
    const isFloat = numericTarget % 1 !== 0;

    function update(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);

      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = eased * numericTarget;

      element.textContent = `${prefix}${isFloat ? current.toFixed(1) : Math.round(current).toLocaleString()}${suffix}`;

      if (progress < 1) {
        requestAnimationFrame(update);
      } else {
        element.textContent = `${prefix}${isFloat ? numericTarget.toFixed(1) : numericTarget.toLocaleString()}${suffix}`;
        resolve();
      }
    }

    requestAnimationFrame(update);
  });
}


/**
 * Fade an element in (opacity 0 → 1).
 *
 * @param {HTMLElement} element
 * @param {number} duration — ms (default 300)
 * @returns {Promise<void>}
 */
export function fadeIn(element, duration = 300) {
  return new Promise((resolve) => {
    element.style.opacity = '0';
    element.style.transition = `opacity ${duration}ms ease`;

    // Force reflow
    element.offsetHeight; // eslint-disable-line no-unused-expressions

    element.style.opacity = '1';

    const onEnd = () => {
      element.removeEventListener('transitionend', onEnd);
      element.style.transition = '';
      resolve();
    };

    element.addEventListener('transitionend', onEnd);

    // Fallback in case transitionend doesn't fire
    setTimeout(() => {
      element.style.opacity = '1';
      resolve();
    }, duration + 50);
  });
}


/**
 * Slide + fade an element in from a direction.
 *
 * @param {HTMLElement} element
 * @param {'up'|'down'|'left'|'right'} direction — Slide direction (default 'up')
 * @param {number} duration — ms (default 300)
 * @returns {Promise<void>}
 */
export function slideIn(element, direction = 'up', duration = 300) {
  const offsets = {
    up:    'translateY(20px)',
    down:  'translateY(-20px)',
    left:  'translateX(20px)',
    right: 'translateX(-20px)',
  };

  return new Promise((resolve) => {
    element.style.opacity = '0';
    element.style.transform = offsets[direction] || offsets.up;
    element.style.transition = `opacity ${duration}ms ease, transform ${duration}ms ease`;

    // Force reflow
    element.offsetHeight; // eslint-disable-line no-unused-expressions

    element.style.opacity = '1';
    element.style.transform = 'translate(0, 0)';

    const onEnd = () => {
      element.removeEventListener('transitionend', onEnd);
      element.style.transition = '';
      element.style.transform = '';
      resolve();
    };

    element.addEventListener('transitionend', onEnd);

    setTimeout(() => {
      element.style.opacity = '1';
      element.style.transform = '';
      resolve();
    }, duration + 50);
  });
}


/**
 * Create an expanding ripple circle at the click point.
 *
 * @param {MouseEvent} event
 */
export function rippleEffect(event) {
  const target = event.currentTarget || event.target;
  const rect = target.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  const ripple = document.createElement('span');
  ripple.className = 'ripple-circle';
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  ripple.style.width = '10px';
  ripple.style.height = '10px';
  ripple.style.marginLeft = '-5px';
  ripple.style.marginTop = '-5px';

  // Ensure container is position: relative
  if (getComputedStyle(target).position === 'static') {
    target.style.position = 'relative';
  }
  target.style.overflow = 'hidden';
  target.appendChild(ripple);

  // Remove after animation
  ripple.addEventListener('animationend', () => {
    ripple.remove();
  });
}


/**
 * Trigger a pulse animation on an element.
 *
 * @param {HTMLElement} element
 */
export function pulseElement(element) {
  element.classList.remove('animate-pulse');
  // Force reflow to restart animation
  element.offsetHeight; // eslint-disable-line no-unused-expressions
  element.classList.add('animate-pulse');

  const onEnd = () => {
    element.classList.remove('animate-pulse');
    element.removeEventListener('animationiteration', onEnd);
  };

  // Remove after one full cycle (2s)
  setTimeout(() => {
    element.classList.remove('animate-pulse');
  }, 2000);
}
