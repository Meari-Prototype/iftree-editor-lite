import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '../frontend/App.js';
import { EntityMaintenanceWindow } from '../frontend/components/EntityMaintenanceWindow.js';
import { ErrorBoundary } from '../frontend/components/ErrorBoundary.js';
import { initTheme } from '../frontend/lib/theme.js';
import { UiLanguageProvider } from '../lang/ui.js';
import '../frontend/theme.css';
import '../frontend/styles.css';

initTheme();

function Root() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('screen') === 'entity-maintenance') return <EntityMaintenanceWindow />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <UiLanguageProvider>
      {/* 渲染期错误兜底：任一组件渲染异常被接住显示「出错 + 重载」而非整树白屏 */}
      <ErrorBoundary>
        <Root />
      </ErrorBoundary>
    </UiLanguageProvider>
  </React.StrictMode>
);
