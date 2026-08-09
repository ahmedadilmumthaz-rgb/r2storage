import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { ENV } from '@/lib/env';
import { requireCustomer } from '@/lib/session';
import { instanceToPublic, cfHostnameStatus } from '@/lib/provision';
import { customerUsage } from '@/lib/usage';
import { isStripeConfigured } from '@/lib/stripe';
import { InstanceControls, ProvisionForm, BillingCard } from './controls';

export const dynamic = 'force-dynamic';

function fmtBytes(n: bigint | string): string {
  const v = typeof n === 'bigint' ? Number(n) : Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v < 1024 ** 4) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  return `${(v / 1024 ** 4).toFixed(2)} TB`;
}

export default async function DashboardPage() {
  let customerId: string;
  try {
    customerId = await requireCustomer();
  } catch {
    redirect('/login');
  }

  const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
  const plan = await db.plan.findUniqueOrThrow({ where: { id: customer.planId } });
  const instances = await db.instance.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
  });
  const usage = await customerUsage(customerId);

  const active = instances.find((i) => ['pending', 'active', 'suspended'].includes(i.status));

  const enriched = await Promise.all(
    instances.map(async (inst) => ({
      inst,
      pub: instanceToPublic(inst),
      cf: await cfHostnameStatus(inst),
    }))
  );

  return (
    <main className="container">
      <h1 style={{ marginTop: 0 }}>Dashboard</h1>
      <p className="muted">
        Signed in as {customer.email} — plan: <strong>{customer.planId}</strong>.
      </p>

      <BillingCard
        planId={customer.planId}
        planName={plan.name}
        priceMonthlyCents={plan.priceMonthlyCents}
        stripeStatus={customer.stripeSubscriptionStatus}
        billingConfigured={isStripeConfigured()}
      />

      {!active && (
        <div className="card">
          <h2>Provision your instance</h2>
          <p className="muted">
            We create an isolated storage instance on your own domain. You&apos;ll get your admin
            secret and an initial access key here, plus setup instructions.
          </p>
          <ProvisionForm />
        </div>
      )}

      {enriched.map(({ inst, pub, cf }) => {
        const origin = ENV.CF_FALLBACK_ORIGIN;
        const isActive = inst.status === 'active';
        const u = usage && usage.instanceId === inst.id ? usage : null;
        return (
          <div className="card" key={inst.id}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span className="mono" style={{ display: 'inline' }}>{inst.domain}</span>
              <span className={`pill ${inst.status}`}>{inst.status}</span>
            </h2>

            {isActive && (
              <>
                <div className="grid-2">
                  <div>
                    <h3>Credentials</h3>
                    <details>
                      <summary>Reveal admin secret &amp; initial access key</summary>
                      <p className="muted" style={{ marginTop: '0.6rem' }}>Admin secret (panel login / API):</p>
                      <code className="mono">{pub.adminSecret}</code>
                      <p className="muted">Access key ID:</p>
                      <code className="mono">{pub.accessKeyId}</code>
                      <p className="muted">Secret access key:</p>
                      <code className="mono">{pub.accessKeySecret}</code>
                    </details>
                  </div>
                  <div>
                    <h3>Usage</h3>
                    <p className="muted">Storage</p>
                    <div className="bar">
                      <div style={{ width: `${u ? Math.min(100, (Number(u.storageBytes) / Number(u.storageBytesLimit)) * 100) : 0}%` }} />
                    </div>
                    <span className="muted" style={{ fontSize: '0.85rem' }}>
                      {u ? fmtBytes(u.storageBytes) : '0 B'} / {u ? fmtBytes(u.storageBytesLimit) : '—'}
                    </span>
                    <p className="muted" style={{ marginTop: '0.75rem' }}>Bandwidth (since last poll)</p>
                    <div className="bar">
                      <div style={{ width: `${u ? Math.min(100, (Number(u.bytesTransferred) / Number(u.bandwidthBytesLimit)) * 100) : 0}%` }} />
                    </div>
                    <span className="muted" style={{ fontSize: '0.85rem' }}>
                      {u ? fmtBytes(u.bytesTransferred) : '0 B'} / {u ? fmtBytes(u.bandwidthBytesLimit) : '—'}
                    </span>
                  </div>
                </div>

                <h3>Point your domain at us</h3>
                <p className="muted">Create these two CNAME records at your DNS provider:</p>
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Name</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>CNAME</td>
                      <td><code className="mono" style={{ display: 'inline' }}>cdn</code></td>
                      <td><code className="mono" style={{ display: 'inline' }}>{origin}</code></td>
                    </tr>
                    <tr>
                      <td>CNAME</td>
                      <td><code className="mono" style={{ display: 'inline' }}>panel</code></td>
                      <td><code className="mono" style={{ display: 'inline' }}>{origin}</code></td>
                    </tr>
                  </tbody>
                </table>
                <p className="muted" style={{ fontSize: '0.85rem' }}>
                  TLS certificate status:{' '}
                  <strong>{cf.sslStatus ?? '—'}</strong>
                </p>
              </>
            )}

            {inst.status === 'pending' && (
              <p className="muted">Instance is still being provisioned — refresh in a moment.</p>
            )}

            <InstanceControls instanceId={inst.id} status={inst.status} />
          </div>
        );
      })}

      <div className="card">
        <h2>Integration examples</h2>
        <p className="muted">
          Standard S3 SDKs work out of the box. See the{' '}
          <Link href="https://github.com/your-repo/r2storage" target="_blank" rel="noreferrer">
            integration docs
          </Link>{' '}
          for boto3, AWS CLI, Cloudflare R2, rclone, and more.
        </p>
      </div>
    </main>
  );
}
