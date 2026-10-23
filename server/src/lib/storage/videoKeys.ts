export const VIDEO_SOURCE_MAX_BYTES = 90 * 1024 * 1024
export const VIDEO_MAX_BYTES = 40 * 1024 * 1024
export const VIDEO_POSTER_MAX_BYTES = 512 * 1024
export const VIDEO_TTL_SECONDS = 180
export const VIDEO_PREFIX = 'product-videos/v1/'
export const DELIVERY_FINAL_KEY = /^[a-f0-9]{64}\.[a-z0-9]{1,10}$/
export const VIDEO_KEY = /^product-videos\/v1\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/(?:([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/)?(video\.mp4|poster\.jpg)$/
export type VideoMime = 'video/mp4' | 'image/jpeg'
export function videoKey(id: string, poster = false, generation?: string | null) {
  return `${VIDEO_PREFIX}${id}/${generation ? generation + '/' : ''}${poster ? 'poster.jpg' : 'video.mp4'}`
}
export function assertInlineVideoKey(key: string, mime: VideoMime) {
  if (!VIDEO_KEY.test(key) || (key.endsWith('/video.mp4') ? mime !== 'video/mp4' : mime !== 'image/jpeg')) {
    throw new Error('invalid promotional media key')
  }
}

export const VIDEO_SOURCE_KEY = /^product-video-sources\/v1\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/source$/
export function videoSourceKey(id: string) { return `product-video-sources/v1/${id}/source` }
