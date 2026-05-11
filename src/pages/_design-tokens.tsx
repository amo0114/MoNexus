import { useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs'
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '../components/ui/Dialog'
import { Coins, Sparkles, ShoppingBag } from 'lucide-react'

/**
 * Phase 2 token + component preview page.
 * Mounted at /_dev/tokens. Removed at the end of Phase 2 before merging.
 */
export default function DesignTokensPage() {
  return (
    <div className="min-h-[100dvh] bg-[var(--color-background)] text-[var(--color-text)] px-6 py-10">
      <div className="max-w-5xl mx-auto space-y-12">
        <header>
          <p className="text-xs uppercase tracking-widest text-[var(--color-text-muted)] mb-2">Internal · Phase 2</p>
          <h1 className="font-heading text-4xl font-bold">Design Tokens</h1>
          <p className="text-[var(--color-text-muted)] mt-2">
            New component system preview. Switch dark mode in any other tab — this page reacts.
          </p>
        </header>

        <Section title="Colors">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Swatch name="primary" value="var(--color-primary)" />
            <Swatch name="primary-hover" value="var(--color-primary-hover)" />
            <Swatch name="secondary" value="var(--color-secondary)" />
            <Swatch name="cta" value="var(--color-cta)" />
            <Swatch name="cta-hover" value="var(--color-cta-hover)" />
            <Swatch name="background" value="var(--color-background)" border />
            <Swatch name="surface" value="var(--color-surface)" border />
            <Swatch name="text" value="var(--color-text)" />
            <Swatch name="text-muted" value="var(--color-text-muted)" />
            <Swatch name="border" value="var(--color-border)" border />
          </div>
        </Section>

        <Section title="Typography">
          <div className="space-y-3">
            <h1 className="font-heading text-5xl font-bold">Heading 1 — Orbitron 700</h1>
            <h2 className="font-heading text-4xl font-semibold">Heading 2 — Orbitron 600</h2>
            <h3 className="font-heading text-2xl font-medium">Heading 3 — Orbitron 500</h3>
            <h4 className="font-heading text-xl">Heading 4 — Orbitron 400</h4>
            <p className="text-base">
              Body — Exo 2. 这是一段正文，混合中英文：digital marketplace,
              earn points, redeem rewards. 字间距与行高应当舒适。
            </p>
            <p className="text-sm text-[var(--color-text-muted)]">
              Muted text — slate-500 / slate-400.
            </p>
          </div>
        </Section>

        <Section title="Spacing">
          <div className="space-y-2">
            {(['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'] as const).map((token) => (
              <div key={token} className="flex items-center gap-4">
                <div className="text-xs font-mono w-12 text-[var(--color-text-muted)]">--space-{token}</div>
                <div
                  className="h-3 bg-[var(--color-primary)] rounded-sm"
                  style={{ width: `var(--space-${token})` }}
                />
              </div>
            ))}
          </div>
        </Section>

        <Section title="Shadows">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {(['sm', 'md', 'lg', 'xl'] as const).map((s) => (
              <div
                key={s}
                className="card flex items-center justify-center h-24"
                style={{ boxShadow: `var(--shadow-${s})` }}
              >
                <code className="text-xs">shadow-{s}</code>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap gap-3">
            <button className="btn-primary">
              <Sparkles className="w-4 h-4" />
              Primary
            </button>
            <button className="btn-cta">
              <ShoppingBag className="w-4 h-4" />
              CTA
            </button>
            <button className="btn-secondary">Secondary</button>
            <button className="btn-primary" disabled>
              Disabled
            </button>
          </div>
        </Section>

        <Section title="Card">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="card">
              <h4 className="font-heading text-lg font-semibold mb-2">Static card</h4>
              <p className="text-sm text-[var(--color-text-muted)]">
                Use <code className="text-xs">.card</code> for static surfaces (forms, info panels).
              </p>
            </div>
            <div className="card card-interactive">
              <h4 className="font-heading text-lg font-semibold mb-2">Interactive card</h4>
              <p className="text-sm text-[var(--color-text-muted)]">
                Add <code className="text-xs">.card-interactive</code> for hover lift on
                clickable surfaces (product cards, list items).
              </p>
            </div>
          </div>
        </Section>

        <Section title="Input">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-lg">
            <input className="input" placeholder="占位文字" />
            <input className="input" defaultValue="已填写内容" />
            <input className="input" placeholder="禁用" disabled />
          </div>
        </Section>

        <Section title="Tabs">
          <Tabs defaultValue="overview" className="w-full">
            <TabsList>
              <TabsTrigger value="overview">概览</TabsTrigger>
              <TabsTrigger value="activity">动态</TabsTrigger>
              <TabsTrigger value="rewards">奖励</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <div className="card">
                <p className="text-sm">
                  概览 tab 内容。键盘可用 ← / → 切换（Radix 自动处理 a11y）。
                </p>
              </div>
            </TabsContent>
            <TabsContent value="activity">
              <div className="card">
                <p className="text-sm">动态 tab 内容。</p>
              </div>
            </TabsContent>
            <TabsContent value="rewards">
              <div className="card">
                <p className="text-sm">奖励 tab 内容。</p>
              </div>
            </TabsContent>
          </Tabs>
        </Section>

        <Section title="Dialog">
          <DialogDemo />
        </Section>

        <footer className="pt-12 pb-4 border-t border-[var(--color-border)] text-xs text-[var(--color-text-muted)]">
          Phase 2 design-tokens demo · removed before Phase 3 merge.
        </footer>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-heading text-2xl font-semibold mb-4">{title}</h2>
      {children}
    </section>
  )
}

function Swatch({ name, value, border }: { name: string; value: string; border?: boolean }) {
  return (
    <div className={`card ${border ? '' : ''} !p-0 overflow-hidden`}>
      <div
        className="h-16"
        style={{
          background: value,
          borderBottom: border ? '1px solid var(--color-border)' : undefined,
        }}
      />
      <div className="px-3 py-2">
        <div className="text-xs font-mono">{name}</div>
        <div className="text-[10px] text-[var(--color-text-muted)] font-mono">{value}</div>
      </div>
    </div>
  )
}

function DialogDemo() {
  const [count, setCount] = useState(0)
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button className="btn-primary">
          <Coins className="w-4 h-4" />
          打开 Dialog
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>积分兑换确认</DialogTitle>
        <DialogDescription>
          这是一个 Radix 包装的可访问 Dialog。ESC 关闭，焦点会自动 trap 在内部，关闭后焦点回到触发器。
        </DialogDescription>
        <div className="mt-4 card !bg-[var(--c-bg-image)] !border-0">
          <p className="text-sm">点击计数：{count}</p>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button className="btn-secondary" onClick={() => setCount((c) => c + 1)}>
            点一下
          </button>
          <DialogClose asChild>
            <button className="btn-cta">确认</button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  )
}
