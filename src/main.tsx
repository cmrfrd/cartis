// Sanctioned react-dom use: the one-time renderer bootstrap (see Global Constraints).
import { Effect } from 'effect';
import { createRoot } from 'react-dom/client';
import { AppShell } from './app/AppShell';
import { registerBuiltinTemplates } from './cards';
import { prepareTextures } from './cards/base/textures';
import './app/theme.css';

registerBuiltinTemplates();

function render(): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');
  createRoot(root).render(<AppShell />);
}

// Rasterize card textures to PNGs first so screen and export share identical bitmaps.
// The app renders even if texture prep fails (Effect.runPromise failure → .catch(render)).
void Effect.runPromise(prepareTextures()).then(render).catch(render);
