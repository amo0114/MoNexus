/**
 * 品牌图标策略（SPEC-STORAGE-001 UI）：
 * - Cloudflare / MinIO / Alibaba Cloud：Simple Icons 官方矢量路径（CC0 1.0）
 * - 腾讯云 COS / 通用 S3：开源库无对应商标路径时用**字标徽章**，不自制仿冒 logo
 *
 * 路径来源：https://simpleicons.org/ （CC0 1.0）
 */

type IconProps = { className?: string }

function BrandSvg({
  title,
  path,
  hex,
  className = 'w-8 h-8',
}: {
  title: string
  path: string
  hex: string
  className?: string
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <path fill={`#${hex}`} d={path} />
    </svg>
  )
}

/** 字标徽章：诚实替代，不仿造商标外形 */
function GlyphBadge({
  label,
  bg,
  className = 'w-8 h-8',
  title,
}: {
  label: string
  bg: string
  className?: string
  title: string
}) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={`${className} inline-flex items-center justify-center rounded-lg text-[10px] font-bold tracking-tight text-white shrink-0`}
      style={{ backgroundColor: bg }}
    >
      {label}
    </span>
  )
}

// Simple Icons path snapshots (CC0) — vendored for stable builds without package dep
const SI = {
  cloudflare: {
    title: 'Cloudflare',
    hex: 'F38020',
    path: 'M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727',
  },
  minio: {
    title: 'MinIO',
    hex: 'C72E49',
    path: 'M13.2072.006c-.6216-.0478-1.2.1943-1.6211.582a2.15 2.15 0 0 0-.0938 3.0352l3.4082 3.5507a3.042 3.042 0 0 1-.664 4.6875l-.463.2383V7.2853a15.4198 15.4198 0 0 0-8.0174 10.4862v.0176l6.5487-3.3281v7.621L13.7794 24V13.6817l.8965-.4629a4.4432 4.4432 0 0 0 1.2207-7.0292l-3.371-3.5254a.7489.7489 0 0 1 .037-1.0547.7522.7522 0 0 1 1.0567.0371l.4668.4863-.006.0059 4.0704 4.2441a.0566.0566 0 0 0 .082 0 .06.06 0 0 0 0-.0703l-3.1406-5.1425-.1484.1425.1484-.1445C14.4945.3926 13.8287.0538 13.2072.006Zm-.9024 9.8652v2.9941l-4.1523 2.1484a13.9787 13.9787 0 0 1 2.7676-3.9277 14.1784 14.1784 0 0 1 1.3847-1.2148z',
  },
  alibabacloud: {
    title: 'Alibaba Cloud',
    hex: 'FF6A00',
    path: 'M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z',
  },
} as const

export function IconMinio({ className }: IconProps) {
  return <BrandSvg className={className} {...SI.minio} />
}

export function IconR2({ className }: IconProps) {
  return <BrandSvg className={className} {...SI.cloudflare} />
}

export function IconOss({ className }: IconProps) {
  return <BrandSvg className={className} {...SI.alibabacloud} />
}

/** 腾讯云 COS：Simple Icons 无 COS 独立条目 → 字标 */
export function IconCos({ className }: IconProps) {
  return <GlyphBadge className={className} title="腾讯云 COS" label="COS" bg="#0052D9" />
}

/** 自定义 S3 兼容：字标，非 AWS 商标仿制 */
export function IconS3({ className }: IconProps) {
  return <GlyphBadge className={className} title="S3 兼容存储" label="S3" bg="#232F3E" />
}

export function ProviderIcon({ type, className }: { type: string; className?: string }) {
  switch (type) {
    case 'minio':
    case 'bootstrap':
      return <IconMinio className={className} />
    case 'r2':
      return <IconR2 className={className} />
    case 'oss':
      return <IconOss className={className} />
    case 'cos':
      return <IconCos className={className} />
    default:
      return <IconS3 className={className} />
  }
}
