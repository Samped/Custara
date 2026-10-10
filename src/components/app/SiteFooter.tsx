import Link from "next/link";

const githubUrl = "https://github.com/Samped/Custara";
const xUrl = "https://x.com/custarafinance";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell site-footer-bar">
        <div>
          <p className="site-footer-brand">Custara</p>
          <p className="site-footer-note">Accounts payable, settled on Arc.</p>
        </div>
        <nav className="site-footer-nav" aria-label="Footer">
          <Link href="/docs">Documentation</Link>
          <a href={githubUrl} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href={xUrl} className="site-footer-x" target="_blank" rel="noopener noreferrer" aria-label="Custara on X">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                fill="currentColor"
                d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z"
              />
            </svg>
          </a>
        </nav>
      </div>
    </footer>
  );
}
