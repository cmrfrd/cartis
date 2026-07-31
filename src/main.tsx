// Sanctioned react-dom use: the one-time renderer bootstrap (see Global Constraints).
import { createRoot } from 'react-dom/client';
import { AppShell } from './app/AppShell';
import './app/theme.css';

createRoot(document.getElementById('root') as HTMLElement).render(<AppShell />);
