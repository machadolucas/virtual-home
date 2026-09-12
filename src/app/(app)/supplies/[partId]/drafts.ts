// Serializable form defaults shared by server pages and client editors.
export interface LotDraft {
  lotId?: string;
  label: string;
  storagePlaceId: string;
  purchasedOn: string;
  expiresOn: string;
  openedOn: string;
  initialQty: string;
  isOpen: boolean;
  notes: string;
}

export function emptyLot(): LotDraft {
  return {
    label: "",
    storagePlaceId: "",
    purchasedOn: "",
    expiresOn: "",
    openedOn: "",
    initialQty: "",
    isOpen: false,
    notes: "",
  };
}

export interface SupplierDraft {
  supplierId?: string;
  supplierName: string;
  supplierSku: string;
  url: string;
  lastPrice: string;
  currency: string;
  packQty: string;
  leadTimeDays: string;
  isPreferred: boolean;
  note: string;
}

export function emptySupplier(): SupplierDraft {
  return {
    supplierName: "",
    supplierSku: "",
    url: "",
    lastPrice: "",
    currency: "EUR",
    packQty: "",
    leadTimeDays: "",
    isPreferred: false,
    note: "",
  };
}
