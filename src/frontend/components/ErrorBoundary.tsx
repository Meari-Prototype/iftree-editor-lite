import { Component, type ErrorInfo, type ReactNode } from 'react';

import { getUiMessages } from '../../lang/ui.js';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// 渲染期错误兜底：组件树任一渲染异常被这里接住，显示「出错 + 重载」界面而不是整树
// 卸载白屏。错误本身仍属 bug，但用户看到的是可恢复提示。挂在渲染入口最外层（main.tsx）。
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 记到控制台，便于排查；不阻断兜底 UI。
    console.error('[iftree] 渲染错误已被 ErrorBoundary 捕获：', error, info?.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (error) {
      const labels = getUiMessages().notices;
      return (
        <div className="app-error-boundary" role="alert">
          <div className="app-error-card">
            <strong className="app-error-title">{labels.renderErrorTitle}</strong>
            <p className="app-error-hint">{labels.renderErrorHint}</p>
            <pre className="app-error-detail">{String(error?.message || error)}</pre>
            <button type="button" className="app-error-reload" onClick={this.handleReload}>
              {labels.renderErrorReload}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
