"use client";

import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { motion } from "motion/react";
import EventCard from "@/components/event/EventCard";
import type { Event } from "@pickket/lib/api";

interface SimilarEventsProps {
  events: Event[];
}

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

export default function SimilarEvents({ events }: SimilarEventsProps) {
  const t = useTranslations("event.similarEvents");

  if (events.length === 0) return null;

  return (
    <section>
      <h2 className="font-serif text-xl font-bold text-foreground flex items-center gap-2 mb-4">
        <Sparkles className="h-5 w-5 text-cyan" />
        {t("title")}
      </h2>

      <motion.div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
        variants={containerVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-60px" }}
      >
        {events.map((ev) => (
          <motion.div key={ev.id} variants={cardVariants}>
            <EventCard event={ev} />
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}
