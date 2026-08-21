import { describe, it, expect } from "vitest";
import { cn } from "../utils";

describe("cn (className merge utility)", () => {
  it("merges simple class names", () => {
    const result = cn("foo", "bar");
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  it("handles undefined and null inputs", () => {
    const result = cn("foo", undefined, null, "bar");
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  it("handles empty string", () => {
    const result = cn("", "foo");
    expect(result).toBe("foo");
  });

  it("handles boolean conditionals", () => {
    const result = cn("base", false && "hidden", true && "visible");
    expect(result).toContain("base");
    expect(result).toContain("visible");
    expect(result).not.toContain("hidden");
  });

  it("merges Tailwind classes with conflict resolution", () => {
    // twMerge should resolve conflicting Tailwind classes
    const result = cn("px-2 py-1", "px-4");
    expect(result).toContain("px-4");
    expect(result).not.toContain("px-2");
  });

  it("handles array inputs via clsx", () => {
    const result = cn(["foo", "bar"]);
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  it("handles no arguments", () => {
    const result = cn();
    expect(result).toBe("");
  });
});
