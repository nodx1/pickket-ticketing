import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "../alert-dialog";

describe("AlertDialog", () => {
  it("does not show content when closed", () => {
    render(
      <AlertDialog>
        <AlertDialogTrigger>Open</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm</AlertDialogTitle>
            <AlertDialogDescription>Are you sure?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expect(screen.queryByText("Are you sure?")).not.toBeInTheDocument();
  });

  it("shows content when trigger is clicked", async () => {
    render(
      <AlertDialog>
        <AlertDialogTrigger>Open</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm</AlertDialogTitle>
            <AlertDialogDescription>Are you sure?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    fireEvent.click(screen.getByText("Open"));
    await waitFor(() => {
      expect(screen.getByText("Are you sure?")).toBeInTheDocument();
    });
  });

  it("renders trigger with data-slot", () => {
    render(
      <AlertDialog>
        <AlertDialogTrigger data-testid="trig">Open</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>T</AlertDialogTitle>
          <AlertDialogDescription>Trigger description</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expect(screen.getByTestId("trig")).toHaveAttribute(
      "data-slot",
      "alert-dialog-trigger",
    );
  });

  it("renders action with button styling", async () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogTitle>Title</AlertDialogTitle>
          <AlertDialogDescription>Action description</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction data-testid="action">Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    await waitFor(() => {
      const action = screen.getByTestId("action");
      expect(action).toBeInTheDocument();
      expect(action.className).toContain("inline-flex");
    });
  });

  it("renders cancel with outline variant", async () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogTitle>Title</AlertDialogTitle>
          <AlertDialogDescription>Cancel description</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="cancel">No</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    await waitFor(() => {
      const cancel = screen.getByTestId("cancel");
      expect(cancel.className).toContain("border");
    });
  });

  it("header has data-slot='alert-dialog-header'", async () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogHeader data-testid="hdr">
            <AlertDialogTitle>T</AlertDialogTitle>
            <AlertDialogDescription>Header description</AlertDialogDescription>
          </AlertDialogHeader>
        </AlertDialogContent>
      </AlertDialog>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("hdr")).toHaveAttribute(
        "data-slot",
        "alert-dialog-header",
      );
    });
  });

  it("footer has data-slot='alert-dialog-footer'", async () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogTitle>T</AlertDialogTitle>
          <AlertDialogDescription>Footer description</AlertDialogDescription>
          <AlertDialogFooter data-testid="ftr">
            <AlertDialogAction>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ftr")).toHaveAttribute(
        "data-slot",
        "alert-dialog-footer",
      );
    });
  });
});
