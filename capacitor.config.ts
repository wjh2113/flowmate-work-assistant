import type { CapacitorConfig } from '@capacitor/cli';

const serverUrl = (process.env.CAPACITOR_SERVER_URL || '').trim();

const config: CapacitorConfig = {
  appId: 'com.flowmate.workassistant',
  appName: 'FlowMate 工作助手',
  webDir: 'dist',
  server: serverUrl
    ? {
        url: serverUrl,
        cleartext: serverUrl.startsWith('http://')
      }
    : {
        androidScheme: 'https',
        hostname: 'localhost'
      },
  android: {
    allowMixedContent: true
  }
};

export default config;
