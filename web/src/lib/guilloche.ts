import { Mesh, NoBlending, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector2, Vector3, WebGLRenderer } from "three";

/**
 * A sunburst dial under the network plate: fine grooves brushed out from the centre, which catch
 * the light in two opposite wedges. The light turns toward the pointer, as a watch dial does when
 * it is tilted under a lamp, and drifts slowly when the pointer is still. Loaded on demand
 * (components/Guilloche.tsx), so the page never waits for Three.js.
 */

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragment = /* glsl */ `
  precision highp float;
  uniform vec2 uRes;
  uniform float uLight;
  uniform float uGlow;
  uniform vec3 uBase;
  uniform vec3 uHi;
  uniform vec3 uLo;
  varying vec2 vUv;
  #define TAU 6.283185307179586

  void main() {
    // Centred, aspect-correct, one unit = the canvas height.
    vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    float r = length(p);
    float a = atan(p.y, p.x);

    // Grooves facing the light shine, those across it fall into shade.
    float sheen = pow(abs(cos(a - uLight)), 5.0) * uGlow;
    float shade = pow(abs(sin(a - uLight)), 3.0);

    // The grooves themselves, faded out where they would be finer than a few pixels.
    float spacing = r * uRes.y * TAU / 420.0;
    float grooves = mix(0.5, 0.5 + 0.5 * cos(a * 420.0), smoothstep(1.5, 4.0, spacing));

    vec3 col = mix(uBase, uHi, sheen * (0.55 + 0.45 * grooves));
    col = mix(col, uLo, shade * 0.6 * (0.7 + 0.3 * (1.0 - grooves)));

    // The dial melts into the page at its edge.
    float alpha = smoothstep(0.5, 0.18, r);
    gl_FragColor = vec4(col * alpha, alpha);
  }
`;

type Rgb = [number, number, number];

function cssColor(name: string): Rgb {
  const hex = getComputedStyle(document.documentElement).getPropertyValue(name).trim().replace("#", "");
  const n = parseInt(hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex, 16);
  return Number.isNaN(n) ? [0.95, 0.95, 0.94] : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The dial's three tones, from the theme's dial colour: a light silver dial or a dark anthracite one. */
function tones(): { base: Rgb; hi: Rgb; lo: Rgb } {
  const base = cssColor("--color-dial");
  const dark = base[0] + base[1] + base[2] < 1.2;
  return dark
    ? { base, hi: mix(base, [1, 1, 1], 0.075), lo: mix(base, [0, 0, 0], 0.35) }
    : { base, hi: mix(base, [1, 1, 1], 0.7), lo: mix(base, [0, 0, 0], 0.055) };
}

/** Starts the dial on the canvas. Returns null when WebGL is not available. */
export function mountGuilloche(canvas: HTMLCanvasElement, { still }: { still: boolean }) {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: "low-power" });
  } catch {
    return null;
  }
  renderer.setClearColor(0x000000, 0);

  const target = tones();
  const now = tones();
  const uniforms = {
    uRes: { value: new Vector2(1, 1) },
    uLight: { value: -2.3 },
    uGlow: { value: 0.8 },
    uBase: { value: new Vector3(...now.base) },
    uHi: { value: new Vector3(...now.hi) },
    uLo: { value: new Vector3(...now.lo) },
  };
  const geometry = new PlaneGeometry(2, 2);
  // The shader writes premultiplied colour straight into the canvas, which the page composites;
  // blending it again would darken the edge where the dial fades out.
  const material = new ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms, blending: NoBlending, depthTest: false });
  const scene = new Scene();
  scene.add(new Mesh(geometry, material));
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const render = () => renderer.render(scene, camera);

  const resize = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    renderer.getDrawingBufferSize(uniforms.uRes.value);
    render();
  };
  const sizes = new ResizeObserver(resize);
  sizes.observe(canvas);
  resize();

  // The theme can change while the page is open: the dial follows over a few frames.
  const theme = new MutationObserver(() => {
    Object.assign(target, tones());
    if (still) {
      Object.assign(now, target);
      setTones();
      render();
    }
  });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
  function setTones() {
    uniforms.uBase.value.set(...now.base);
    uniforms.uHi.value.set(...now.hi);
    uniforms.uLo.value.set(...now.lo);
  }

  if (still) {
    render();
    return {
      stop() {
        sizes.disconnect();
        theme.disconnect();
        geometry.dispose();
        material.dispose();
        renderer.dispose();
      },
    };
  }

  // Where the light should be, from the pointer; the light eases toward it along the short way round.
  let aim = uniforms.uLight.value;
  let near = 0;
  let lastMove = -Infinity;
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    aim = Math.atan2(dy, dx);
    near = Math.max(0, 1 - Math.hypot(dx, dy) / (r.width * 1.4));
    lastMove = performance.now();
  };
  window.addEventListener("pointermove", onMove, { passive: true });

  let last = performance.now();
  const frame = (t: number) => {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    // Still pointer: the light drifts round on its own, slowly.
    if (t - lastMove > 3000) aim += dt * 0.16;
    const diff = Math.atan2(Math.sin(aim - uniforms.uLight.value), Math.cos(aim - uniforms.uLight.value));
    uniforms.uLight.value += diff * (1 - Math.exp(-dt * 3.2));
    const glow = 0.78 + 0.22 * (t - lastMove < 3000 ? near : 0);
    uniforms.uGlow.value += (glow - uniforms.uGlow.value) * (1 - Math.exp(-dt * 2.5));
    const k = 1 - Math.exp(-dt * 9);
    now.base = mix(now.base, target.base, k);
    now.hi = mix(now.hi, target.hi, k);
    now.lo = mix(now.lo, target.lo, k);
    setTones();
    render();
  };

  // Only draw while the dial is on screen.
  const seen = new IntersectionObserver(([entry]) => {
    last = performance.now();
    renderer.setAnimationLoop(entry?.isIntersecting ? frame : null);
  });
  seen.observe(canvas);

  return {
    stop() {
      renderer.setAnimationLoop(null);
      seen.disconnect();
      sizes.disconnect();
      theme.disconnect();
      window.removeEventListener("pointermove", onMove);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
