/**
 * Tipos de dato clínico que el extractor sabe reconocer. Cada campo de una
 * plantilla (predeterminada o propia) puede asociarse a uno; los campos sin
 * tipo se llenan a mano (y con Claude en la etapa 4).
 */
export const CONCEPTS = [
  { id: "motivo", label: "Motivo de consulta" },
  { id: "enfermedad_actual", label: "Enfermedad actual / síntomas" },
  { id: "morbidos", label: "Antecedentes mórbidos", negationLabel: "enfermedades crónicas" },
  { id: "quirurgicos", label: "Antecedentes quirúrgicos", negationLabel: "cirugías" },
  { id: "medicamentos", label: "Medicamentos", critical: true, negationLabel: "uso de medicamentos" },
  { id: "alergias", label: "Alergias", critical: true, negationLabel: "alergias a medicamentos" },
  { id: "familiares", label: "Antecedentes familiares", negationLabel: "antecedentes familiares" },
  { id: "tabaco", label: "Tabaco", negationLabel: "consumo de tabaco" },
  { id: "alcohol", label: "Alcohol", negationLabel: "consumo de alcohol" },
  { id: "actividad_fisica", label: "Actividad física" },
  { id: "cardiorrespiratorio", label: "Cardiorrespiratorio" },
  { id: "otros_sistemas", label: "Otros sistemas" },
  { id: "gineco", label: "Gineco-obstétricos" },
] as const;

export type ConceptId = (typeof CONCEPTS)[number]["id"];

export const CONCEPT_IDS = CONCEPTS.map((c) => c.id) as ConceptId[];

export function conceptInfo(id: string | undefined) {
  return CONCEPTS.find((c) => c.id === id) as
    | { id: ConceptId; label: string; critical?: boolean; negationLabel?: string }
    | undefined;
}

function norm(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// El orden importa: «antecedentes mórbidos familiares» es familiar.
const SUGGEST: [ConceptId, RegExp][] = [
  ["familiares", /familiar/],
  ["alergias", /alergi|\bram\b/],
  ["medicamentos", /medicament|farmaco|tratamiento (actual|habitual)|remedio/],
  ["motivo", /motivo|razon de (la )?consulta|consulta por/],
  ["enfermedad_actual", /enfermedad actual|anamnesis proxima|historia actual|sintoma/],
  ["quirurgicos", /quirurg|cirug|operacion/],
  ["gineco", /gineco|obstetric|menstrua|embaraz|\bfur\b/],
  ["tabaco", /tabac|tabaq|fuma|cigarr/],
  ["alcohol", /alcohol|\boh\b/],
  ["actividad_fisica", /actividad fisica|ejercicio|sedentar/],
  ["cardiorrespiratorio", /cardio|respirat|toracic|disnea/],
  ["otros_sistemas", /revision por sistemas|otros sistemas/],
  ["morbidos", /morbid|antecedentes (personales|medicos)|enfermedades cronicas|patologia|comorbil/],
];

/** Sugiere un tipo de dato a partir de la etiqueta del campo. */
export function suggestConcept(label: string): ConceptId | undefined {
  const n = norm(label);
  return SUGGEST.find(([, re]) => re.test(n))?.[0];
}
