import Link from "next/link";
import { Ticket } from "lucide-react";

export default function NotFound() {
  return (
    <html lang="ko">
      <body>
        <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
          <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-primary to-brand-lighter flex items-center justify-center mb-6">
            <Ticket className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-6xl font-bold text-primary mb-2">404</h1>
          <h2 className="text-xl font-bold text-foreground mb-2">
            Page Not Found
          </h2>
          <p className="text-sm text-muted-foreground mb-8">
            The page you requested does not exist or has been moved.
          </p>
          <Link
            href="/"
            className="rounded-full bg-primary hover:bg-primary/90 text-white px-6 py-2.5 text-sm font-semibold transition-colors"
          >
            Go Home
          </Link>
        </div>
      </body>
    </html>
  );
}
