import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** v0.23 test course: recorded runs are POSTed here by the game and appended to <repo>/runs/runs.csv
 *  (one row per run, header written when the file is new). Dev server only (npm run dev). */
const RUNS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runs');
const RUNS_FILE = path.join(RUNS_DIR, 'runs.csv');

const csv = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function runsPlugin(): Plugin {
  return {
    name: 'bb-runs',
    configureServer(server) {
      server.middlewares.use('/__runs', (req, res) => {
        const reply = (code: number, body: object) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
        if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
        let data = '';
        req.on('data', c => { data += c; if (data.length > 100_000) req.destroy(); });
        req.on('end', () => {
          try {
            const { header, row } = JSON.parse(data) as { header: string[]; row: unknown[] };
            if (!Array.isArray(header) || !Array.isArray(row)) throw new Error('bad run data');
            fs.mkdirSync(RUNS_DIR, { recursive: true });
            const isNew = !fs.existsSync(RUNS_FILE) || fs.statSync(RUNS_FILE).size === 0;
            const lines = (isNew ? header.map(csv).join(',') + '\r\n' : '') + row.map(csv).join(',') + '\r\n';
            fs.appendFileSync(RUNS_FILE, lines, 'utf8');
            const count = fs.readFileSync(RUNS_FILE, 'utf8').split(/\r?\n/).filter(l => l.trim()).length - 1;
            reply(200, { ok: true, file: 'runs\\runs.csv', row: count });
          } catch (e: any) {
            const busy = e?.code === 'EBUSY' || e?.code === 'EPERM';
            reply(500, { ok: false, error: busy ? 'runs.csv is open in another program (Excel?) — close it and run again' : String(e?.message ?? e) });
          }
        });
      });
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the site at /<repo-name>/. The deploy workflow sets BASE_PATH; local dev stays at '/'.
  base: process.env.BASE_PATH ?? '/',
  plugins: [runsPlugin()],
  server: {
    // allow importing ../src/core and ../data from the repo root
    fs: { allow: ['..'] },
  },
  build: { chunkSizeWarningLimit: 8000 },
  optimizeDeps: {
    // Havok ships a WASM module; keep it out of the dep pre-bundler
    exclude: ['@babylonjs/havok'],
  },
});
