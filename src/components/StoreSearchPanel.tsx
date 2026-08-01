import { useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'
import { useAppStore } from '../stores/appStore'

/**
 * 灵动岛搜索展开态（V3，仅移动视口 + 商城页）。点岛内搜索图标后
 * navbar morph 为搜索卡片：input 自动聚焦（16px 防 iOS 缩放），
 * 第二行分类 chips 横滑。选择分类 / Enter / 取消 / 点遮罩均收起。
 * 状态与 StorePage 网格共享（appStore.storeQuery/storeCategory），
 * 输入经 StorePage 既有 300ms debounce 驱动列表。
 */
export default function StoreSearchPanel({ onClose }: { onClose: () => void }) {
  const query = useAppStore((s) => s.storeQuery)
  const setQuery = useAppStore((s) => s.setStoreQuery)
  const category = useAppStore((s) => s.storeCategory)
  const setCategory = useAppStore((s) => s.setStoreCategory)
  const registry = useAppStore((s) => s.registry)
  const inputRef = useRef<HTMLInputElement>(null)

  // 展开即聚焦（在 tap 事件链内，iOS 允许程序聚焦）
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const categories = ['全部', ...(registry?.productTypes.map((t) => t.value) ?? [])]
  const label = (value: string) =>
    value === '全部' ? value : registry?.productTypes.find((t) => t.value === value)?.label ?? value

  return (
    <div className="w-full island-panel-in">
      <div className="flex items-center gap-2.5">
        <Search className="w-5 h-5 shrink-0 text-[var(--color-primary)]" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onClose()
          }}
          placeholder="搜账号、卡密、教程..."
          aria-label="搜索商品"
          className="flex-1 min-w-0 bg-transparent outline-none border-none p-0 text-base text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="取消搜索"
          className="icon-btn inline-flex items-center justify-center w-10 h-10 -mr-1.5 rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="island-rows-in flex gap-2 overflow-x-auto hide-scrollbar mt-2.5 pb-0.5 -mx-1 px-1">
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => {
              setCategory(cat)
              onClose()
            }}
            className={`px-4 py-2 btn-sm rounded-full text-sm font-medium cursor-pointer transition-colors whitespace-nowrap border shrink-0 ${
              category === cat
                ? 'bg-[var(--color-text)] text-[var(--color-background)] border-transparent shadow-sm'
                : 'bg-[var(--color-background)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:bg-[var(--color-primary)]/8 hover:text-[var(--color-text)] hover:border-[var(--color-primary)]'
            }`}
          >
            {label(cat)}
          </button>
        ))}
      </div>
    </div>
  )
}
