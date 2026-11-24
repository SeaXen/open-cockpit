import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The SDK checker is a TypeScript script under node_modules, where Node will
// not strip types. Copy it and its two dependencies to a temp folder first.
const root = process.cwd();
const sdk = path.join(root, 'node_modules', '@openchamber', 'sdk');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-check-'));
try {
  fs.mkdirSync(path.join(tmp, 'sdk', 'scripts'), { recursive: true });
  fs.cpSync(path.join(sdk, 'dist'), path.join(tmp, 'sdk', 'dist'), { recursive: true });
  fs.copyFileSync(path.join(sdk, 'scripts', 'check-guest.ts'), path.join(tmp, 'sdk', 'scripts', 'check-guest.ts'));
  fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
  fs.cpSync(path.join(root, 'node_modules', 'zod'), path.join(tmp, 'node_modules', 'zod'), { recursive: true });
  execFileSync(process.execPath, [path.join(tmp, 'sdk', 'scripts', 'check-guest.ts'), root], { stdio: 'inherit' });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
