import React, { useEffect, useRef } from 'react'

export interface FluidOrbProps extends React.ComponentPropsWithoutRef<'div'> {
  size?: number
  color?: string
}

const VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_color;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.6;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * 0.22;

  vec2 drift = vec2(
    sin(t) + 0.6 * sin(t * 1.7 + 1.3),
    cos(t * 0.8) + 0.6 * cos(t * 1.3 + 2.1)
  );

  vec2 p = vec2(uv.x * 1.8, uv.y * 1.0) + drift * 0.7;

  vec2 q = vec2(fbm(p + drift), fbm(p + vec2(3.2, 1.5) - drift));
  float f = fbm(p + 1.2 * q);

  float g = clamp(1.0 - uv.y, 0.0, 1.0);
  float anchor = smoothstep(0.0, 0.3, uv.y);
  float shade = clamp(g + (f - 0.5) * 0.8 * anchor, 0.0, 1.0);

  vec3 white = vec3(0.99, 1.0, 1.0);
  vec3 light = mix(white, u_color, 0.5);
  vec3 dark = u_color;

  vec3 col = white;
  col = mix(col, light, smoothstep(0.28, 0.52, shade));
  col = mix(col, dark, smoothstep(0.58, 0.88, shade));

  float edge = smoothstep(0.5, 0.49, distance(uv, vec2(0.5)));

  gl_FragColor = vec4(col * edge, edge * 0.95);
}
`

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  }
  const n = parseInt(h, 16)
  if (h.length !== 6 || Number.isNaN(n)) return [0.38, 0.4, 0.94]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function compileShader(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export default function FluidOrb({
  size = 120,
  color = '#6366F1',
  className = '',
  style,
  ...props
}: FluidOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // 安全防御：在无 WebGL 环境（如 JSDOM 测试环境）不崩溃
    if (typeof window === 'undefined' || !window.WebGLRenderingContext) {
      return
    }

    let gl: WebGLRenderingContext | null = null
    try {
      gl = canvas.getContext('webgl', { antialias: true, alpha: true })
    } catch {
      return
    }
    if (!gl) return

    const program = gl.createProgram()
    const vert = compileShader(gl, gl.VERTEX_SHADER, VERT)
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!program || !vert || !frag) return

    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      return
    }
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    )

    const aPos = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const uRes = gl.getUniformLocation(program, 'u_resolution')
    const uTime = gl.getUniformLocation(program, 'u_time')
    const uColor = gl.getUniformLocation(program, 'u_color')

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * dpr
    canvas.height = size * dpr
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.uniform2f(uRes, canvas.width, canvas.height)

    const [r, g, b] = hexToRgb(color)
    gl.uniform3f(uColor, r, g, b)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    let reqId = 0
    let lastTime = performance.now()
    let elapsedSec = 0
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

    const render = (now: number) => {
      const delta = (now - lastTime) / 1000
      lastTime = now
      if (!mediaQuery.matches) {
        elapsedSec += Math.min(delta, 0.1)
      }
      if (gl) {
        gl.uniform1f(uTime, elapsedSec)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      reqId = requestAnimationFrame(render)
    }

    reqId = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(reqId)
      if (gl) {
        gl.deleteBuffer(buffer)
        gl.deleteProgram(program)
        gl.deleteShader(vert)
        gl.deleteShader(frag)
      }
    }
  }, [size, color])

  return (
    <div
      className={`relative inline-flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size }}
        className="pointer-events-none drop-shadow-md select-none"
      />
    </div>
  )
}
