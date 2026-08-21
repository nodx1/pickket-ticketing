"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@pickket/ui";
import ChatWindow from "@/components/support/ChatWindow";
import FaqSection from "@/components/support/FaqSection";
import ContactForm from "@/components/support/ContactForm";
import {
  Headphones,
  Bot,
  HelpCircle,
  MessageSquare,
  Mail,
  Clock,
} from "lucide-react";

export default function SupportPage() {
  const t = useTranslations("support.page");
  return (
    <main className="bg-background min-h-screen bg-gradient-to-b from-white/5 to-background">
      {/* Hero */}
      <section className="pt-20 pb-10 px-4 text-center">
        <div className="max-w-2xl mx-auto space-y-4">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary/70">
            <Headphones className="h-3.5 w-3.5" />
            {t("badge")}
          </span>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground">
            {t("title")}
          </h1>
          <p className="text-muted-foreground text-sm md:text-base">
            {t("subtitle")}
          </p>

          {/* Contact info */}
          <div className="flex flex-wrap items-center justify-center gap-4 md:gap-6 pt-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              <span>{t("emailLabel")}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              <span>support@pickket.kr</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span>{t("businessHours")}</span>
            </div>
          </div>
        </div>
      </section>

      {/* Tabs */}
      <section className="max-w-3xl mx-auto px-4 pb-20">
        <Tabs defaultValue="chat" className="space-y-6">
          <TabsList className="grid w-full grid-cols-3 bg-white/5 rounded-full p-1 h-auto">
            <TabsTrigger
              value="chat"
              className="rounded-full py-2.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-white data-[state=active]:shadow-sm"
            >
              <Bot className="h-4 w-4 mr-1.5" />
              {t("tabChat")}
            </TabsTrigger>
            <TabsTrigger
              value="faq"
              className="rounded-full py-2.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-white data-[state=active]:shadow-sm"
            >
              <HelpCircle className="h-4 w-4 mr-1.5" />
              {t("tabFaq")}
            </TabsTrigger>
            <TabsTrigger
              value="contact"
              className="rounded-full py-2.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-white data-[state=active]:shadow-sm"
            >
              <MessageSquare className="h-4 w-4 mr-1.5" />
              {t("tabContact")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="chat">
            <ChatWindow />
          </TabsContent>

          <TabsContent value="faq">
            <FaqSection />
          </TabsContent>

          <TabsContent value="contact">
            <ContactForm />
          </TabsContent>
        </Tabs>
      </section>
    </main>
  );
}
