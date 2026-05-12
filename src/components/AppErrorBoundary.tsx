import React, { Component, ReactNode } from 'react'
import { captureException } from '../lib/errorReporter'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

export class AppErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(_: Error): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    captureException(error, { reactErrorInfo: errorInfo })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[var(--color-background)] p-4">
          <div className="card max-w-sm w-full text-center space-y-4">
            <div className="w-12 h-12 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto mb-2">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">出错了</h2>
            <p className="text-sm text-[var(--color-text-muted)]">抱歉，遇到了一些意外问题。</p>
            <button
              onClick={() => window.location.reload()}
              className="btn-primary w-full mt-4"
            >
              刷新页面
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
