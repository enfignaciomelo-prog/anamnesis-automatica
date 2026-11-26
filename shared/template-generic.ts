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
      fields: [{ id: "motivo", label: "Motivo de consulta" }],
    },
    {
      id: "actual",
      title: "Enfermedad actual",
      fields: [{ id: "enfermedad_actual", label: "Síntomas y evolución" }],
    },
    {
      id: "personales",
      title: "Antecedentes personales",
      fields: [
        { id: "morbidos", label: "Antecedentes mórbidos", negationLabel: "enfermedades crónicas" },
        { id: "quirurgicos", label: "Antecedentes quirúrgicos", negationLabel: "cirugías" },
        {
          id: "medicamentos",
          label: "Medicamentos en uso",
          hint: "Nombre, dosis y frecuencia",
          critical: true,
          negationLabel: "uso de medicamentos",
        },
        { id: "alergias", label: "Alergias", critical: true, negationLabel: "alergias a medicamentos" },
      ],
    },
    {
      id: "familiares",
      title: "Antecedentes familiares",
      fields: [{ id: "familiares", label: "Antecedentes familiares" }],
    },
    {
      id: "habitos",
      title: "Hábitos",
      fields: [
        { id: "tabaco", label: "Tabaco", negationLabel: "consumo de tabaco" },
        { id: "alcohol", label: "Alcohol", negationLabel: "consumo de alcohol" },
        { id: "actividad_fisica", label: "Actividad física" },
      ],
    },
    {
      id: "sistemas",
      title: "Revisión por sistemas",
      fields: [
        { id: "cardiorrespiratorio", label: "Cardiorrespiratorio" },
        { id: "otros_sistemas", label: "Otros sistemas" },
      ],
    },
    {
      id: "gineco",
      title: "Antecedentes gineco-obstétricos",
      fields: [{ id: "gineco", label: "Gineco-obstétricos" }],
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
