import { rmSync, cpSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Cross-platform client asset copy for `npm run build`.
 *
 * The original build used `rm -rf` / `cp -r`, which need a POSIX shell; on
 * Windows with no `sh` on PATH the whole build failed. Node's fs APIs do the
 * same job everywhere.
 */
const root = process.cwd();
const src = join(root, 'src', 'client');
const dest = join(root, 'dist', 'client');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

// Vendor the socket.io browser bundle the client loads.
const vendorSrc = join(root, 'node_modules', 'socket.io', 'client-dist');
const files = ['socket.io.min.js', 'socket.io.min.js.map'];
for (const file of files) {
  const from = join(vendorSrc, file);
  if (existsSync(from)) copyFileSync(from, join(dest, `vendor-${file}`));
}

console.log(`[build] client assets copied to ${dest}`);
