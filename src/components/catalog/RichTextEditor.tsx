import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import {
  Bold,
  Eraser,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Type,
  Undo2,
} from 'lucide-react'
import {
  isAllowedPastedImageSrc,
  isAllowedRichTextHref,
  isAllowedRichTextImageSrc,
} from './RichTextHtml'

const IMAGE_ALT_MAX = 200

export type RichTextInsertedImage = {
  src: string
  objectKey: string
}

export interface RichTextEditorProps {
  value: string | null
  onChange: (html: string | null) => void
  onInsertImage?: () => Promise<RichTextInsertedImage | null>
  placeholder?: string
  disabled?: boolean
  id?: string
}

function storedHtmlFromEditor(html: string, isEmpty: boolean): string | null {
  if (isEmpty) return null
  const trimmed = html.trim()
  return trimmed === '' ? null : html
}

/** Drop styles, scripts, and remote/data images from pasted HTML. Does not fetch. */
export function sanitizePastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc
    .querySelectorAll('script,style,iframe,object,embed,form,video,audio,svg,link,meta,input,button,textarea,noscript')
    .forEach((node) => node.remove())

  doc.querySelectorAll('h1').forEach((node) => {
    const next = doc.createElement('h2')
    next.innerHTML = node.innerHTML
    node.replaceWith(next)
  })
  doc.querySelectorAll('h4,h5,h6').forEach((node) => {
    const next = doc.createElement('h3')
    next.innerHTML = node.innerHTML
    node.replaceWith(next)
  })

  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name === 'style' || name === 'class' || name === 'id' || name.startsWith('on') || name === 'srcset') {
        el.removeAttribute(attr.name)
      }
    }
  })

  doc.querySelectorAll('img').forEach((image) => {
    const src = image.getAttribute('src') ?? ''
    if (!isAllowedPastedImageSrc(src)) image.remove()
  })

  doc.querySelectorAll('a').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? ''
    if (!isAllowedRichTextHref(href)) {
      anchor.replaceWith(...Array.from(anchor.childNodes))
      return
    }
    anchor.setAttribute('rel', 'noopener noreferrer')
    anchor.removeAttribute('target')
  })

  return doc.body.innerHTML
}

function normalizeHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed
  const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  return isAllowedRichTextHref(withProtocol) ? withProtocol : null
}

const CatalogImage = Image.extend({
  addInputRules() {
    return []
  },
  addPasteRules() {
    return []
  },
  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false
          const src = node.getAttribute('src') ?? ''
          if (!isAllowedRichTextImageSrc(src)) return false
          return {
            src,
            alt: (node.getAttribute('alt') ?? '').slice(0, IMAGE_ALT_MAX),
          }
        },
      },
    ]
  },
})

function toolbarClass(active: boolean): string {
  return [
    'inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-md border px-2 text-xs font-medium',
    'text-[var(--color-text)] disabled:opacity-40 disabled:cursor-not-allowed',
    active
      ? 'border-[var(--color-primary)] bg-[var(--color-primary-tint)] text-[var(--color-primary)]'
      : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-background)]',
  ].join(' ')
}

function ToolbarButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={toolbarClass(Boolean(pressed))}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}

/**
 * Visual HTML editor for catalog richDescription (spec §5.1).
 * Parent should React.lazy this module; Tiptap is imported here on mount.
 */
export default function RichTextEditor({
  value,
  onChange,
  onInsertImage,
  placeholder = '输入图文介绍',
  disabled = false,
  id,
}: RichTextEditorProps) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const lastEmittedRef = useRef<string | null>(value)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkDraft, setLinkDraft] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  const [imageBusy, setImageBusy] = useState(false)

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        code: false,
        codeBlock: false,
        strike: false,
        horizontalRule: false,
        underline: false,
        link: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        markdownLinks: false,
        defaultProtocol: 'https',
        protocols: ['https'],
        HTMLAttributes: {
          rel: 'noopener noreferrer',
          target: null,
        },
        isAllowedUri: (url) => isAllowedRichTextHref(url),
      }),
      CatalogImage.configure({
        inline: false,
        allowBase64: false,
        resize: false,
      }),
      Placeholder.configure({ placeholder }),
    ],
    [placeholder],
  )

  const editor = useEditor({
    extensions,
    content: value ?? '',
    editable: !disabled,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        id: id ?? 'catalog-rich-text-editor',
        class:
          'min-h-[12rem] px-3 py-2 text-sm leading-relaxed text-[var(--color-text)] focus:outline-none',
        'aria-label': '商品图文介绍',
      },
      transformPastedHTML: sanitizePastedHtml,
    },
    onUpdate: ({ editor: instance }) => {
      const next = storedHtmlFromEditor(instance.getHTML(), instance.isEmpty)
      lastEmittedRef.current = next
      onChangeRef.current(next)
    },
  })

  useEffect(() => {
    if (!editor) return
    editor.setEditable(!disabled)
  }, [editor, disabled])

  useEffect(() => {
    if (!editor) return
    const incoming = value && value.trim() !== '' ? value : null
    if (incoming === lastEmittedRef.current) return
    lastEmittedRef.current = incoming
    editor.commands.setContent(incoming ?? '', { emitUpdate: false })
  }, [editor, value])

  const toolbar = useEditorState({
    editor,
    selector: ({ editor: instance }) => {
      if (!instance) {
        return {
          canUndo: false,
          canRedo: false,
          isParagraph: false,
          isH2: false,
          isH3: false,
          isBold: false,
          isItalic: false,
          isBullet: false,
          isOrdered: false,
          isQuote: false,
          isLink: false,
          isImage: false,
          imageAlt: '',
          editable: false,
        }
      }
      return {
        canUndo: instance.can().undo(),
        canRedo: instance.can().redo(),
        isParagraph: instance.isActive('paragraph'),
        isH2: instance.isActive('heading', { level: 2 }),
        isH3: instance.isActive('heading', { level: 3 }),
        isBold: instance.isActive('bold'),
        isItalic: instance.isActive('italic'),
        isBullet: instance.isActive('bulletList'),
        isOrdered: instance.isActive('orderedList'),
        isQuote: instance.isActive('blockquote'),
        isLink: instance.isActive('link'),
        isImage: instance.isActive('image'),
        imageAlt: String(instance.getAttributes('image').alt ?? ''),
        editable: instance.isEditable,
      }
    },
  })

  async function insertOrReplaceImage(replace: boolean) {
    if (!editor || !onInsertImage || imageBusy) return
    setImageBusy(true)
    try {
      const result = await onInsertImage()
      // Parent uploaded via the existing pipeline; only reject executable/data URLs.
      if (!result?.src || !isAllowedRichTextImageSrc(result.src)) return
      if (replace && editor.isActive('image')) {
        editor.chain().focus().updateAttributes('image', { src: result.src }).run()
      } else {
        editor.chain().focus().setImage({ src: result.src, alt: '' }).run()
      }
    } finally {
      setImageBusy(false)
    }
  }

  function openLinkDialog() {
    if (!editor) return
    const current = String(editor.getAttributes('link').href ?? '')
    setLinkDraft(current)
    setLinkError(null)
    setLinkOpen(true)
  }

  function applyLink() {
    if (!editor) return
    const href = normalizeHref(linkDraft)
    if (!href) {
      setLinkError('仅支持 https 或站内路径')
      return
    }
    const chain = editor.chain().focus().extendMarkRange('link')
    if (editor.state.selection.empty) {
      chain.insertContent({
        type: 'text',
        text: href,
        marks: [{ type: 'link', attrs: { href } }],
      }).run()
    } else {
      chain.setLink({ href }).run()
    }
    setLinkOpen(false)
    setLinkError(null)
  }

  function removeLink() {
    editor?.chain().focus().extendMarkRange('link').unsetLink().run()
    setLinkOpen(false)
    setLinkError(null)
  }

  const controlsDisabled = disabled || !toolbar.editable

  return (
    <div
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
      data-testid="rich-text-editor"
    >
      <style>{`
        .catalog-rich-text-editor .tiptap p.is-editor-empty:first-child::before {
          color: var(--color-text-muted);
          content: attr(data-placeholder);
          float: left;
          height: 0;
          pointer-events: none;
        }
        .catalog-rich-text-editor .tiptap img {
          max-width: 100%;
          height: auto;
        }
        .catalog-rich-text-editor .tiptap blockquote {
          border-left: 3px solid var(--color-border);
          margin: 0.5rem 0;
          padding-left: 0.75rem;
          color: var(--color-text-muted);
        }
        .catalog-rich-text-editor .tiptap a {
          color: var(--color-primary);
          text-decoration: underline;
        }
        .catalog-rich-text-editor .tiptap ul { list-style: disc; padding-left: 1.25rem; }
        .catalog-rich-text-editor .tiptap ol { list-style: decimal; padding-left: 1.25rem; }
        .catalog-rich-text-editor .tiptap h2 { font-size: 1.125rem; font-weight: 700; }
        .catalog-rich-text-editor .tiptap h3 { font-size: 1rem; font-weight: 700; }
      `}</style>
      <div
        role="toolbar"
        aria-label="图文编辑工具栏"
        data-testid="rich-text-toolbar"
        className="flex flex-wrap gap-1 border-b border-[var(--color-border)] p-2"
      >
        <ToolbarButton
          label="撤销"
          disabled={controlsDisabled || !toolbar.canUndo}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          <Undo2 className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="重做"
          disabled={controlsDisabled || !toolbar.canRedo}
          onClick={() => editor?.chain().focus().redo().run()}
        >
          <Redo2 className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="段落"
          pressed={toolbar.isParagraph}
          disabled={controlsDisabled}
          onClick={() => editor?.chain().focus().setParagraph().run()}
        >
          <Type className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="二级标题"
          pressed={toolbar.isH2}
          disabled={controlsDisabled}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="三级标题"
          pressed={toolbar.isH3}
          disabled={controlsDisabled}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="加粗"
          pressed={toolbar.isBold}
          disabled={controlsDisabled}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="斜体"
          pressed={toolbar.isItalic}
          disabled={controlsDisabled}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="无序列表"
          pressed={toolbar.isBullet}
          disabled={controlsDisabled}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="有序列表"
          pressed={toolbar.isOrdered}
          disabled={controlsDisabled}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="引用"
          pressed={toolbar.isQuote}
          disabled={controlsDisabled}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          <Quote className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="链接"
          pressed={toolbar.isLink || linkOpen}
          disabled={controlsDisabled}
          onClick={openLinkDialog}
        >
          <LinkIcon className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
        {onInsertImage ? (
          <ToolbarButton
            label="插入图片"
            disabled={controlsDisabled || imageBusy}
            onClick={() => void insertOrReplaceImage(false)}
          >
            <ImageIcon className="h-4 w-4" aria-hidden="true" />
          </ToolbarButton>
        ) : null}
        <ToolbarButton
          label="清除格式"
          disabled={controlsDisabled}
          onClick={() => editor?.chain().focus().clearNodes().unsetAllMarks().run()}
        >
          <Eraser className="h-4 w-4" aria-hidden="true" />
        </ToolbarButton>
      </div>

      {linkOpen ? (
        <div className="flex flex-wrap items-end gap-2 border-b border-[var(--color-border)] px-3 py-2">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            链接地址
            <input
              value={linkDraft}
              onChange={(event) => {
                setLinkDraft(event.target.value)
                setLinkError(null)
              }}
              disabled={controlsDisabled}
              placeholder="https:// 或 /path"
              className="input py-2 text-sm"
              aria-invalid={linkError ? true : undefined}
            />
          </label>
          <button type="button" className="btn-secondary min-h-[44px] px-3 text-xs" onClick={applyLink} disabled={controlsDisabled}>
            应用链接
          </button>
          <button type="button" className="btn-secondary min-h-[44px] px-3 text-xs" onClick={removeLink} disabled={controlsDisabled}>
            取消链接
          </button>
          {linkError ? <p className="w-full text-xs text-[var(--color-danger)]">{linkError}</p> : null}
        </div>
      ) : null}

      {toolbar.isImage ? (
        <div
          className="flex flex-wrap items-end gap-2 border-b border-[var(--color-border)] px-3 py-2"
          data-testid="rich-text-image-controls"
        >
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            图片说明
            <input
              value={toolbar.imageAlt}
              maxLength={IMAGE_ALT_MAX}
              disabled={controlsDisabled}
              onChange={(event) => {
                editor?.commands.updateAttributes('image', {
                  alt: event.target.value.slice(0, IMAGE_ALT_MAX),
                })
              }}
              className="input py-2 text-sm"
              aria-label="图片说明"
            />
          </label>
          {onInsertImage ? (
            <button
              type="button"
              className="btn-secondary min-h-[44px] px-3 text-xs"
              aria-label="替换图片"
              disabled={controlsDisabled || imageBusy}
              onClick={() => void insertOrReplaceImage(true)}
            >
              替换图片
            </button>
          ) : null}
          <button
            type="button"
            className="btn-secondary min-h-[44px] px-3 text-xs"
            aria-label="移除图片"
            disabled={controlsDisabled}
            onClick={() => editor?.chain().focus().deleteSelection().run()}
          >
            移除图片
          </button>
        </div>
      ) : null}

      <div className="catalog-rich-text-editor">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
