import Link from 'next/link';
import { PLANS, publicPlan } from '@/lib/plans';

export default function Home() {
  return (
    <main>
      <section className="hero">
        <h1>Managed S3-compatible object storage on your own domain</h1>
        <p>
          A private, per-tenant object storage instance — your own cdn and
          bucket subdomains, your own access keys, billed for what you use.
        </p>
        <div className="cta-row">
          <Link className="btn" href="/signup">
            Get started
          </Link>
          <Link className="btn secondary" href="/login">
            Log in
          </Link>
        </div>
      </section>

      <div className="container">
        <h2 style={{ textAlign: 'center' }}>Plans</h2>
        <div className="plans">
          {PLANS.map((p) => {
            const pub = publicPlan(p);
            return (
              <div className="plan" key={p.id}>
                <strong>{pub.name}</strong>
                <div className="price">
                  ${(pub.priceMonthlyCents / 100).toFixed(pub.priceMonthlyCents % 100 ? 2 : 0)}
                  <span className="muted" style={{ fontSize: '0.8rem' }}>
                    /mo
                  </span>
                </div>
                <div className="desc">{pub.description}</div>
              </div>
            );
          })}
        </div>

        <div className="card">
          <h2>How it works</h2>
          <ol className="steps">
            <li>Sign up and enter your domain (e.g. <span className="mono" style={{ display: 'inline', padding: '0.1rem 0.4rem' }}>example.com</span>).</li>
            <li>Point two CNAME records at our edge: <span className="mono" style={{ display: 'inline', padding: '0.1rem 0.4rem' }}>cdn.example.com</span> and <span className="mono" style={{ display: 'inline', padding: '0.1rem 0.4rem' }}>panel.example.com</span>.</li>
            <li>Use your S3-compatible endpoints with any SDK — boto3, AWS CLI, Cloudflare R2, rclone, S3rver-style tooling.</li>
            <li>Upload files to any <span className="mono" style={{ display: 'inline', padding: '0.1rem 0.4rem' }}>{"<bucket>.example.com"}</span> subdomain and serve them straight from your CDN.</li>
          </ol>
        </div>
      </div>
    </main>
  );
}
