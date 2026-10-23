"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/ui";
import { EquipmentForm, type EquipmentFormInitial, type Option } from "./EquipmentForm";

type FormProps = {
  initial: EquipmentFormInitial;
  locations: readonly Option[];
  parents: readonly Option[];
  parts: readonly Option[];
  systems: readonly Option[];
};
type EditMode = { editing: boolean; setEditing: (editing: boolean) => void };
const EditModeContext = createContext<EditMode | null>(null);

export function EquipmentEditMode({
  initialEditing,
  children,
}: {
  initialEditing: boolean;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(initialEditing);
  return <EditModeContext.Provider value={{ editing, setEditing }}>{children}</EditModeContext.Provider>;
}

export function EquipmentEditButton() {
  const { editing, setEditing } = useEditMode();
  if (editing) return null;
  return (
    <Button variant="secondary" onClick={() => setEditing(true)}>
      <Pencil aria-hidden="true" className="size-4" />
      Edit details
    </Button>
  );
}

export function EquipmentEditContent({
  form,
  children,
}: {
  form: FormProps;
  children: ReactNode;
}) {
  const { editing, setEditing } = useEditMode();
  return editing ? (
    <EquipmentForm {...form} onDiscard={() => setEditing(false)} onSaved={() => setEditing(false)} />
  ) : children;
}

function useEditMode() {
  const value = useContext(EditModeContext);
  if (!value) throw new Error("Equipment edit controls must be inside EquipmentEditMode");
  return value;
}
