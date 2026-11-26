/**
 * Combina las propuestas extraídas con las decisiones del profesional.
 * Regla central: el texto del profesional nunca se sobrescribe.
 */
import type { FieldId, FieldState, ProposalItem, ReviewReason, Template } from "../../shared/types";
import { allFields } from "../../shared/template-generic";

export interface ProfessionalFieldState {
  confirmed: boolean;
  value: string | null;
  edited: boolean;
  /** Ítems que el profesional ya tuvo a la vista al confirmar. */
  ackItemIds: string[];
  /** Texto en edición autoguardado (aún no confirmado). */
  draft?: string | null;
}

export function computeFields(
  template: Template,
  items: ProposalItem[],
  prof: Record<FieldId, ProfessionalFieldState | undefined>,
): Record<FieldId, FieldState> {
  const out: Record<FieldId, FieldState> = {};
  for (const f of allFields(template)) {
    const its = items.filter((i) => i.fieldId === f.id);
    const p = prof[f.id];
    const reasons: ReviewReason[] = [...new Set(its.flatMap((i) => i.reasons))];
    const proposedValue = its.length ? its.map((i) => i.value).join("; ") : null;

    let status: FieldState["status"];
    let newItemIds: string[] = [];
    if (p?.confirmed) {
      newItemIds = its.filter((i) => !p.ackItemIds.includes(i.id)).map((i) => i.id);
      if (newItemIds.length) {
        status = "requiere_revision";
        reasons.push("nueva_informacion");
      } else {
        status = "confirmado";
      }
    } else if (its.length === 0) {
      status = "no_referido";
    } else {
      status = reasons.length ? "requiere_revision" : "propuesto";
    }

    out[f.id] = {
      fieldId: f.id,
      status,
      proposedValue,
      professionalValue: p?.confirmed ? p.value : null,
      editedByProfessional: Boolean(p?.edited),
      draftValue: p?.draft ?? null,
      items: its,
      newItemIds,
      reasons: p?.confirmed && !newItemIds.length ? [] : reasons,
    };
  }
  return out;
}

/** Valor que se exporta para un campo. */
export function finalValue(fs: FieldState): string {
  if (fs.professionalValue !== null) return fs.professionalValue;
  if (fs.proposedValue !== null) return fs.proposedValue;
  return "No referido";
}
