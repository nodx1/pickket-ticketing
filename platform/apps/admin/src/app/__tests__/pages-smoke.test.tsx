import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import type { JSX } from "react";

// --- Global Mocks ---

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@pickket/store", () => ({
  useAuthStore: Object.assign(
    () => ({
      user: {
        id: "a1",
        name: "관리자",
        email: "admin@test.com",
        is_organizer: false,
        is_admin: true,
        is_verified: true,
      },
      token: "mock-admin-token",
      setAuth: vi.fn(),
      logout: vi.fn(),
      hydrate: vi.fn(),
    }),
    {
      getState: () => ({
        user: {
          id: "a1",
          name: "관리자",
          email: "admin@test.com",
          is_organizer: false,
          is_admin: true,
          is_verified: true,
        },
        token: "mock-admin-token",
        setAuth: vi.fn(),
        logout: vi.fn(),
        hydrate: vi.fn(),
      }),
    },
  ),
}));

const mockApi = {
  get: vi.fn().mockResolvedValue({ data: [] }),
  post: vi.fn().mockResolvedValue({ data: {} }),
  put: vi.fn().mockResolvedValue({ data: {} }),
  patch: vi.fn().mockResolvedValue({ data: {} }),
  delete: vi.fn().mockResolvedValue({ data: {} }),
};

const originalConsoleError = console.error;

vi.mock("@pickket/lib", async () => {
  const actual =
    await vi.importActual<typeof import("@pickket/lib")>("@pickket/lib");
  return {
    ...actual,
    api: mockApi,
  };
});

// Mock @pickket/ui to avoid dual-React from radix-ui in monorepo
vi.mock("@pickket/ui", () => {
  const stub = ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => <div {...filterHtmlProps(props)}>{children}</div>;

  const inputStub = (props: Record<string, unknown>) => {
    const safeProps = filterHtmlProps(props);
    if (
      ("value" in safeProps || "checked" in safeProps) &&
      !("onChange" in props)
    ) {
      safeProps.readOnly = true;
    }
    return <input {...safeProps} />;
  };

  function filterHtmlProps(props: Record<string, unknown>) {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        k.startsWith("data-") ||
        k.startsWith("aria-") ||
        k === "className" ||
        k === "id" ||
        k === "role" ||
        k === "style" ||
        k === "href" ||
        k === "type" ||
        k === "disabled" ||
        k === "placeholder" ||
        k === "value" ||
        k === "checked" ||
        k === "readOnly" ||
        k === "name" ||
        k === "htmlFor"
      ) {
        safe[k] = v;
      }
    }
    return safe;
  }

  return {
    Badge: stub,
    Button: stub,
    Card: stub,
    CardContent: stub,
    CardDescription: stub,
    CardFooter: stub,
    CardHeader: stub,
    CardTitle: stub,
    Input: inputStub,
    Label: stub,
    Switch: inputStub,
    Tabs: stub,
    TabsContent: stub,
    TabsList: stub,
    TabsTrigger: stub,
    Textarea: (props: Record<string, unknown>) => {
      const safeProps = filterHtmlProps(props);
      if ("value" in safeProps && !("onChange" in props)) {
        safeProps.readOnly = true;
      }
      return <textarea {...safeProps} />;
    },
    TooltipProvider: stub,
    Tooltip: stub,
    TooltipTrigger: stub,
    TooltipContent: stub,
    Select: stub,
    SelectContent: stub,
    SelectItem: stub,
    SelectTrigger: stub,
    SelectValue: stub,
    Dialog: stub,
    DialogContent: stub,
    DialogDescription: stub,
    DialogFooter: stub,
    DialogHeader: stub,
    DialogTitle: stub,
    DialogTrigger: stub,
    AlertDialog: stub,
    AlertDialogAction: stub,
    AlertDialogCancel: stub,
    AlertDialogContent: stub,
    AlertDialogDescription: stub,
    AlertDialogFooter: stub,
    AlertDialogHeader: stub,
    AlertDialogTitle: stub,
    AlertDialogTrigger: stub,
    Separator: () => <hr />,
    Progress: stub,
    Toaster: () => <div />,
    Slider: inputStub,
    Avatar: stub,
    AvatarFallback: stub,
    AvatarImage: stub,
    DropdownMenu: stub,
    DropdownMenuContent: stub,
    DropdownMenuItem: stub,
    DropdownMenuTrigger: stub,
    Sheet: stub,
    SheetContent: stub,
    SheetHeader: stub,
    SheetDescription: stub,
    SheetTitle: stub,
    SheetTrigger: stub,
    Table: stub,
    TableBody: stub,
    TableCell: stub,
    TableHead: stub,
    TableHeader: stub,
    TableRow: stub,
  };
});

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Bar: () => <div />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  Tooltip: () => <div />,
  CartesianGrid: () => <div />,
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Line: () => <div />,
  PieChart: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Pie: () => <div />,
  Cell: () => <div />,
  Legend: () => <div />,
  AreaChart: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Area: () => <div />,
}));

vi.mock("motion/react", () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop === "string") {
          const MotionStub = ({
            children,
            ...props
          }: {
            children?: React.ReactNode;
            [key: string]: unknown;
          }) => {
            const htmlProps: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(props)) {
              if (
                !k.startsWith("initial") &&
                !k.startsWith("animate") &&
                !k.startsWith("exit") &&
                !k.startsWith("transition") &&
                !k.startsWith("variants") &&
                !k.startsWith("whileHover") &&
                !k.startsWith("whileTap") &&
                !k.startsWith("whileInView") &&
                !k.startsWith("viewport") &&
                !k.startsWith("layout")
              ) {
                htmlProps[k] = v;
              }
            }
            const El = prop as keyof JSX.IntrinsicElements;
            return <El {...(htmlProps as object)}>{children}</El>;
          };
          MotionStub.displayName = `MotionStub(${prop})`;
          return MotionStub;
        }
        return undefined;
      },
    },
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useAnimation: () => ({ start: vi.fn(), stop: vi.fn(), set: vi.fn() }),
  useInView: () => true,
}));

// --- Page Smoke Tests ---

interface PageEntry {
  name: string;
  importFn: () => Promise<{ default: React.ComponentType }>;
}

const PAGES: PageEntry[] = [
  { name: "Dashboard", importFn: () => import("../../app/page") },
  { name: "Users", importFn: () => import("../../app/users/page") },
  { name: "Onboarding", importFn: () => import("../../app/onboarding/page") },
  { name: "Events", importFn: () => import("../../app/events/page") },
  {
    name: "Communities",
    importFn: () => import("../../app/communities/page"),
  },
  { name: "Audit", importFn: () => import("../../app/audit/page") },
];

describe("Admin Pages Smoke Tests", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockApi.get.mockResolvedValue({ data: [] });
    mockApi.post.mockResolvedValue({ data: {} });
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => {
        const [firstArg] = args;
        if (
          typeof firstArg === "string" &&
          firstArg.includes(
            "You provided a `value` prop to a form field without an `onChange` handler",
          )
        ) {
          return;
        }
        originalConsoleError(...args);
      });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe.each(PAGES)("$name page", ({ importFn }) => {
    it("renders without crashing", async () => {
      const mod = await importFn();
      const Page = mod.default;
      const { container } = render(<Page />);
      expect(container.innerHTML.length).toBeGreaterThan(0);
    });
  });
});
