import { useState, useId, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

interface ProductFaqAccordionProps {
  question: string
  answer: string
  prefix?: ReactNode
  defaultOpen?: boolean
  className?: string
  innerClassName?: string
  testId?: string
}

export default function ProductFaqAccordion({
  question,
  answer,
  prefix,
  defaultOpen = false,
  className = '',
  innerClassName = '',
  testId,
}: ProductFaqAccordionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const panelId = useId()

  return (
    <div
      className={`t-acc ${className}`}
      data-open={isOpen ? 'true' : 'false'}
      data-testid={testId}
    >
      <button
        type="button"
        className="t-acc-head"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <div className="t-acc-title-wrap">
          {prefix}
          <span className="t-acc-question-text">{question}</span>
        </div>
        <span className="t-acc-chevron" aria-hidden="true">
          <ChevronDown size={18} />
        </span>
      </button>
      <div id={panelId} className="t-acc-panel" role="region">
        <div className={`t-acc-panel-inner ${innerClassName}`}>
          <p>{answer}</p>
        </div>
      </div>
    </div>
  )
}
