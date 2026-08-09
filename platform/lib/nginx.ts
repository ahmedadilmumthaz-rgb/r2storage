import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { db } from './db';
import { ENV } from './env';

const execFileP = promisify(execFile);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Regenerates /etc/nginx/r2storage-map.conf from the active instances and
// reloads nginx. Called on every provision/suspend/resume/delete.
export async function writeMapFile(platformPort = 4000): Promise<void> {
  const d = escapeRegex(ENV.PLATFORM_DOMAIN);
  const lines: string[] = [];
  lines.push('map $host $r2_tenant_port {');
  lines.push('    default 0;');
  lines.push(`    "~^(${d}|www\\.${d}|panel\\.${d}|origin\\.${d})$" ${platformPort};`);
  const instances = await db.instance.findMany({
    where: { status: 'active' },
    orderBy: { port: 'asc' },
  });
  for (const inst of instances) {
    lines.push(`    "~^([a-z0-9-]+\\.)+${escapeRegex(inst.domain)}$" ${inst.port};`);
  }
  lines.push('}');
  const content = lines.join('\n') + '\n';

  if (!ENV.NGINX_MAP_FILE) {
    console.log('[nginx] NGINX_MAP_FILE unset — skipping map write');
    return;
  }
  fs.writeFileSync(ENV.NGINX_MAP_FILE, content, { mode: 0o644 });
  console.log(`[nginx] wrote ${ENV.NGINX_MAP_FILE} (${instances.length} tenants)`);
}

export async function reloadNginx(): Promise<void> {
  if (!ENV.NGINX_RELOAD || ENV.NODE_ENV !== 'production') {
    console.log('[nginx] skipping reload (dev or NGINX_RELOAD=false)');
    return;
  }
  try {
    await execFileP('nginx', ['-t']);
  } catch (e) {
    throw new Error(`nginx -t failed: ${(e as { stderr?: string }).stderr || (e as Error).message}`);
  }
  await execFileP('nginx', ['-s', 'reload']);
  console.log('[nginx] reloaded');
}
