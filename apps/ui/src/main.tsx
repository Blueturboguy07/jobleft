// Entry point. Fonts are bundled with the app (no request to a font service).
import '@fontsource-variable/inter';
import '@fontsource/titillium-web/600.css';
import '@fontsource/titillium-web/700.css';
import 'antd/dist/reset.css';
import './app/styles.css';

import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import { App } from './app/App.tsx';
import { initToken } from './app/api.ts';
import { ui } from './app/layers.ts';
import { THEME } from './app/theme.ts';

function Bridge() {
  const { message, modal } = AntApp.useApp();
  useEffect(() => { ui.message = message; ui.modal = modal; }, [message, modal]);
  return null;
}

initToken();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider theme={THEME}>
      <AntApp message={{ maxCount: 3 }}>
        <Bridge />
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
