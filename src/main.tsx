// Sanctioned react-dom use: the one-time renderer bootstrap (see Global Constraints).
import { createRoot } from 'react-dom/client';
import { AppShell } from './app/AppShell';
import { registerBuiltinTemplates } from './cards';
import { prepareTextures } from './cards/base/textures';
import './app/theme.css';

registerBuiltinTemplates();

// Rasterize card textures to PNGs first so screen and export share identical bitmaps.
void prepareTextures().finally(() => {
  createRoot(document.getElementById('root') as HTMLElement).render(<AppShell />);
});
