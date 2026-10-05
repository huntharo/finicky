import { createRenderer } from './app.mjs';

const renderer = createRenderer(document.getElementById('app'), window.pwrfinicky);
renderer.start();
window.addEventListener('pagehide', () => renderer.destroy(), { once: true });
