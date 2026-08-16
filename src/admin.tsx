import React from 'react';
import { createRoot } from 'react-dom/client';
import AdminPage from './AdminPage';
import './styles.css';
import './theme.css';
import './glass.css';
import './admin.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AdminPage />
  </React.StrictMode>
);
