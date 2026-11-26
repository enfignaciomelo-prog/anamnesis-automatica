import type { Template } from "./types";

/** Plantilla genérica predeterminada (versión 1). */
export const GENERIC_TEMPLATE: Template = {
  id: "generica",
  name: "Anamnesis general",
  version: 1,
  sections: [
    {
      id: "motivo",
      title: "Motivo de consulta",
      fields: [{ id: "motivo", concept: "motivo", label: "Motivo de consulta" }],
    },
    {
      id: "actual",
      title: "Enfermedad actual",
      fields: [{ id: "enfermedad_actual", concept: "enfermedad_actual", label: "Síntomas y evolución" }],
    },
    {
      id: "personales",
      title: "Antecedentes personales",
      fields: [
        { id: "morbidos", concept: "morbidos", label: "Antecedentes mórbidos", negationLabel: "enfermedades crónicas" },
        { id: "quirurgicos", concept: "quirurgicos", label: "Antecedentes quirúrgicos", negationLabel: "cirugías" },
        {
          id: "medicamentos",
          concept: "medicamentos",
          label: "Medicamentos en uso",
          hint: "Nombre, dosis y frecuencia",
          critical: true,
          negationLabel: "uso de medicamentos",
        },
        { id: "alergias", concept: "alergias", label: "Alergias", critical: true, negationLabel: "alergias a medicamentos" },
      ],
    },
    {
      id: "familiares",
      title: "Antecedentes familiares",
      fields: [{ id: "familiares", concept: "familiares", label: "Antecedentes familiares" }],
    },
    {
      id: "habitos",
      title: "Hábitos",
      fields: [
        { id: "tabaco", concept: "tabaco", label: "Tabaco", negationLabel: "consumo de tabaco" },
        { id: "alcohol", concept: "alcohol", label: "Alcohol", negationLabel: "consumo de alcohol" },
        { id: "actividad_fisica", concept: "actividad_fisica", label: "Actividad física" },
      ],
    },
    {
      id: "sistemas",
      title: "Revisión por sistemas",
      fields: [
        { id: "cardiorrespiratorio", concept: "cardiorrespiratorio", label: "Cardiorrespiratorio" },
        { id: "otros_sistemas", concept: "otros_sistemas", label: "Otros sistemas" },
      ],
    },
    {
      id: "gineco",
      title: "Antecedentes gineco-obstétricos",
      fields: [{ id: "gineco", concept: "gineco", label: "Gineco-obstétricos" }],
    },
    {
      id: "observaciones",
      title: "Observaciones del profesional",
      fields: [{ id: "observaciones", label: "Observaciones", manualOnly: true }],
    },
  ],
};

export function allFields(t: Template) {
  return t.sections.flatMap((s) => s.fields);
}
