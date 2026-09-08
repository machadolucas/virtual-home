/**
 * How `/today` is divided up.
 *
 * The three decisions worth pinning down: blocked wins over the due date (a task you cannot start
 * does not belong in "needs attention"), condition work gets its own section regardless of its due
 * date, and the sort is `(priority DESC, due_date ASC)` exactly as §3.3 specifies.
 */
import { describe, expect, it } from "vitest";
import {
  compareTasks,
  groupToday,
  ownerBucket,
  ownerBucketLabel,
  sectionFor,
  type GroupableTask,
} from "@/features/maintenance/grouping";

const TODAY = "2026-09-08";
const LUCAS = "user-lucas";
const MARJA = "user-marja";

function task(overrides: Partial<GroupableTask> & { id: string; dueDate: string }): GroupableTask {
  return {
    status: "due",
    source: "plan",
    priority: "normal",
    blockedReason: null,
    serviceBookingId: null,
    assignmentMode: "shared",
    assigneeUserId: null,
    ...overrides,
  };
}

describe("sectionFor", () => {
  it("puts overdue and due-today work in needs attention", () => {
    expect(sectionFor(task({ id: "a", dueDate: "2026-09-01" }), TODAY)).toBe("needs_attention");
    expect(sectionFor(task({ id: "b", dueDate: TODAY }), TODAY)).toBe("needs_attention");
  });

  it("puts the next week in ready, and the rest of the month in upcoming", () => {
    expect(sectionFor(task({ id: "c", dueDate: "2026-09-15" }), TODAY)).toBe("ready");
    expect(sectionFor(task({ id: "d", dueDate: "2026-09-16" }), TODAY)).toBe("upcoming");
    expect(sectionFor(task({ id: "e", dueDate: "2026-10-08" }), TODAY)).toBe("upcoming");
  });

  it("drops anything further out than 30 days", () => {
    expect(sectionFor(task({ id: "f", dueDate: "2026-12-01" }), TODAY)).toBeNull();
  });

  it("drops closed occurrences entirely", () => {
    for (const status of ["completed", "skipped", "cancelled"] as const) {
      expect(sectionFor(task({ id: "g", dueDate: TODAY, status }), TODAY)).toBeNull();
    }
  });

  it("sends a blocked task to the waiting section however overdue it is", () => {
    expect(
      sectionFor(
        task({ id: "h", dueDate: "2026-01-01", blockedReason: "waiting for filters" }),
        TODAY,
      ),
    ).toBe("blocked");
  });

  it("treats a booked task as waiting — a booking is not a completion", () => {
    expect(
      sectionFor(task({ id: "i", dueDate: "2026-09-01", serviceBookingId: "b1" }), TODAY),
    ).toBe("blocked");
  });

  it("gives condition work its own section, ignoring the 30-day horizon", () => {
    expect(sectionFor(task({ id: "j", dueDate: "2026-09-01", source: "condition" }), TODAY)).toBe(
      "condition",
    );
    expect(sectionFor(task({ id: "k", dueDate: "2027-01-01", source: "condition" }), TODAY)).toBe(
      "condition",
    );
  });
});

describe("ownerBucket", () => {
  it("calls a shared task shared, not unassigned", () => {
    expect(ownerBucket(task({ id: "a", dueDate: TODAY }), LUCAS)).toBe("shared");
  });

  it("separates mine from the other member's", () => {
    const mine = task({
      id: "b",
      dueDate: TODAY,
      assignmentMode: "user",
      assigneeUserId: LUCAS,
    });
    const theirs = task({
      id: "c",
      dueDate: TODAY,
      assignmentMode: "user",
      assigneeUserId: MARJA,
    });
    expect(ownerBucket(mine, LUCAS)).toBe("mine");
    expect(ownerBucket(theirs, LUCAS)).toBe("partner");
  });
});

describe("ownerBucketLabel", () => {
  it("names the partner when the household has one", () => {
    expect(ownerBucketLabel("partner", "Marja")).toBe("Marja's");
    expect(ownerBucketLabel("partner", null)).toBe("Assigned to the other member");
    expect(ownerBucketLabel("mine", "Marja")).toBe("Yours");
  });
});

describe("compareTasks", () => {
  it("sorts by priority first, then by due date", () => {
    const urgentLater = task({ id: "a", dueDate: "2026-09-20", priority: "urgent" });
    const normalSooner = task({ id: "b", dueDate: "2026-09-09" });
    expect([normalSooner, urgentLater].sort(compareTasks).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("is stable on identical priority and date", () => {
    const first = task({ id: "aaa", dueDate: TODAY });
    const second = task({ id: "bbb", dueDate: TODAY });
    expect([second, first].sort(compareTasks).map((t) => t.id)).toEqual(["aaa", "bbb"]);
  });
});

describe("groupToday", () => {
  const tasks: GroupableTask[] = [
    task({ id: "overdue-mine", dueDate: "2026-09-01", assignmentMode: "user", assigneeUserId: LUCAS }),
    task({ id: "today-shared", dueDate: TODAY }),
    task({
      id: "today-theirs",
      dueDate: TODAY,
      assignmentMode: "user",
      assigneeUserId: MARJA,
    }),
    task({ id: "soon", dueDate: "2026-09-12" }),
    task({ id: "later", dueDate: "2026-09-30" }),
    task({ id: "waiting", dueDate: "2026-09-02", blockedReason: "no filters" }),
    task({ id: "battery", dueDate: "2026-09-03", source: "condition" }),
    task({ id: "far", dueDate: "2027-02-01" }),
    task({ id: "done", dueDate: TODAY, status: "completed" }),
  ];

  const groups = groupToday(tasks, TODAY, LUCAS);

  it("routes every open row inside the horizon into exactly one section", () => {
    expect(groups.needsAttention.mine.map((t) => t.id)).toEqual(["overdue-mine"]);
    expect(groups.needsAttention.shared.map((t) => t.id)).toEqual(["today-shared"]);
    expect(groups.needsAttention.partner.map((t) => t.id)).toEqual(["today-theirs"]);
    expect(groups.ready.map((t) => t.id)).toEqual(["soon"]);
    expect(groups.upcoming.map((t) => t.id)).toEqual(["later"]);
    expect(groups.blocked.map((t) => t.id)).toEqual(["waiting"]);
    expect(groups.condition.map((t) => t.id)).toEqual(["battery"]);
  });

  it("counts only what it actually placed", () => {
    // The 30-day-out row and the completed row are excluded, so the count is 7, not 9.
    expect(groups.total).toBe(7);
  });
});
