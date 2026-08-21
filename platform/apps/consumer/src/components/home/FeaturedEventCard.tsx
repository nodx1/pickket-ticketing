import Image from "next/image";
import Link from "next/link";
import { CalendarDays, MapPin, Sparkles } from "lucide-react";
import type { HomePageEvent } from "@/components/home/types";
import { fmtPrice } from "@/components/home/types";
import { getTranslations } from "next-intl/server";

export default async function FeaturedEventCard({ event }: { event: HomePageEvent }) {
  const t = await getTranslations("event.featuredCard");
  return (
    <Link
      href={`/events/${event.id}`}
      className="group grid md:grid-cols-2 grid-cols-1 min-h-[360px] max-md:min-h-0 overflow-hidden rounded-2xl border border-border dark:border-white/10 bg-background shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-md"
    >
      {/* Media */}
      <div className="relative min-h-[320px] max-md:min-h-[220px] overflow-hidden">
        <Image
          src={event.thumbnail_url || "/placeholder.svg"}
          alt={event.title}
          fill
          priority
          sizes="(max-width: 768px) 100vw, 50vw"
          className="object-cover transition-transform duration-500 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
      </div>

      {/* Body */}
      <div className="flex flex-col justify-center gap-4 p-8 max-md:p-6">
        <div className="inline-flex items-center gap-2 w-fit py-1.5 px-3 rounded-full border border-primary/20 bg-primary/5 text-primary text-xs font-bold tracking-wide uppercase">
          <Sparkles className="h-3.5 w-3.5" />
          Editor&apos;s Pick
        </div>

        <h2 className="text-2xl lg:text-3xl font-black leading-tight tracking-tight text-foreground">
          {event.title}
        </h2>

        <p className="text-muted-foreground text-sm leading-relaxed">
          {t("description")}
        </p>

        <div className="grid gap-2">
          <div className="inline-flex items-center gap-2 text-muted-foreground text-sm">
            <CalendarDays className="h-4 w-4 text-primary" />
            <span>{event.event_date_label}</span>
          </div>
          <div className="inline-flex items-center gap-2 text-muted-foreground text-sm">
            <MapPin className="h-4 w-4 text-red-500" />
            <span>{event.venue_name}</span>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-2xl font-black tracking-tight tabular-nums text-foreground">
            {fmtPrice(event.min_price)}
          </span>
          <span className="inline-flex items-center gap-1.5 py-1.5 px-3 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 text-xs font-bold">
            {t("fairDistribution")}
          </span>
        </div>
      </div>
    </Link>
  );
}
