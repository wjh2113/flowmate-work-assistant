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
import './dialog.css';
import './theme.css';
import './polish.css';

async function start(){
  await bootstrapCloud();
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
}

void start();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', async () => {
    const registration = await navigator.serviceWorker.register('/sw.js');
    void registration.update();
    window.setInterval(()=>void registration.update(),60_000);
    let refreshing=false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if(refreshing)return;refreshing=true;
      window.location.reload();
    });
    const checkAppVersion=async()=>{try{const response=await fetch(`/version.json?t=${Date.now()}`,{cache:'no-store'});const data=await response.json();if(data.version&&data.version!==__APP_BUILD_VERSION__)window.location.reload()}catch{}};
    window.setInterval(()=>void checkAppVersion(),60_000);
  });
}
