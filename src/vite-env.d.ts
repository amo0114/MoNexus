/// <reference types="vite/client" />

import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'altcha-widget': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        challengejson?: string
        auto?: string
        hidelogo?: boolean
        hidefooter?: boolean
        language?: string
        disablerefetchonexpire?: boolean
      }
    }
  }
}
