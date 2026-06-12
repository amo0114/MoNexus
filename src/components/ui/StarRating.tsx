import { Star } from 'lucide-react'

interface Props {
  value: number // 展示值（可小数）或当前选中星数
  onChange?: (value: number) => void // 提供则进入可交互模式（整数 1-5）
  size?: 'sm' | 'md'
}

export default function StarRating({ value, onChange, size = 'sm' }: Props) {
  const cls = size === 'sm' ? 'w-3.5 h-3.5' : 'w-6 h-6'
  return (
    <div className="flex items-center gap-0.5" role={onChange ? 'radiogroup' : undefined} aria-label={`评分 ${value} / 5`}>
      {[1, 2, 3, 4, 5].map(star => {
        const icon = (
          <Star className={`${cls} ${star <= Math.round(value) ? 'star-filled' : 'star-empty'}`} />
        )
        return onChange ? (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={star === value}
            aria-label={`${star} 星`}
            onClick={() => onChange(star)}
            className="cursor-pointer p-0.5"
            data-testid={`star-input-${star}`}
          >
            {icon}
          </button>
        ) : (
          <span key={star}>{icon}</span>
        )
      })}
    </div>
  )
}
