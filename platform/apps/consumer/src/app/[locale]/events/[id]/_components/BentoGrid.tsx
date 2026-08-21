import ContentWidth from "@/components/ui/ContentWidth";

interface BentoGridProps {
  children: React.ReactNode;
  className?: string;
}

export function BentoGrid({ children, className = "" }: BentoGridProps) {
  return (
    <ContentWidth className={`py-6 flex flex-col gap-4 ${className}`}>
      {children}
    </ContentWidth>
  );
}
