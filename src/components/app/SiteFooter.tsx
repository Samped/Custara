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
          <span className="site-footer-marks">
            <a
              href={githubUrl}
              className="site-footer-mark"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Custara on GitHub"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.9c.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.19a11 11 0 0 1 5.8 0c2.2-1.5 3.17-1.19 3.17-1.19.64 1.59.24 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.25 5.69.42.36.79 1.07.79 2.16 0 1.56-.02 2.82-.02 3.2 0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"
                />
              </svg>
            </a>
            <a href={xUrl} className="site-footer-mark" target="_blank" rel="noopener noreferrer" aria-label="Custara on X">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z"
                />
              </svg>
            </a>
          </span>
        </nav>
      </div>
    </footer>
  );
}
