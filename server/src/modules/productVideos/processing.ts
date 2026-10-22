import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from '../../lib/httpError.js'
import { VIDEO_MAX_BYTES, VIDEO_POSTER_MAX_BYTES } from '../../lib/storage/videoKeys.js'

export type VideoMetadata = { durationMs: number; width: number; height: number; hasAudio: boolean }
const invalid = () => new HttpError(422, 'VIDEO_INVALID', '视频无法校验，请导出为普通 H.264 MP4 后重试')

/** All media processes are local, unprivileged and bounded; never interpret an uploaded name as a command. */
async function run(command: string, args: string[], signal: AbortSignal, timeout = 60_000): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn('prlimit', ['--as=805306368', '--cpu=60', '--fsize=67108864', '--', command, ...args], {
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
    await run('ffmpeg', ['-version'], signal, 5_000)
    return true
  } catch { return false }
}

export function validateVideoProbe(probe: unknown): VideoMetadata {
  const data = probe as { format?: { format_name?: string; duration?: string }; streams?: Array<Record<string, unknown>> }
  if (!data || !Array.isArray(data.streams) || !data.format?.format_name?.split(',').includes('mp4')) throw invalid()
  const video = data.streams.filter(s => s.codec_type === 'video')
  const audio = data.streams.filter(s => s.codec_type === 'audio')
  if (video.length !== 1 || audio.length > 1 || data.streams.length !== video.length + audio.length) throw invalid()
  const v = video[0]
  const duration = Number(data.format.duration)
  const width = Number(v.width); const height = Number(v.height)
  const sideData = Array.isArray(v.side_data_list) ? v.side_data_list as Array<Record<string, unknown>> : []
  const rotation = Number(sideData.find(s => s.side_data_type === 'Display Matrix')?.rotation
    ?? (v.tags as Record<string, unknown> | undefined)?.rotate ?? 0)
  const [num, den] = String(v.avg_frame_rate).split('/').map(Number)
  const fps = num / den
  if (!Number.isFinite(duration) || duration <= 0) throw invalid()
  if (duration > 60) throw new HttpError(422, 'VIDEO_DURATION_EXCEEDED', '视频不能超过 60 秒')
  if (v.codec_name !== 'h264' || v.pix_fmt !== 'yuv420p'
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || Math.max(width, height) > 1920 || Math.min(width, height) > 1080
    || !Number.isFinite(fps) || fps <= 0 || fps > 60
    || !Number.isFinite(rotation) || rotation % 90 !== 0
    || ['smpte2084', 'arib-std-b67'].includes(String(v.color_transfer))
    || (v.sample_aspect_ratio != null && v.sample_aspect_ratio !== '1:1')) {
    throw new HttpError(422, 'VIDEO_FORMAT_UNSUPPORTED', '请使用 1080p 以内、60fps 以内的 H.264 SDR MP4')
  }
  if (audio.some(a => a.codec_name !== 'aac' || a.profile !== 'LC' || !Number.isInteger(Number(a.channels)) || Number(a.channels) > 2 || Number(a.channels) < 1 || !Number.isFinite(Number(a.sample_rate)) || Number(a.sample_rate) <= 0 || Number(a.sample_rate) > 48000)) {
    throw new HttpError(422, 'VIDEO_FORMAT_UNSUPPORTED', '音频需为 AAC-LC 立体声或单声道，也可以不含音轨')
  }
  const sideways = Math.abs(rotation % 180) === 90
  return { durationMs: Math.round(duration * 1000), width: sideways ? height : width, height: sideways ? width : height, hasAudio: audio.length === 1 }
}

export async function processVideo(input: string, directory: string, parentSignal: AbortSignal) {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(60_000)])
  const common = ['-v', 'error', '-nostdin', '-max_alloc', '67108864', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-threads', '1']
  const probe = async (file: string) => validateVideoProbe(JSON.parse(await run('ffprobe', [
    '-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-show_streams', '-show_format', '-of', 'json', file,
  ], signal)))
  await probe(input)
  // Full decode rejects malformed tails; progress also checks the actual decoded timeline.
  const decoded = await run('ffmpeg', [...common, '-xerror', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
    '-progress', 'pipe:1', '-f', 'null', '-'], signal)
  const times = [...decoded.matchAll(/^out_time_us=(\d+)$/gm)].map(m => Number(m[1]) / 1000)
  if (!times.length || Math.max(...times) <= 0 || Math.max(...times) > 60_100) throw invalid()
  const video = path.join(directory, 'video.mp4'); const poster = path.join(directory, 'poster.jpg')
  await run('ffmpeg', [...common, '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', video], signal)
  const metadata = await probe(video)
  await run('ffmpeg', [...common, '-i', video, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease',
    '-threads', '1', '-q:v', '4', poster], signal)
  if ((await stat(video)).size > VIDEO_MAX_BYTES) throw new HttpError(413, 'VIDEO_TOO_LARGE', '视频不能超过 40 MiB')
  if ((await stat(poster)).size > VIDEO_POSTER_MAX_BYTES) throw invalid()
  return { video, poster, metadata }
}
