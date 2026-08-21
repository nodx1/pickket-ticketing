interface ContentWidthProps {
  children: React.ReactNode;
  className?: string;
}

export default function ContentWidth({
  children,
  className = "",
}: ContentWidthProps) {
  return (
    <div
      className={`mx-auto ${className}`}
      style={{ width: "min(1200px, calc(100% - 32px))" }}
    >
      {children}
    </div>
  );
}
