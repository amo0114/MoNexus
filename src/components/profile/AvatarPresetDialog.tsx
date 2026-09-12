import { useState } from 'react'
import { Check, Loader2, Upload } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/Tabs'
import { AVATAR_FACTIONS, AVATAR_PRESETS, getAvatarPreset, type AvatarFaction } from '../../lib/avatarPresets'
import UserAvatar from '../ui/UserAvatar'

type Props = {
  currentUrl?: string | null
  busy: boolean
  onClose: () => void
  onSave: (url: string) => Promise<void>
  onUpload: () => void
}

export default function AvatarPresetDialog({ currentUrl, busy, onClose, onSave, onUpload }: Props) {
  const initial = getAvatarPreset(currentUrl)
  const [faction, setFaction] = useState<AvatarFaction>((initial?.faction as AvatarFaction) || 'wei')
  const [selected, setSelected] = useState(initial)
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="w-[min(640px,calc(100%-32px))] max-w-[640px]" hideClose={busy}>
        <DialogTitle>选择头像</DialogTitle>
        <DialogDescription>从三国人物中选择喜欢的头像，也可以上传自己的图片。</DialogDescription>
        <Tabs value={faction} onValueChange={(value) => setFaction(value as AvatarFaction)} className="mt-5">
          <TabsList aria-label="头像阵营" className="w-full">
            {AVATAR_FACTIONS.map((f) => <TabsTrigger key={f.id} value={f.id} disabled={busy} className="flex-1">{f.label}</TabsTrigger>)}
          </TabsList>
          {AVATAR_FACTIONS.map((f) => (
            <TabsContent key={f.id} value={f.id}>
              <div className="grid grid-cols-4 gap-2 sm:gap-3">
                {AVATAR_PRESETS.filter((a) => a.faction === f.id).map((a) => (
                  <button
                    key={a.id} type="button" disabled={busy} aria-label={`选择${a.name}`} aria-pressed={selected?.id === a.id}
                    onClick={() => setSelected(a)}
                    className={`relative flex min-w-0 flex-col items-center gap-2 rounded-xl border-2 px-1 py-3 cursor-pointer transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] disabled:opacity-60 ${selected?.id === a.id ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10' : 'border-transparent hover:bg-[var(--color-background)]'}`}
                  >
                    <img src={a.thumbnailUrl} width={64} height={64} alt="" className="aspect-square w-full max-w-16 rounded-full object-cover" />
                    <span className="text-sm text-[var(--color-text)]">{a.name}</span>
                    {selected?.id === a.id && <Check aria-hidden="true" className="absolute right-1 top-1 h-4 w-4 text-[var(--color-primary)]" />}
                  </button>
                ))}
              </div>
            </TabsContent>
          ))}
        </Tabs>
        <div className="mt-4 flex items-center gap-3 rounded-xl bg-[var(--color-background)] p-3" aria-live="polite">
          <UserAvatar url={selected?.url ?? currentUrl} name={selected?.name} size={72} />
          <div><p className="text-sm font-semibold text-[var(--color-text)]">{selected ? `已选择：${selected.name}` : '选择一位人物'}</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">确认后更新你的头像</p></div>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <button type="button" disabled={busy} onClick={onUpload} className="btn-secondary inline-flex items-center gap-2 px-3 py-2 text-sm"><Upload className="h-4 w-4" />上传图片</button>
          <button type="button" disabled={busy || !selected || selected.url === currentUrl} onClick={() => { if (selected) void onSave(selected.url) }} className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {busy ? '保存中…' : '使用此头像'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
