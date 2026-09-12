"use client";

import { useEffect, useRef, type ReactNode } from "react";

const TAU = Math.PI * 2;
const PARTICLE_STRIDE = 4;

const PARTICLE_VERTEX_SHADER = `
attribute vec2 position;
attribute float diameter;
attribute float weight;
uniform vec2 resolution;
varying float particleWeight;

void main() {
  vec2 clip = position / resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = diameter;
  particleWeight = weight;
}`;

const PARTICLE_FRAGMENT_SHADER = `
precision mediump float;
varying float particleWeight;

void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float radiusSquared = dot(point, point);
  if (radiusSquared > 1.0) discard;
  float field = pow(1.0 - radiusSquared, 2.0) * particleWeight * 0.28;
  gl_FragColor = vec4(field, field, field, field);
}`;

const COMPOSITE_VERTEX_SHADER = `
attribute vec2 position;
varying vec2 textureCoordinate;

void main() {
  gl_Position = vec4(position, 0.0, 1.0);
  textureCoordinate = position * 0.5 + 0.5;
}`;

const COMPOSITE_FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D particleField;
uniform vec2 resolution;
uniform float time;
varying vec2 textureCoordinate;

vec2 gradientDirection(vec2 cell) {
  vec3 hash = fract(vec3(cell.xyx) * vec3(0.1031, 0.1030, 0.0973));
  hash += dot(hash, hash.yzx + 33.33);
  return fract((hash.xx + hash.yz) * hash.zy) * 2.0 - 1.0;
}

float perlinNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  vec2 fade = local * local * local * (local * (local * 6.0 - 15.0) + 10.0);

  float bottomLeft = dot(gradientDirection(cell), local);
  float bottomRight = dot(gradientDirection(cell + vec2(1.0, 0.0)), local - vec2(1.0, 0.0));
  float topLeft = dot(gradientDirection(cell + vec2(0.0, 1.0)), local - vec2(0.0, 1.0));
  float topRight = dot(gradientDirection(cell + vec2(1.0, 1.0)), local - vec2(1.0, 1.0));
  return mix(mix(bottomLeft, bottomRight, fade.x), mix(topLeft, topRight, fade.x), fade.y);
}

float haze(vec2 point) {
  float value = 0.0;
  float amplitude = 0.58;
  mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
  for (int octave = 0; octave < 5; octave++) {
    value += perlinNoise(point) * amplitude;
    point = turn * point * 1.93 + vec2(4.7, 8.2);
    amplitude *= 0.51;
  }
  return value;
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec2 aspect = vec2(resolution.x / max(resolution.y, 1.0), 1.0);
  vec2 drift = vec2(time * 0.010, -time * 0.006);
  float broadHaze = haze(uv * aspect * 1.55 + drift);
  float middleHaze = perlinNoise(uv * aspect * 3.4 - drift * 1.7 + vec2(9.3, 2.1));
  float fineHaze = perlinNoise(uv * aspect * 7.8 + drift * 0.7 + vec2(2.6, 12.4));

  vec3 lowCloud = vec3(0.70, 0.75, 0.76);
  vec3 highCloud = vec3(0.91, 0.92, 0.91);
  vec3 color = mix(lowCloud, highCloud, smoothstep(-0.10, 1.08, uv.y));
  color += vec3(0.100, 0.108, 0.108) * broadHaze;
  color += vec3(0.046, 0.052, 0.052) * middleHaze;
  color += vec3(0.013, 0.016, 0.016) * fineHaze;
  float cloudVeil = smoothstep(-0.30, 0.42, broadHaze + middleHaze * 0.42);
  color = mix(color, vec3(0.92, 0.93, 0.92), cloudVeil * 0.13);

  float density = texture2D(particleField, textureCoordinate).r;
  float joinedInk = smoothstep(0.072, 0.235, density);
  float softInk = smoothstep(0.010, 0.095, density) * 0.28;
  float inkMask = max(joinedInk, softInk);
  vec3 ink = vec3(0.12, 0.23, 0.25);
  color = mix(color, ink, inkMask * 0.74);

  gl_FragColor = vec4(color, 1.0);
}`;

interface RandomSource {
  (): number;
}

interface LogogramParticle {
  x: number;
  y: number;
  diameter: number;
  strength: number;
  phase: number;
  frequency: number;
  wobble: number;
  spin: number;
  fadeInDelay: number;
  fadeOutDelay: number;
  scatterAngle: number;
  scatterSpeed: number;
}

interface LogogramSymbol {
  centerX: number;
  centerY: number;
  radiusRatio: number;
  bornAt: number;
  formDuration: number;
  holdDuration: number;
  disperseDuration: number;
  particles: LogogramParticle[];
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function mix(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function smoothstep(value: number): number {
  const progress = clamp(value);
  return progress * progress * (3 - 2 * progress);
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - clamp(value), 3);
}

function range(random: RandomSource, minimum: number, maximum: number): number {
  return minimum + random() * (maximum - minimum);
}

function integer(random: RandomSource, minimum: number, maximum: number): number {
  return Math.floor(range(random, minimum, maximum + 1));
}

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function angularDistance(first: number, second: number): number {
  return Math.abs(((first - second + Math.PI) % TAU + TAU) % TAU - Math.PI);
}

/**
 * Builds particle targets from the same primitives used by arrival_logograms:
 * an imperfect circular stroke, clustered disks, sparse droplets, and tendrils.
 * https://github.com/FlxB2/arrival_logograms
 */
function createLogogramParticles(seed: number): LogogramParticle[] {
  const random = seededRandom(seed);
  const particles: LogogramParticle[] = [];
  const direction = random() > 0.5 ? 1 : -1;

  const addParticle = (x: number, y: number, diameter: number, strength = 1) => {
    particles.push({
      x,
      y,
      diameter,
      strength,
      phase: range(random, 0, TAU),
      frequency: range(random, 0.30, 0.68),
      wobble: range(random, 0.005, 0.016),
      spin: direction * range(random, 0.45, 0.90) * TAU,
      fadeInDelay: range(random, 0, 0.30),
      fadeOutDelay: range(random, 0, 0.28),
      scatterAngle: range(random, -0.72, 0.72),
      scatterSpeed: range(random, 0.72, 1.28),
    });
  };

  const gapAngle = range(random, 0, TAU);
  const gapHalfWidth = range(random, 0.16, 0.34);
  const ringPhaseA = range(random, 0, TAU);
  const ringPhaseB = range(random, 0, TAU);
  const ringCount = integer(random, 82, 104);

  for (let index = 0; index < ringCount; index += 1) {
    const angle = (index / ringCount) * TAU;
    const gapDistance = angularDistance(angle, gapAngle);
    if (gapDistance < gapHalfWidth || random() < 0.025) continue;

    const coherentWarp = Math.sin(angle * 3 + ringPhaseA) * 0.018
      + Math.sin(angle * 7 + ringPhaseB) * 0.009;
    const radius = 1 + coherentWarp + range(random, -0.022, 0.022);
    const diameter = range(random, 0.102, 0.142) * (random() < 0.08 ? 0.56 : 1);
    addParticle(Math.cos(angle) * radius, Math.sin(angle) * radius, diameter, range(random, 0.82, 1.08));

    if (random() < 0.18) {
      const inkOffset = range(random, -0.035, 0.035);
      addParticle(
        Math.cos(angle + inkOffset) * (radius + range(random, -0.035, 0.035)),
        Math.sin(angle + inkOffset) * (radius + range(random, -0.035, 0.035)),
        diameter * range(random, 0.55, 0.9),
        range(random, 0.55, 0.9),
      );
    }
  }

  const clusterCount = integer(random, 1, 4);
  const clusterAngles: number[] = [];
  for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex += 1) {
    const angle = range(random, 0, TAU);
    clusterAngles.push(angle);
    const diskCount = integer(random, 18, 34);

    for (let diskIndex = 0; diskIndex < diskCount; diskIndex += 1) {
      const diskAngle = angle + (random() - random()) * range(random, 0.12, 0.28);
      const diskRadius = 1 + (random() - random()) * 0.13;
      addParticle(
        Math.cos(diskAngle) * diskRadius + range(random, -0.035, 0.035),
        Math.sin(diskAngle) * diskRadius + range(random, -0.035, 0.035),
        range(random, 0.105, 0.235),
        range(random, 0.85, 1.25),
      );
    }

    const tendrilCount = integer(random, 1, 4);
    for (let tendrilIndex = 0; tendrilIndex < tendrilCount; tendrilIndex += 1) {
      const tendrilAngle = angle + range(random, -0.20, 0.20);
      let x = Math.cos(tendrilAngle) * range(random, 0.95, 1.07);
      let y = Math.sin(tendrilAngle) * range(random, 0.95, 1.07);
      let heading = tendrilAngle + range(random, -1.15, 1.15);
      const curl = range(random, -0.075, 0.075);
      const segmentCount = integer(random, 6, 13);

      for (let segment = 0; segment < segmentCount; segment += 1) {
        const progress = segment / Math.max(1, segmentCount - 1);
        heading += curl + range(random, -0.055, 0.055);
        const distance = range(random, 0.032, 0.061);
        x += Math.cos(heading) * distance;
        y += Math.sin(heading) * distance;
        addParticle(x, y, mix(0.075, 0.025, progress), mix(0.95, 0.58, progress));
      }
    }
  }

  const dropletCount = integer(random, 10, 22);
  for (let index = 0; index < dropletCount; index += 1) {
    const nearCluster = clusterAngles[integer(random, 0, clusterAngles.length - 1)];
    const angle = random() < 0.72 ? nearCluster + range(random, -0.45, 0.45) : range(random, 0, TAU);
    const radius = range(random, 0.86, 1.22);
    addParticle(
      Math.cos(angle) * radius,
      Math.sin(angle) * radius,
      range(random, 0.025, 0.068),
      range(random, 0.42, 0.82),
    );
  }

  return particles;
}

function chooseCenter(symbols: LogogramSymbol[], random: RandomSource): [number, number] {
  let bestX = 0.5;
  let bestY = 0.5;
  let bestDistance = -1;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const x = range(random, 0.035, 0.965);
    const y = range(random, 0.055, 0.945);
    const nearest = symbols.length === 0
      ? 1
      : Math.min(...symbols.map((symbol) => Math.hypot((x - symbol.centerX) * 1.45, y - symbol.centerY)));
    if (nearest > bestDistance) {
      bestX = x;
      bestY = y;
      bestDistance = nearest;
    }
  }

  return [bestX, bestY];
}

function createSymbol(symbols: LogogramSymbol[], bornAt: number): LogogramSymbol {
  const seed = Math.floor(Math.random() * 0xFFFFFFFF);
  const random = seededRandom(seed ^ 0x9E3779B9);
  const [centerX, centerY] = chooseCenter(symbols, random);
  return {
    centerX,
    centerY,
    radiusRatio: range(random, 0.072, 0.21),
    bornAt,
    formDuration: range(random, 3.8, 5.8),
    holdDuration: range(random, 14.0, 22.0),
    disperseDuration: range(random, 1.7, 2.8),
    particles: createLogogramParticles(seed),
  };
}

function symbolLifetime(symbol: LogogramSymbol): number {
  return symbol.formDuration + symbol.holdDuration + symbol.disperseDuration;
}

function appendSymbolVertices(
  vertices: number[],
  symbol: LogogramSymbol,
  now: number,
  width: number,
  height: number,
  pixelRatio: number,
  maximumPointSize: number,
  reducedMotion: boolean,
): void {
  const age = Math.max(0, now - symbol.bornAt);
  const formation = reducedMotion ? 1 : clamp(age / symbol.formDuration);
  const movement = easeOutCubic(formation);
  const disperseStart = symbol.formDuration + symbol.holdDuration;
  const disperse = reducedMotion ? 0 : clamp((age - disperseStart) / symbol.disperseDuration);
  const scatter = disperse * disperse;
  const radius = clamp(Math.min(width, height) * symbol.radiusRatio, 52, 200);
  const centerX = symbol.centerX * width;
  const centerY = symbol.centerY * height;
  const waveTime = Math.max(0, age - symbol.formDuration);

  for (const particle of symbol.particles) {
    const targetDistance = Math.hypot(particle.x, particle.y);
    const targetAngle = Math.atan2(particle.y, particle.x);
    const spiralAngle = targetAngle - particle.spin * Math.pow(1 - formation, 1.28);
    const travelledDistance = targetDistance * movement * radius;
    const waveStrength = reducedMotion ? 0 : movement * (1 - disperse);
    const wave = Math.sin(waveTime * particle.frequency * TAU + particle.phase);
    const crossWave = Math.cos(waveTime * particle.frequency * 0.71 * TAU + particle.phase * 1.7);
    const wobbleDistance = particle.wobble * radius * waveStrength;
    let x = centerX + Math.cos(spiralAngle) * travelledDistance;
    let y = centerY + Math.sin(spiralAngle) * travelledDistance;
    x += Math.cos(targetAngle + Math.PI / 2) * wave * wobbleDistance;
    y += Math.sin(targetAngle + Math.PI / 2) * wave * wobbleDistance;
    x += Math.cos(targetAngle) * crossWave * wobbleDistance * 0.42;
    y += Math.sin(targetAngle) * crossWave * wobbleDistance * 0.42;

    const scatterAngle = targetAngle + particle.scatterAngle;
    const scatterDistance = radius * (0.16 * disperse + 1.95 * scatter) * particle.scatterSpeed;
    x += Math.cos(scatterAngle) * scatterDistance;
    y += Math.sin(scatterAngle) * scatterDistance;

    const fadeIn = reducedMotion
      ? 1
      : smoothstep((formation - particle.fadeInDelay) / (1 - particle.fadeInDelay));
    const fadeOut = reducedMotion
      ? 1
      : 1 - smoothstep((disperse - particle.fadeOutDelay) / (1 - particle.fadeOutDelay));
    const opacity = fadeIn * fadeOut;
    if (opacity <= 0.002) continue;

    const oversized = mix(2.85, 1.16, smoothstep(formation));
    const diameter = Math.min(
      particle.diameter * radius * oversized * mix(1, 0.72, disperse) * pixelRatio,
      maximumPointSize,
    );
    vertices.push(
      x * pixelRatio,
      y * pixelRatio,
      Math.max(1, diameter),
      particle.strength * opacity,
    );
  }
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(
  gl: WebGLRenderingContext,
  vertexSource: string,
  fragmentSource: string,
): { program: WebGLProgram; vertex: WebGLShader; fragment: WebGLShader } | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    if (program) gl.deleteProgram(program);
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return null;
  }
  return { program, vertex, fragment };
}

export function HeptapodBackdrop(): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "low-power",
      premultipliedAlpha: false,
    });
    if (!canvas || !gl) return;

    const particlePipeline = createProgram(gl, PARTICLE_VERTEX_SHADER, PARTICLE_FRAGMENT_SHADER);
    const compositePipeline = createProgram(gl, COMPOSITE_VERTEX_SHADER, COMPOSITE_FRAGMENT_SHADER);
    const particleBuffer = gl.createBuffer();
    const quadBuffer = gl.createBuffer();
    const fieldTexture = gl.createTexture();
    const fieldFramebuffer = gl.createFramebuffer();
    if (!particlePipeline || !compositePipeline || !particleBuffer || !quadBuffer || !fieldTexture || !fieldFramebuffer) {
      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fieldFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fieldTexture, 0);

    const particlePosition = gl.getAttribLocation(particlePipeline.program, "position");
    const particleDiameter = gl.getAttribLocation(particlePipeline.program, "diameter");
    const particleWeight = gl.getAttribLocation(particlePipeline.program, "weight");
    const particleResolution = gl.getUniformLocation(particlePipeline.program, "resolution");
    const compositePosition = gl.getAttribLocation(compositePipeline.program, "position");
    const compositeResolution = gl.getUniformLocation(compositePipeline.program, "resolution");
    const compositeTime = gl.getUniformLocation(compositePipeline.program, "time");
    const compositeField = gl.getUniformLocation(compositePipeline.program, "particleField");
    const pointSizeRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
    const maximumPointSize = pointSizeRange[1];
    const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let pixelRatio = 1;
    let frame = 0;
    let disposed = false;
    let symbols: LogogramSymbol[] = [];
    let nextSpawnAt = 0;

    const resetScene = (now: number) => {
      symbols = [];
      for (let index = 0; index < 4; index += 1) {
        const symbol = createSymbol(symbols, now);
        const settledAge = index === 0
          ? range(Math.random, 0.15, symbol.formDuration * 0.45)
          : symbol.formDuration + range(Math.random, 0.4, symbol.holdDuration * 0.72);
        symbol.bornAt = now - settledAge;
        symbols.push(symbol);
      }
      nextSpawnAt = now + range(Math.random, 5, 10);
    };

    const resize = (): boolean => {
      const cssWidth = Math.max(1, canvas.clientWidth);
      const cssHeight = Math.max(1, canvas.clientHeight);
      pixelRatio = Math.min(
        window.devicePixelRatio || 1,
        1.5,
        maximumTextureSize / cssWidth,
        maximumTextureSize / cssHeight,
      );
      const width = Math.max(1, Math.round(cssWidth * pixelRatio));
      const height = Math.max(1, Math.round(cssHeight * pixelRatio));
      if (canvas.width === width && canvas.height === height) return false;
      canvas.width = width;
      canvas.height = height;
      gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return true;
    };

    const draw = (now: number) => {
      resize();
      const cssWidth = canvas.width / pixelRatio;
      const cssHeight = canvas.height / pixelRatio;
      if (!reducedMotion.matches) {
        symbols = symbols.filter((symbol) => now - symbol.bornAt < symbolLifetime(symbol));
        if (now >= nextSpawnAt) {
          symbols.push(createSymbol(symbols, now));
          nextSpawnAt = now + range(Math.random, 5, 10);
        }
      }

      const vertices: number[] = [];
      for (const symbol of symbols) {
        appendSymbolVertices(
          vertices,
          symbol,
          now,
          cssWidth,
          cssHeight,
          pixelRatio,
          maximumPointSize,
          reducedMotion.matches,
        );
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, fieldFramebuffer);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(particlePipeline.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
      const stride = PARTICLE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
      gl.enableVertexAttribArray(particlePosition);
      gl.vertexAttribPointer(particlePosition, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(particleDiameter);
      gl.vertexAttribPointer(particleDiameter, 1, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
      gl.enableVertexAttribArray(particleWeight);
      gl.vertexAttribPointer(particleWeight, 1, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);
      gl.uniform2f(particleResolution, canvas.width, canvas.height);
      gl.drawArrays(gl.POINTS, 0, vertices.length / PARTICLE_STRIDE);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.BLEND);
      gl.useProgram(compositePipeline.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(compositePosition);
      gl.vertexAttribPointer(compositePosition, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
      gl.uniform1i(compositeField, 0);
      gl.uniform2f(compositeResolution, canvas.width, canvas.height);
      gl.uniform1f(compositeTime, now);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const animate = (timestamp: number) => {
      frame = 0;
      if (disposed) return;
      draw(timestamp / 1_000);
      if (!reducedMotion.matches) frame = window.requestAnimationFrame(animate);
    };

    const redraw = () => {
      if (disposed || frame) return;
      frame = window.requestAnimationFrame(animate);
    };

    const resetForMotionPreference = () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      resetScene(performance.now() / 1_000);
      redraw();
    };

    resetScene(performance.now() / 1_000);
    redraw();
    window.addEventListener("resize", redraw);
    reducedMotion.addEventListener("change", resetForMotionPreference);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", redraw);
      reducedMotion.removeEventListener("change", resetForMotionPreference);
      gl.deleteFramebuffer(fieldFramebuffer);
      gl.deleteTexture(fieldTexture);
      gl.deleteBuffer(particleBuffer);
      gl.deleteBuffer(quadBuffer);
      gl.deleteProgram(particlePipeline.program);
      gl.deleteShader(particlePipeline.vertex);
      gl.deleteShader(particlePipeline.fragment);
      gl.deleteProgram(compositePipeline.program);
      gl.deleteShader(compositePipeline.vertex);
      gl.deleteShader(compositePipeline.fragment);
    };
  }, []);

  return <canvas ref={canvasRef} className="heptapod-backdrop" aria-hidden="true" />;
}
