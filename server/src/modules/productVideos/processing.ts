import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from '../../lib/httpError.js'
import { VIDEO_MAX_BYTES, VIDEO_POSTER_MAX_BYTES } from '../../lib/storage/videoKeys.js'

export type VideoMetadata = { durationMs: number; width: number; height: number; hasAudio: boolean }
const invalid = () => new HttpError(422, 'VIDEO_INVALID', '视频无法处理，请更换素材后重试')

function videoRotation(stream: Record<string, unknown>): number {
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list as Array<Record<string, unknown>> : []
  return Number(sideData.find(s => s.side_data_type === 'Display Matrix')?.rotation
    ?? (stream.tags as Record<string, unknown> | undefined)?.rotate ?? 0)
}

/** All media processes are local, unprivileged and bounded; never interpret an uploaded name as a command. */
async function run(command: string, args: string[], signal: AbortSignal, timeout = 360_000): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn('prlimit', ['--as=2147483648', '--cpu=300', '--fsize=67108864', '--', command, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C', OMP_NUM_THREADS: '1' },
    })
    let output = ''; let bytes = 0; let exceeded = false
    const kill = () => child.kill('SIGKILL')
    const timer = setTimeout(kill, timeout)
    signal.addEventListener('abort', kill, { once: true })
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 128 * 1024) { exceeded = true; kill() } else output += chunk.toString()
    })
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 128 * 1024) { exceeded = true; kill() } })
    const clear = () => { clearTimeout(timer); signal.removeEventListener('abort', kill) }
    child.once('error', () => { clear(); reject(new HttpError(503, 'VIDEO_PROCESSING_UNAVAILABLE', '视频处理暂不可用')) })
    child.once('close', code => {
      clear()
      if (code !== 0 || exceeded || signal.aborted) reject(invalid())
      else resolve(output)
    })
  })
}

export async function videoToolsAvailable() {
  try {
    const signal = AbortSignal.timeout(5_000)
    await run('ffprobe', ['-version'], signal, 5_000)
    const encoders = await run('ffmpeg', ['-hide_banner', '-encoders'], signal, 5_000)
    const filters = await run('ffmpeg', ['-hide_banner', '-filters'], signal, 5_000)
    return encoders.includes('libx264') && /\baac\b/.test(encoders) && /\bzscale\b/.test(filters) && /\btonemap\b/.test(filters)
  } catch { return false }
}

export function validateVideoProbe(probe: unknown, source = false): VideoMetadata {
  const data = probe as { format?: { format_name?: string; duration?: string }; streams?: Array<Record<string, unknown>> }
  if (!data || !Array.isArray(data.streams) || !data.format?.format_name?.split(',').includes('mp4')) throw invalid()
  const video = data.streams.filter(s => s.codec_type === 'video')
  const audio = data.streams.filter(s => s.codec_type === 'audio')
  if (video.length !== 1 || audio.length > 1 || data.streams.some(s => !['video', 'audio', 'data'].includes(String(s.codec_type)))) throw invalid()
  const v = video[0]
  const duration = Number(data.format.duration)
  const width = Number(v.width); const height = Number(v.height)
  const rotation = videoRotation(v)
  const [num, den] = String(v.avg_frame_rate).split('/').map(Number)
  const fps = num / den
  if (!Number.isFinite(duration) || duration <= 0) throw invalid()
  if (duration > 60) throw new HttpError(422, 'VIDEO_DURATION_EXCEEDED', '视频不能超过 60 秒')
  if (!(source ? ['h264', 'hevc'].includes(String(v.codec_name)) : v.codec_name === 'h264' && v.pix_fmt === 'yuv420p')
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || Math.max(width, height) > (source ? 4096 : 1920) || Math.min(width, height) > (source ? 2160 : 1080)
    || !Number.isFinite(fps) || fps <= 0 || fps > (source ? 120 : 60)
    || !Number.isFinite(rotation) || rotation % 90 !== 0
    || (!source && ['smpte2084', 'arib-std-b67'].includes(String(v.color_transfer)))
    || (v.sample_aspect_ratio != null && !['1:1', 'N/A'].includes(String(v.sample_aspect_ratio)))) {
    throw new HttpError(422, 'VIDEO_FORMAT_UNSUPPORTED', '暂不支持此素材，请选择 4K 以内的手机 MP4 或 MOV 视频')
  }
  if (!source && audio.some(a => a.codec_name !== 'aac' || a.profile !== 'LC' || !Number.isInteger(Number(a.channels)) || Number(a.channels) > 2 || Number(a.channels) < 1 || !Number.isFinite(Number(a.sample_rate)) || Number(a.sample_rate) <= 0 || Number(a.sample_rate) > 48000)) {
    throw new HttpError(422, 'VIDEO_FORMAT_UNSUPPORTED', '视频声音无法处理，请更换素材')
  }
  const sideways = Math.abs(rotation % 180) === 90
  return { durationMs: Math.round(duration * 1000), width: sideways ? height : width, height: sideways ? width : height, hasAudio: audio.length === 1 }
}

export async function processVideo(input: string, directory: string, parentSignal: AbortSignal) {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(360_000)])
  const common = ['-v', 'error', '-nostdin', '-max_alloc', '268435456', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-threads', '1', '-filter_threads', '1']
  const probe = async (file: string, source = false) => {
    const data = JSON.parse(await run('ffprobe', [
      '-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-show_streams', '-show_format', '-of', 'json', file,
    ], signal))
    return { data, metadata: validateVideoProbe(data, source) }
  }
  const original = await probe(input, true)
  const stream = original.data.streams.find((s: Record<string, unknown>) => s.codec_type === 'video')
  const hdr = ['smpte2084', 'arib-std-b67'].includes(String(stream.color_transfer))
  // Let FFmpeg apply the display matrix before scaling. Tone mapping operates on
  // linear floating-point pixels; changing tags alone would leave HDR washed out.
  const filters = [
    ...(hdr ? ['zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv'] : []),
    "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    'setsar=1', 'fps=30', 'format=yuv420p',
  ]
  // Portrait output uses the same short/long edge budget as landscape output.
  if (original.metadata.height > original.metadata.width) filters[hdr ? 5 : 0] = "scale=w='min(1080,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
  const video = path.join(directory, 'video.mp4'); const poster = path.join(directory, 'poster.jpg')
  const encoded = await run('ffmpeg', [...common, '-xerror', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '4000k', '-bufsize', '8000k', '-threads', '1',
    '-c:a', 'aac', '-profile:a', 'aac_low', '-ac', '2', '-ar', '48000', '-b:a', '128k',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-progress', 'pipe:1', video], signal)
  const times = [...encoded.matchAll(/^out_time_us=(\d+)$/gm)].map(m => Number(m[1]) / 1000)
  if (!times.length || Math.max(...times) <= 0 || Math.max(...times) > 60_100) throw invalid()
  const processed = await probe(video)
  const metadata = processed.metadata
  if (metadata.hasAudio !== original.metadata.hasAudio || Math.abs(metadata.durationMs - original.metadata.durationMs) > 250) throw invalid()
  await run('ffmpeg', [...common, '-i', video, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease',
    '-threads', '1', '-q:v', '4', poster], signal)
  if ((await stat(video)).size > VIDEO_MAX_BYTES) throw new HttpError(413, 'VIDEO_TOO_LARGE', '视频处理后过大，请选择更短的素材')
  if ((await stat(poster)).size > VIDEO_POSTER_MAX_BYTES) throw invalid()
  return { video, poster, metadata }
}
