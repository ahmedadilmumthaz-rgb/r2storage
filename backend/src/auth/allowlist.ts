import { BlockList } from 'net';
import { CONFIG } from '../config';

let blockList: BlockList | null = null;
let resolved = false;

/**
 * Optional admin IP allowlist. When ADMIN_ALLOWED_CIDRS is empty the feature is
 * off and every IP passes. When set (comma-separated CIDRs, IPv4 or IPv6), only
 * matching client IPs may reach /api/admin/* — including the login route, so the
 * panel is unreachable from outside the configured networks. Uses net.BlockList
 * (built in, no dependency). `req.ip` is the real client IP behind nginx
 * (CF-Connecting-IP via trustProxy), consistent with rate limits and lockout.
 */
function buildBlockList(): BlockList | null {
  const raw = (CONFIG.ADMIN_ALLOWED_CIDRS || '').trim();
  if (!raw) return null;
  const list = new BlockList();
  for (const part of raw.split(',')) {
    const cidr = part.trim();
    if (!cidr) continue;
    const [addr, prefix] = cidr.split('/');
    try {
      if (prefix !== undefined && prefix !== '') {
        list.addSubnet(addr.trim(), parseInt(prefix, 10));
      } else {
        list.addAddress(addr.trim());
      }
    } catch {
      // Skip malformed entries rather than failing the whole server; the
      // remaining rules still apply.
    }
  }
  return list;
}

export function isAdminIpAllowed(ip: string | undefined): boolean {
  if (!ip) return false; // unattributeable request -> deny under an allowlist
  if (!resolved) {
    blockList = buildBlockList();
    resolved = true;
  }
  if (!blockList) return true; // allowlist disabled
  try {
    return blockList.check(ip);
  } catch {
    return false; // invalid address -> deny
  }
}
