import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { bootstrapCloud } from './cloud';
import './styles.css';
import './voice.css';
import './ai.css';
import './glass.css';
import './cloud.css';
import './demo.css';
import './refined.css';
import './guide.css';
import './interaction.css';
import './settings.css';
import './layout-fix.css';

async function start(){
  await bootstrapCloud();
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
}

void start();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', async () => {
    const registration = await navigator.serviceWorker.register('/sw.js');
    registration.update();
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (sessionStorage.getItem('flowmate-sw-reloaded')) return;
      sessionStorage.setItem('flowmate-sw-reloaded', '1');
      window.location.reload();
    });
  });
}
