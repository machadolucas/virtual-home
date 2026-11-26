import { formatQty, type MaterialDraft } from "@/features/maintenance/materials";
import type { HouseRuntime } from "../runtime";
import type { PanelKey, PanelPage, PanelRow } from "./panel";
import {
  HEADSET_PURPOSES, type HeadsetChecklistField, type HeadsetFindInput, type HeadsetLocateTarget,
  type HeadsetMaintenanceOverview, type HeadsetMaintenanceTask, type HeadsetSearchPage, type HeadsetStepPin,
  type HeadsetTaskWrite, type HeadsetIllustration,
} from "./headsetTasksTypes";

interface HeadsetTaskActions {
  locate(target: HeadsetLocateTarget): void;
  openPinned(pin: HeadsetStepPin | null): void;
  tell(message: string): void;
  exit(): void;
}

type Page = "find" | "categories" | "results" | "target" | "maintenance" | "task" | "step" | "checklist" |
  "entry" | "materials" | "part" | "providers" | "review" | "confirm";
type Entry = { title: string; text: string; symbols: boolean; uppercase: boolean } & (
  { kind: "text" | "number"; accept(text: string): void } | { kind: "search" }
);
type LiveSearch = { query: string; matches?: HeadsetSearchPage; error?: string };
type Outcome = Extract<HeadsetTaskWrite, { kind: "complete" }>["outcome"];
const SEARCH_WAIT_MS = 220;
const QUICK_MATCHES = 3;

const categories = [
  ["appliance", "Appliances"], ["hvac", "Heating and ventilation"], ["plumbing", "Plumbing"],
  ["electrical", "Electrical"], ["network", "Network"], ["safety", "Safety"],
  ["structure", "Structure"], ["outdoor", "Outdoor"], ["vehicle", "Vehicles"], ["other", "Other"],
] as const;
const outcomes: readonly Outcome[] = ["done", "done_with_issues", "partial"];
const outcomeLabels: Record<Outcome, string> = { done: "Completed", done_with_issues: "Completed with issues", partial: "Partial work" };
const errors: Record<string, string> = {
  unknown_headset_equipment: "This placement is no longer available.",
  unknown_headset_task: "This task is no longer open here.",
  headset_required_step: "Finish the required steps before confirming.",
  headset_checklist_value_required: "Record the required checklist values before confirming.",
  headset_provider_required: "Choose the documented service provider who did the work.",
  headset_materials_changed: "Expected materials changed. Reopen this task to review the new list.",
  insufficient_stock: "Stock is short. Review the material quantities and choose how to record the difference.",
  occurrence_not_open: "This task is already closed. Return to the equipment to refresh.",
};

class HeadsetTaskError extends Error {
  constructor(readonly code: string, status: number, readonly details?: { lines?: { partId: string; availableMilli: number }[] }) {
    super(errors[code] ?? (status === 401 ? "Sign in again to continue." : "The request could not be completed."));
  }
}

async function request<T>(path: string, write?: HeadsetTaskWrite, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...(signal && { signal }),
    ...(write
      ? {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-vh-headset-task": "1" },
          body: JSON.stringify(write),
        }
      : {}),
  });
  if (!response.ok) {
    const value = (await response.json().catch(() => null)) as {
      error?: string;
      details?: HeadsetTaskError["details"];
    } | null;
    throw new HeadsetTaskError(value?.error ?? "", response.status, value?.details);
  }
  return (await response.json()) as T;
}

function plain(value: string | null | undefined) {
  return value?.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").trim() ?? "";
}

const lines = (...items: Array<string | null | undefined>) => items.flatMap((text) => text?.split(/\n/).filter(Boolean) ?? []);
const describePlace = (target: HeadsetLocateTarget) => [target.roomName, target.floorName].filter(Boolean).join(" · ");

export class HeadsetTasks {
  private page: Page | null = null;
  private readonly stack: Page[] = [];
  private epoch = 0;
  private busy = false;
  private note = "";
  private roomId: string | null = null;
  private query: HeadsetFindInput = {};
  private hits: HeadsetSearchPage = { items: [], nextOffset: null };
  private target: HeadsetLocateTarget | null = null;
  private overview: HeadsetMaintenanceOverview | null = null;
  private task: HeadsetMaintenanceTask | null = null;
  private stepIndex = 0;
  private looseChecklist = false;
  private permanentPin = false;
  private illustrationIndex = 0;
  private requestId = "";
  private drafts: MaterialDraft[] = [];
  private partId = "";
  private providerId: string | undefined;
  private outcome: Outcome = "done";
  private entry: Entry | null = null;
  private liveSearch: LiveSearch | null = null;
  private liveSearchTimer: ReturnType<typeof setTimeout> | undefined;
  private liveSearchRequest: AbortController | undefined;
  private photoItem: HeadsetChecklistField | null = null;

  constructor(private readonly runtime: HouseRuntime, private readonly actions: HeadsetTaskActions) {}

  get active() { return this.page !== null; }

  find(roomId?: string | null) {
    this.start("find");
    this.roomId = roomId ?? null;
    this.hits = { items: [], nextOffset: null };
  }

  maintenance(placementId: string) {
    this.start("maintenance");
    this.overview = null;
    this.task = null;
    void this.run(async () => await request<HeadsetMaintenanceOverview>(this.url(placementId)), (value) => {
      this.overview = value;
      this.target = value.target;
    });
  }

  back() {
    if (!this.page || this.busy) return false;
    if (this.photoItem) {
      this.photoItem = null;
      return true;
    }
    if (this.page === "entry") this.endEntry();
    this.note = "";
    const previous = this.stack.pop();
    if (!previous) {
      this.close();
      this.actions.exit();
    } else this.page = previous;
    return true;
  }

  /** Closing tools leaves an intentionally pinned card available for hands-free work. */
  close() {
    this.endEntry();
    this.epoch++;
    this.busy = false;
    this.page = null;
    this.stack.length = 0;
  }

  clearPin() {
    if (this.permanentPin) {
      this.permanentPin = false;
      this.actions.openPinned(null);
    }
  }

  dispose() {
    this.close();
    this.clearPin();
  }

  private start(page: Page) {
    this.close();
    this.clearPin();
    this.page = page;
    this.note = "";
    this.photoItem = null;
  }

  private go(page: Page) {
    if (this.page !== null) this.stack.push(this.page);
    this.page = page;
    this.note = "";
  }

  private url(placementId: string, task?: string) {
    return `${this.runtime.base}/headset/equipment/${encodeURIComponent(placementId)}${task ? `?task=${encodeURIComponent(task)}` : ""}`;
  }

  private async run<T>(load: () => Promise<T>, accept: (value: T) => void) {
    if (this.busy) return;
    const epoch = this.epoch;
    this.busy = true;
    this.note = "";
    try {
      const value = await load();
      if (this.epoch === epoch) accept(value);
    } catch (error) {
      if (this.epoch === epoch) {
        if (error instanceof HeadsetTaskError && error.code === "insufficient_stock" && this.task) {
          const values = new Map(error.details?.lines?.map(({ partId, availableMilli }) => [partId, availableMilli]) ?? []);
          this.task = { ...this.task, materials: this.task.materials.map((line) => ({
            ...line, availableMilli: values.get(line.partId) ?? line.availableMilli,
          })) };
          if (this.page === "confirm") this.backToReview();
        }
        this.note = error instanceof Error ? error.message : "The request could not be completed.";
      }
    } finally {
      if (this.epoch === epoch) this.busy = false;
    }
  }

  private findBy(input: HeadsetFindInput, append = false) {
    if (!append) {
      this.query = { ...input, roomId: this.roomId ?? undefined };
      this.hits = { items: [], nextOffset: null };
      this.go("results");
    }
    void this.run(
      () => this.loadEquipment(this.query, append ? this.hits.nextOffset : 0),
      (value) => {
        this.hits = { ...value, items: append ? [...this.hits.items, ...value.items] : value.items };
      },
    );
  }

  private loadEquipment(input: HeadsetFindInput, offset: number | null, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...input, offset }))
      if (value !== undefined && value !== null)
        params.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    return request<HeadsetSearchPage>(`${this.runtime.base}/headset/find?${params}`, undefined, signal);
  }

  private cancelLiveSearch() {
    clearTimeout(this.liveSearchTimer);
    this.liveSearchTimer = undefined;
    this.liveSearchRequest?.abort();
    this.liveSearchRequest = undefined;
  }

  private endEntry() {
    this.entry = null;
    this.liveSearch = null;
    this.cancelLiveSearch();
  }

  private queueLiveSearch(query: string) {
    this.cancelLiveSearch();
    this.liveSearch = query ? { query } : null;
    const search = this.liveSearch;
    if (!search) return;
    this.liveSearchTimer = setTimeout(() => {
      this.liveSearchTimer = undefined;
      const controller = new AbortController();
      this.liveSearchRequest = controller;
      void this.loadEquipment({ q: query, roomId: this.roomId ?? undefined }, 0, controller.signal)
        .then((matches) => {
          if (this.liveSearch === search) search.matches = matches;
        })
        .catch((error: unknown) => {
          if (this.liveSearch === search && !controller.signal.aborted)
            search.error = error instanceof Error ? error.message : "Search could not be completed.";
        })
        .finally(() => {
          if (this.liveSearchRequest === controller) this.liveSearchRequest = undefined;
        });
    }, SEARCH_WAIT_MS);
  }

  private openTask(occurrenceId: string) {
    const placement = this.target?.placementId;
    if (!placement) return;
    this.clearPin();
    this.go("task");
    this.task = null;
    void this.run(async () => await request<HeadsetMaintenanceTask>(this.url(placement, occurrenceId)), (value) => {
      this.task = value;
      this.drafts = value.materials.map((line) => ({ partId: line.partId, actualQtyMilli: line.expectedQtyMilli }));
      this.providerId = undefined;
      this.outcome = "done";
      this.requestId = crypto.randomUUID();
      const done = new Set(value.progress.filter((row) => row.itemKind === "step" &&
        (row.state === "done" || row.state === "skipped")).map(({ stepId }) => stepId));
      this.stepIndex = Math.max(0, value.procedure?.steps.findIndex((step) => !done.has(step.id)) ?? 0);
      this.illustrationIndex = 0;
    });
  }

  private write(input: HeadsetTaskWrite, after?: () => void) {
    const placement = this.target?.placementId;
    if (!placement) return;
    void this.run(async () => {
      const result = await request<{ completionId?: string }>(this.url(placement), input);
      if (input.kind === "complete") return { result };
      return { result, task: await request<HeadsetMaintenanceTask>(this.url(placement, input.occurrenceId)) };
    }, ({ result, task }) => {
      if (task) this.task = task;
      if (result.completionId) {
        this.actions.tell("Maintenance completion recorded.");
        this.maintenance(placement);
      } else after?.();
    });
  }

  private currentStep() { return this.task?.procedure?.steps[this.stepIndex]; }

  private illustrations(): HeadsetIllustration[] {
    const all = this.task?.illustrations ?? [];
    return [...(all.find((item) => item.stepId === this.currentStep()?.id)?.previews ?? []),
      ...(all.find((item) => item.stepId === null)?.previews ?? [])];
  }

  private pinStep() {
    const current = this.currentStep(), target = this.target, task = this.task;
    if (!current || !target || !task) return;
    this.permanentPin = true;
    this.actions.openPinned({
      target, taskTitle: task.title, title: current.title, body: plain(current.bodyMd),
      warning: current.warning ?? undefined, index: this.stepIndex + 1, total: task.procedure!.steps.length,
      illustration: this.illustrations()[this.illustrationIndex],
    });
  }

  private setStep(index: number) {
    this.stepIndex = index;
    this.illustrationIndex = 0;
    if (this.permanentPin) this.pinStep();
  }

  private beginEntry(title: string, kind: "text" | "number", accept: (text: string) => void, initial = "") {
    this.entry = { title, kind, accept, text: initial, symbols: false, uppercase: false };
    this.go("entry");
  }

  private beginSearch() {
    this.entry = { title: "Search equipment", kind: "search", text: "", symbols: false, uppercase: false };
    this.go("entry");
  }

  private checklistValue(item: HeadsetChecklistField, value?: string | number, state: "done" | "todo" = "done") {
    if (!this.task) return;
    this.write({ kind: "checklist", occurrenceId: this.task.id, itemId: item.id, state, value }, () => { this.photoItem = null; });
  }

  private editChecklist(item: HeadsetChecklistField) {
    const prior = this.task?.progress.find((row) => row.checklistItemId === item.id);
    if (!item.requiresValue) { this.checklistValue(item, undefined, prior?.state === "done" ? "todo" : "done"); return; }
    if (item.requiresValue === "photo") { this.photoItem = item; return; }
    this.beginEntry(item.unit ? `${item.text} · ${item.unit}` : item.text, item.requiresValue, (text) => {
      this.checklistValue(item, item.requiresValue === "number" ? Number(text) : text);
    }, item.requiresValue === "number" ? String(prior?.valueNumber ?? "") : prior?.valueText ?? "");
  }

  private panel(title: string, contents: (string | null | undefined)[], rows: PanelRow[] = []): PanelPage {
    return { title, lines: lines(this.note, this.busy ? "Updating…" : "", ...contents), rows: this.busy
      ? rows.map((row) => ({ ...row, act: undefined })) : rows, back: () => { this.back(); } };
  }

  menu(): PanelPage {
    switch (this.page) {
      case "find":
        return this.panel(
          "Find equipment",
          ["Choose what you need or browse the documented household equipment."],
          [
            ...Object.entries(HEADSET_PURPOSES).map(([purpose, label]) => ({
              label,
              act: () => this.findBy({ purpose: purpose as HeadsetFindInput["purpose"] }),
            })),
            ...(this.roomId
              ? [{ label: "Equipment in this room", act: () => this.findBy({ onlyRoom: true }) }]
              : []),
            { label: "Browse all equipment", act: () => this.findBy({}) },
            { label: "Browse by category", act: () => this.go("categories") },
            { label: "Search by name or model", act: () => this.beginSearch() },
          ],
        );
      case "categories":
        return this.panel(
          "Equipment categories",
          [],
          categories.map(([category, label]) => ({
            label,
            act: () => this.findBy({ category }),
          })),
        );
      case "results":
        return this.panel(
          this.query.purpose ? HEADSET_PURPOSES[this.query.purpose] : "Equipment",
          [
            this.query.q ? `Search · ${this.query.q}` : "",
            this.hits.items.length === 0 && !this.busy ? "No matching records in the installed model." : "",
          ],
          [
            ...this.hits.items.map((target) => this.equipmentRow(target)),
            ...(this.hits.nextOffset === null
              ? []
              : [{ label: "More results", act: () => this.findBy(this.query, true) }]),
          ],
        );
      case "target":
        return this.targetMenu();
      case "maintenance":
        return this.overviewMenu();
      case "task":
        return this.taskMenu();
      case "step":
        return this.stepMenu();
      case "checklist":
        return this.checklistMenu();
      case "entry":
        return this.entryMenu();
      case "materials":
        return this.materialsMenu();
      case "part":
        return this.partMenu();
      case "providers":
        return this.panel(
          "Who performed the work?",
          [],
          this.task?.providers.map(({ id, name }) => ({
            id,
            label: name,
            active: id === this.providerId,
            act: () => {
              this.providerId = id;
              this.back();
            },
          })),
        );
      case "review":
        return this.reviewMenu();
      case "confirm":
        return this.confirmMenu();
      default:
        return this.panel("Headset tools", []);
    }
  }

  private targetMenu() {
    const target = this.target;
    if (!target) return this.panel("Equipment", []);
    const airHandler = target.finding === "air_handler_filter_unrecorded";
    return this.panel(target.name, [
      airHandler ? "Air handler · filter position unrecorded" : "",
      describePlace(target), target.modelName, target.position ? airHandler ? "Documented air handler position" : "Documented position"
        : target.roomId ? "Only the room is documented." : "Position not documented.",
      target.kind === "endpoint" ? target.servedFixtures.length ? "Documented downstream fixtures" : "No downstream fixtures documented." : "",
    ], [
      { label: target.position ? "Locate in house" : "Locate room", style: "primary", icon: "rooms",
        act: target.position || target.roomId ? () => this.actions.locate(target) : undefined },
      ...target.servedFixtures.map(({ id, name }) => ({ id, label: name })),
      ...(target.placementId ? [{ label: "Maintenance at this equipment", act: () => this.maintenance(target.placementId!) }] : []),
    ]);
  }

  private overviewMenu() {
    const overview = this.overview;
    if (!overview) return this.panel("Equipment maintenance", []);
    return this.panel(overview.target.name, [
      describePlace(overview.target), overview.target.modelName,
      overview.lastWork ? `Last recorded work · ${overview.lastWork.date} · ${overview.lastWork.title} · ${outcomeLabels[overview.lastWork.outcome as Outcome] ?? overview.lastWork.outcome}`
        : "No completed work recorded.",
      overview.tasks.length ? "" : "No open maintenance task for this equipment.",
    ], [
      ...overview.tasks.map((task, index) => ({ id: task.id,
        label: task.title, detail: `${task.status === "due" ? "Due" : "Scheduled"} · ${task.dueDate}`,
        ...(index === 0 && { style: "primary" as const, icon: "rooms" as const }),
        act: () => this.openTask(task.id),
      })),
      ...(overview.parts.length ? [{ label: "Consumables and stock", act: () => this.go("materials") }] : []),
    ]);
  }

  private taskMenu() {
    const task = this.task;
    if (!task) return this.panel("Maintenance task", []);
    return this.panel(task.title, [
      `Due ${task.dueDate}`, plain(task.description), plain(task.procedure?.prerequisites), plain(task.procedure?.safetyNotes),
      ...(task.procedure?.tools ?? []).map((tool) => `${tool.isRequired ? "Required tool" : "Tool"} · ${tool.name}${tool.notes ? ` · ${tool.notes}` : ""}`),
    ], [
      ...(task.procedure?.steps.length ? [{ label: "Open current step", style: "primary" as const, icon: "rooms" as const, act: () => this.go("step") }] : []),
      ...(task.procedure?.looseChecklist.length ? [{ label: "Task checklist", act: () => { this.looseChecklist = true; this.go("checklist"); } }] : []),
      { label: "Materials and stock", act: () => this.go("materials") },
      { label: "Review completion", act: () => this.go("review") },
    ]);
  }

  private stepMenu() {
    const step = this.currentStep(), task = this.task;
    if (!step || !task) return this.panel("Procedure step", []);
    const state = task.progress.find((row) => row.itemKind === "step" && row.stepId === step.id)?.state;
    const illustrations = this.illustrations();
    const photo = illustrations[this.illustrationIndex];
    return this.panel(step.title, [
      `Step ${this.stepIndex + 1} of ${task.procedure!.steps.length}${step.isOptional ? " · Optional" : ""}${state === "done" ? " · Marked done" : state === "skipped" ? " · Skipped" : ""}`,
      step.warning, plain(step.bodyMd), photo ? `${photo.label}${photo.page ? ` · Page ${photo.page}` : ""}` : "",
    ], [
      { label: this.permanentPin ? "Unpin step card" : "Pin step beside equipment", act: () => this.permanentPin ? this.clearPin() : this.pinStep() },
      ...(illustrations.length > 1 ? [{ label: "Next illustration", act: () => {
        this.illustrationIndex = (this.illustrationIndex + 1) % illustrations.length;
        if (this.permanentPin) this.pinStep();
      } }] : []),
      ...(step.checklist.length ? [{ label: "Step checklist", act: () => { this.looseChecklist = false; this.go("checklist"); } }] : []),
      { label: state === "done" ? "Reopen step" : "Mark step done", act: () => this.write({
        kind: "step", occurrenceId: task.id, stepId: step.id, state: state === "done" ? "todo" : "done",
      }) },
      ...(step.isOptional && state !== "skipped" ? [{ label: "Skip optional step", act: () => this.write({
        kind: "step", occurrenceId: task.id, stepId: step.id, state: "skipped",
      }) }] : []),
      { label: "Previous step", act: this.stepIndex > 0 ? () => this.setStep(this.stepIndex - 1) : undefined },
      { label: "Next step", act: this.stepIndex + 1 < (task.procedure?.steps.length ?? 0) ? () => this.setStep(this.stepIndex + 1) : undefined },
    ]);
  }

  private checklistMenu() {
    const task = this.task;
    if (!task) return this.panel("Checklist", []);
    const photoItem = this.photoItem;
    if (photoItem) return this.panel("Choose a task photo", [
      photoItem.text, task.photos.length ? "" : "Attach a photo to this same task on your phone, then reopen it here.",
    ], task.photos.map((photo) => ({ label: photo.label, act: () => this.checklistValue(photoItem, photo.id) })));
    const fields = this.looseChecklist ? task.procedure?.looseChecklist : this.currentStep()?.checklist;
    return this.panel("Checklist", [], (fields ?? []).map((item) => {
      const row = task.progress.find((progress) => progress.checklistItemId === item.id);
      return { id: item.id, label: item.text, active: row?.state === "done",
        detail: row?.state === "done" ? row.valueNumber !== null ? `${row.valueNumber} ${item.unit ?? ""}` :
          row.valueText ?? "Recorded" : item.requiresValue ? `Required ${item.requiresValue}` : undefined,
        act: () => this.editChecklist(item) };
    }));
  }

  private entryMenu() {
    const entry = this.entry;
    if (!entry) return this.panel("Enter value", []);
    const text = entry.text.trim();
    const numeric = entry.kind === "number";
    const valid = text !== "" && (!numeric || Number.isFinite(Number(text)));
    const apply = (operation: () => void) => () => {
      if (this.page === "entry" && this.entry === entry) operation();
    };
    const change = (value: string) => {
      entry.text = value.slice(0, entry.kind === "text" ? 500 : 80);
      if (entry.kind === "search" && (this.liveSearch?.query ?? "") !== entry.text.trim())
        this.queueLiveSearch(entry.text.trim());
    };
    const key = (
      id: string,
      label: string,
      operation: (() => void) | undefined,
      span = 1,
      keyTone?: PanelKey["keyTone"],
      active?: boolean,
    ): PanelKey => ({
      id,
      label,
      act: operation && apply(operation),
      span,
      keyTone,
      active,
    });
    const character = (value: string, span = 1) => {
      const label = entry.uppercase ? value.toUpperCase() : value;
      return key(
        `char-${value}`,
        label,
        value === "." && numeric && entry.text.includes(".") ? undefined : () => change(entry.text + label),
        span,
      );
    };
    const clear = key(
      "clear",
      "Clear",
      entry.text ? () => change("") : undefined,
      numeric ? 2.8 : 1.65,
      "utility",
    );
    const erase = key(
      "erase",
      "Delete",
      entry.text ? () => change([...entry.text].slice(0, -1).join("")) : undefined,
      numeric ? 2.8 : 1.35,
      "utility",
    );
    const accept = entry.kind === "search" ? undefined : entry.accept;
    const submit = (span: number) =>
      key(
        "accept",
        "Use value",
        accept && valid
          ? () => {
              this.back();
              accept(text);
            }
          : undefined,
        span,
        "confirm",
      );
    const letters = (line: string, span = 1) => [...line].map((value) => character(value, span));
    const keys = numeric
      ? [
          letters("789", 1.8),
          letters("456", 1.8),
          letters("123", 1.8),
          [
            key(
              "sign",
              "±",
              () => change(entry.text.startsWith("-") ? entry.text.slice(1) : `-${entry.text}`),
              1.8,
            ),
            character("0", 1.8),
            character(".", 1.8),
          ],
          [clear, erase, submit(2.8)],
        ]
      : [
          letters(entry.symbols ? "1234567890" : "qwertyuiop"),
          letters(entry.symbols ? "äöå@#&-_+" : "asdfghjkl"),
          [
            key(
              "shift",
              "Shift",
              () => {
                entry.uppercase = !entry.uppercase;
              },
              1.35,
              "utility",
              entry.uppercase,
            ),
            ...letters(entry.symbols ? "!?.,/:’" : "zxcvbnm"),
            erase,
          ],
          [
            key(
              "symbols",
              entry.symbols ? "ABC" : "123",
              () => {
                entry.symbols = !entry.symbols;
              },
              1.35,
              "utility",
              entry.symbols,
            ),
            key(
              "space",
              "Space",
              () => change(entry.text + " "),
              entry.kind === "search" ? 5.5 : 4.2,
              "utility",
            ),
            clear,
            ...(entry.kind === "search" ? [] : [submit(1.9)]),
          ],
        ];
    const search = entry.kind === "search";
    const page = this.panel(entry.title, [], search ? this.liveEquipmentRows() : []);
    const status = this.liveSearch;
    page.keyboard = {
      keys,
      text: entry.text,
      placeholder: search ? "Equipment name or model" : numeric ? "Enter a number" : "Enter text",
      ...(search && {
        resultSlots: QUICK_MATCHES + 1,
        status: !status
          ? "Matches appear as you type"
          : (status.error ??
            (status.matches
              ? status.matches.items.length
                ? "Matching equipment"
                : "No matching equipment"
              : "Searching…")),
      }),
    };
    return page;
  }

  private equipmentRow(target: HeadsetLocateTarget, enabled = () => true): PanelRow {
    const airHandler = target.finding === "air_handler_filter_unrecorded";
    return {
      id: target.id,
      label: airHandler ? `Air handler · ${target.name}` : target.name,
      detail: airHandler
        ? "Filter position unrecorded"
        : (target.roomName ?? target.floorName ?? undefined),
      act: () => {
        if (enabled()) {
          this.target = target;
          this.go("target");
        }
      },
    };
  }

  private liveEquipmentRows(): PanelRow[] {
    const search = this.liveSearch;
    if (!search) return [];
    const current = () => this.page === "entry" && this.liveSearch === search;
    if (search.error)
      return [
        {
          label: "Retry search",
          act: () => {
            if (current()) this.queueLiveSearch(search.query);
          },
        },
      ];
    const data = search.matches;
    if (!data) return [];
    return [
      ...data.items.slice(0, QUICK_MATCHES).map((target) => this.equipmentRow(target, current)),
      ...(data.items.length > QUICK_MATCHES || data.nextOffset !== null
        ? [
            {
              label: "View all matches",
              act: () => {
                if (!current()) return;
                this.query = { q: search.query, roomId: this.roomId ?? undefined };
                this.hits = data;
                this.go("results");
              },
            },
          ]
        : []),
    ];
  }

  private materialsMenu() {
    const parts = this.overview?.parts ?? [];
    const materials = this.task?.materials ?? [];
    return this.panel("Materials and stock", parts.length || materials.length ? [] : ["No materials are documented for this work."], [
      ...materials.map((line) => ({ id: line.partId, label: line.partName,
        detail: formatQty(line.availableMilli, line.unit), act: () => { this.partId = line.partId; this.go("part"); } })),
      ...parts.filter((part) => !materials.some((line) => line.partId === part.partId)).map((part) => ({
        id: part.partId, label: part.name, detail: part.stockMilli === null ? "By kit components" : formatQty(part.stockMilli, part.unit),
        act: () => { this.partId = part.partId; this.go("part"); },
      })),
    ]);
  }

  private partMenu() {
    const part = this.overview?.parts.find((item) => item.partId === this.partId);
    const material = this.task?.materials.find((item) => item.partId === this.partId);
    const draft = this.drafts.find((item) => item.partId === this.partId);
    const unit = part?.unit ?? material?.unit;
    const stock = material?.availableMilli ?? part?.stockMilli;
    return this.panel(part?.name ?? material?.partName ?? "Material", [
      part?.spec ?? material?.spec, [part?.manufacturer, part?.productCode].filter(Boolean).join(" · "), part?.dimensions,
      stock === null ? "Stock is tracked by kit components." : stock !== undefined && unit ? `On hand · ${formatQty(stock, unit)}` : "",
      part?.lastReplacementDate ? `Last recorded replacement · ${part.lastReplacementDate}` :
        part?.lastUseDate ? `Last recorded use · ${part.lastUseDate}` : "",
      material && draft ? `Actual use · ${formatQty(draft.actualQtyMilli, material.unit)}` : "",
    ], material && draft ? [
      { label: "Enter actual quantity", act: () => this.beginEntry("Actual quantity", "number", (value) => {
        const qty = Math.round(Number(value) * 1000);
        if (qty < 0 || qty > 1_000_000_000 || (material.trackingMode === "discrete" && qty % 1000 !== 0))
          this.note = "Enter a valid nonnegative quantity for this part.";
        else { draft.actualQtyMilli = qty; delete draft.resolutionIfShort; }
      }, String(draft.actualQtyMilli / 1000)) },
      { label: "Use the planned quantity", act: () => { draft.actualQtyMilli = material.expectedQtyMilli; delete draft.resolutionIfShort; } },
      { label: "Record none used", act: () => { draft.actualQtyMilli = 0; delete draft.resolutionIfShort; } },
      ...(draft.actualQtyMilli > material.availableMilli ? ([
        ["adjust_up", "Adjust stock up and consume"], ["consume_available", "Consume stock on hand"],
        ["note_discrepancy", "Record discrepancy"],
      ] as const).map(([choice, label]) => ({
        label, active: draft.resolutionIfShort === choice, act: () => { draft.resolutionIfShort = choice; },
      })) : []),
    ] : []);
  }

  private reviewMenu() {
    const task = this.task;
    if (!task) return this.panel("Review completion", []);
    const provider = task.providers.find((item) => item.id === this.providerId);
    const missingStock = task.materials.some((line) => this.drafts.some((draft) => draft.partId === line.partId &&
      draft.actualQtyMilli > line.availableMilli && !draft.resolutionIfShort));
    return this.panel("Review completion", [
      task.title, provider?.name ?? (task.requiresProfessional ? "Choose who performed the work." : "Performed by the signed-in household member"),
      missingStock ? "Review short material lines before confirming." : "",
    ], [
      ...(task.requiresProfessional ? [{ label: "Choose service provider", act: () => this.go("providers") }] : []),
      { label: `Outcome · ${outcomeLabels[this.outcome]}`, act: () => {
        this.outcome = outcomes[(outcomes.indexOf(this.outcome) + 1) % outcomes.length]!;
      } },
      { label: "Review actual material use", act: () => this.go("materials") },
      { label: "Continue to confirmation", act: (!task.requiresProfessional || !!provider) && !missingStock ? () => this.go("confirm") : undefined },
    ]);
  }

  private confirmMenu() {
    const task = this.task;
    if (!task) return this.panel("Confirm maintenance", []);
    return this.panel("Confirm maintenance", [
      task.title, outcomeLabels[this.outcome], "Confirm only if this work happened. This records the date and accounts for the materials below.",
      ...task.materials.map((line) => {
        const draft = this.drafts.find((item) => item.partId === line.partId)!;
        return `${line.partName} · ${formatQty(draft.actualQtyMilli, line.unit)}`;
      }),
    ], [{
      label: "Record completion now", act: () => this.write({
        kind: "complete", occurrenceId: task.id, requestId: this.requestId,
        confirmed: true, providerId: this.providerId, outcome: this.outcome, materials: this.drafts,
      }),
    }]);
  }

  private backToReview() {
    if (this.stack.at(-1) === "review") this.stack.pop();
    this.page = "review";
  }
}
