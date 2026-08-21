import Link from "next/link";

interface SubdomainHeaderProps {
  title: string;
  logoUrl?: string | null;
  whiteLabel?: boolean;
}

export function SubdomainHeader({
  title,
  logoUrl,
  whiteLabel = false,
}: SubdomainHeaderProps) {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-xl bg-background/90 border-b border-white/5">
      <div className="max-w-[1100px] mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt=""
              className="h-8 w-8 rounded-lg object-cover shrink-0"
            />
          )}
          <span className="text-sm font-semibold text-foreground truncate">
            {title}
          </span>
        </div>
        {/* Hide Pickket branding in white-label mode */}
        {!whiteLabel && (
          <Link
            href="https://pickket.kr"
            className="text-xs-plus text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            pickket.kr
          </Link>
        )}
      </div>
    </header>
  );
}
