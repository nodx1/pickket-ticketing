"use client";

import Link from "next/link";

interface WhiteLabelConfig {
  footerText?: string;
  copyrightText?: string;
  links?: Array<{ label: string; url: string }>;
}

interface SubdomainFooterProps {
  whiteLabel?: boolean;
  config?: WhiteLabelConfig;
}

export function SubdomainFooter({
  whiteLabel = false,
  config,
}: SubdomainFooterProps) {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="mt-auto border-t border-white/5 bg-background">
      <div className="max-w-[1100px] mx-auto px-4 py-8">
        {/* Custom footer links */}
        {config?.links && config.links.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-4 mb-4">
            {config.links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {link.label}
              </a>
            ))}
          </div>
        )}

        {/* Custom footer text */}
        {config?.footerText && (
          <p className="text-xs text-muted-foreground text-center mb-3">
            {config.footerText}
          </p>
        )}

        {/* Copyright */}
        <p className="text-xs-plus text-muted-foreground/60 text-center">
          {config?.copyrightText
            ? config.copyrightText
            : `\u00A9 ${currentYear} All rights reserved.`}
        </p>

        {/* Powered by Pickket — hidden in white-label mode */}
        {!whiteLabel && (
          <div className="mt-4 flex items-center justify-center">
            <Link
              href="https://pickket.kr"
              className="text-xs-plus text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            >
              Powered by Pickket
            </Link>
          </div>
        )}
      </div>
    </footer>
  );
}
