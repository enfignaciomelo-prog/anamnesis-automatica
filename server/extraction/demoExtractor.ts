/**
 * Extractor SIMULADO del modo demostración.
 *
 * No es IA: aplica reglas deterministas y léxicos pequeños sobre los segmentos
 * definitivos. Sirve para demostrar el flujo y las reglas clínicas mientras la
 * extracción con Claude (etapa 4) está pendiente. Nunca inventa: cada propuesta
 * contiene el fragmento literal que la respalda.
 */
import type {
  Classification,
  Evidence,
  ProposalItem,
  ReviewReason,
  Segment,
  SpeakerRole,
  Template,
} from "../../shared/types";
import { conceptInfo } from "../../shared/concepts";
import { allFields } from "../../shared/template-generic";

export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

interface LexEntry {
  /** Tipo de dato (concepto), no el id del campo de la plantilla. */
  field: string;
  re: RegExp;
  /** Etiqueta para negaciones explícitas, si difiere de la del campo. */
  neg?: string;
  /** Clave para comparar versiones (contradicciones). */
  key?: string | ((t: string) => string | undefined);
  /** Coincidencia genérica: se descarta si hay otra más específica. */
  weak?: boolean;
}

const DRUGS =
  "metformina|losartan|enalapril|insulina|atorvastatina|aspirina|acido acetilsalicilico|omeprazol|glibenclamida|levotiroxina|paracetamol|ibuprofeno|amlodipino|hidroclorotiazida|salbutamol";
const DRUG_RE = new RegExp(`\\b(${DRUGS})\\b`);

// El orden importa solo para la presentación; un fragmento puede ir a varios campos.
const LEXICON: LexEntry[] = [
  { field: "medicamentos", re: DRUG_RE, key: (t) => t.match(DRUG_RE)?.[1] },
  { field: "medicamentos", re: /\b(medicament|remedio|pastilla)/, weak: true },
  { field: "alergias", re: /\balergi|\balergic/ },
  { field: "quirurgicos", re: /\b(operaron|opere|cirugia|me sacaron)\b/ },
  {
    field: "morbidos",
    re: /\b(diabet\w*|presion alta|hipertens\w*|asma|epoc|colesterol|tiroides|insuficiencia renal|enfermedad diagnosticada|enfermedad cronica)/,
  },
  { field: "tabaco", re: /\b(fum\w*|cigarr\w*|tabaco)\b/ },
  { field: "alcohol", re: /\b(alcohol|vino|cerveza|copete|trago|copa)\b/ },
  { field: "actividad_fisica", re: /\b(ejercicio|deporte|actividad fisica|camino todos)\b/ },
  { field: "cardiorrespiratorio", re: /\b(pecho|torac\w*)/, neg: "dolor torácico", key: "dolor_toracico" },
  {
    field: "cardiorrespiratorio",
    re: /\b(falta de aire|ahog\w*|disnea|me canso al (subir|caminar))/,
    neg: "disnea",
    key: "disnea",
  },
  { field: "cardiorrespiratorio", re: /\bpalpitac/, neg: "palpitaciones", key: "palpitaciones" },
  {
    field: "enfermedad_actual",
    re: /\b(mucha sed|orino|orinar|se me duerm\w* los pies|hormigue\w*|vision borrosa|baje de peso|fiebre|mareo\w*)/,
  },
  { field: "gineco", re: /\b(menstrua\w*|regla|embaraz\w*|parto|menopaus\w*|anticoncept\w*)/ },
  { field: "familiares", re: /\b(familia|familiares)\b/, neg: "antecedentes familiares" },
];

const MOTIVO_Q = /\b(motivo|que le trae|por que viene|en que le puedo ayudar)\b/;
const FAMILY_RE =
  /\b(mi|su|la|el)\s+(mama|madre|papa|padre|herman[oa]s?|abuel[oa]s?|ti[oa]s?|hij[oa]s?|primo|prima)\b|\ben (mi|la) familia\b/;
const UNCERTAIN_RE = /\b(que yo sepa|creo que|no se|no me acuerdo|no recuerdo|parece que|mas o menos)\b/;
const NEGATION_RE = /(^|[\s,])(no|nunca|niega|ninguno|ninguna|nada|tampoco|jamas|nadie)([\s,.]|$)/;
const HISTORIC_RE =
  /\b(fume|tuve|tenia|me operaron|me opere|estuve|use|tomaba|hasta los \w+|de joven|antes)\b/;
const CORRECTION_RE =
  /(?:^ah no\b|\b(?:perdon|mejor dicho|en realidad|me equivoque)\b)(?:[\s,]*\b(?:perdon|mejor dicho|en realidad|me equivoque|digo)\b)*[\s,]*/;
const LEADING_FILLER = /^(s[ií]|ah|bueno|mire|eh|y)(?=[\s,]|$)[\s,]*/i;

const DOSE_RE = /\b\d+(?:[.,]\d+)?\s*(mg|miligramos|g|ui|unidades)?\b/g;
const FREQ_RE =
  /\b((una|dos|tres|cuatro|\d+)\s+veces?\s+al\s+dia|cada\s+\d+\s+horas|en la (manana|noche|tarde))\b/g;

/** Divide un segmento en cláusulas conservando el texto original. */
export function splitClauses(text: string): string[] {
  return text
    .split(/(?<=[.;!?])\s+|,\s*pero\s+|\s+pero\s+|,\s*(?=ahora\b|actualmente\b|yo\b)|,\s*y\s+|\s+y\s+(?=mi\s|su\s)/i)
    .map((c) => c.trim().replace(/[.;]+$/, ""))
    .filter((c) => c.length > 0);
}

function cleanQuote(c: string): string {
  let out = c.trim();
  for (let i = 0; i < 2; i++) out = out.replace(LEADING_FILLER, "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function wordCount(s: string) {
  return s.split(/\s+/).filter(Boolean).length;
}

function roleOf(roles: Record<number, SpeakerRole>, speaker: number): SpeakerRole {
  return roles[speaker] ?? "sin_asignar";
}

function prefix(role: SpeakerRole) {
  return role === "acompanante" ? "Acompañante refiere" : "Refiere";
}

export function extractDemo(
  segments: Segment[],
  roles: Record<number, SpeakerRole>,
  template: Template,
): ProposalItem[] {
  // Concepto → primer campo de la plantilla que lo usa.
  const byConcept = new Map<string, ReturnType<typeof allFields>[number]>();
  for (const f of allFields(template))
    if (f.concept && !f.manualOnly && !byConcept.has(f.concept)) byConcept.set(f.concept, f);
  const fieldIds = new Set(byConcept.keys());
  const items: ProposalItem[] = [];

  segments.forEach((original, idx) => {
    let seg = original;
    const role = roleOf(roles, seg.speaker);
    seg = { ...seg, text: seg.text.normalize("NFC") };
    const isQuestion = seg.text.trim().endsWith("?");
    if (role === "profesional" || isQuestion) return; // las preguntas no son afirmaciones

    // Pregunta previa (de otro hablante) como contexto de respuestas breves.
    let context: Segment | undefined;
    for (let j = idx - 1; j >= Math.max(0, idx - 3); j--) {
      const prev = segments[j];
      if (prev.speaker !== seg.speaker && prev.text.trim().endsWith("?")) {
        context = prev;
        break;
      }
    }

    const baseReasons: ReviewReason[] = [];
    if (role === "sin_asignar") baseReasons.push("hablante_sin_asignar");
    if (role === "acompanante") baseReasons.push("acompanante");

    // Motivo de consulta: respuesta completa a la pregunta por el motivo.
    if (context && MOTIVO_Q.test(norm(context.text)) && fieldIds.has("motivo")) {
      const motivoField = byConcept.get("motivo")!;
      items.push({
        id: `${seg.id}:m:${motivoField.id}`,
        fieldId: motivoField.id,
        value: `${prefix(role)} «${cleanQuote(seg.text.replace(/[.]$/, ""))}»`,
        classification: "actual",
        evidence: [ev(seg, seg.text, context)],
        reasons: [...baseReasons],
      });
    }

    // Término clínico del último antecedente familiar («Mi mamá tiene diabetes, yo no»).
    let familyTerm: { concept: string; term: string } | null = null;
    splitClauses(seg.text).forEach((rawClause, ci) => {
      let clause = rawClause;
      let corrected: ProposalItem["corrected"];
      const nClause0 = norm(clause);
      const corr = CORRECTION_RE.exec(nClause0);
      if (corr) {
        // Conserva lo que sigue a la autocorrección; registra lo descartado.
        const cut = corr.index + corr[0].length;
        corrected = { discardedQuote: clause.slice(0, corr.index).replace(/[,\s]+$/, "") };
        clause = clause.slice(cut);
      }
      const n = norm(clause);
      const family = FAMILY_RE.test(n);

      // Negación elíptica del paciente tras un antecedente familiar: «…, yo no».
      if (/^yo no\b/.test(n) && familyTerm && fieldIds.has(familyTerm.concept)) {
        const def = byConcept.get(familyTerm.concept)!;
        items.push({
          id: `${seg.id}:${ci}:${def.id}`,
          fieldId: def.id,
          value: `Niega ${familyTerm.term} (lo refiere en un familiar, no en sí mismo/a)`,
          classification: "negado",
          evidence: [ev(seg, seg.text)],
          reasons: [...baseReasons],
        });
        familyTerm = null;
        return;
      }
      if (family) {
        const hit = LEXICON.find((e) => e.field === "morbidos" && e.re.test(n));
        const term = hit ? n.match(hit.re)?.[0] : undefined;
        familyTerm = hit && term ? { concept: "morbidos", term } : null;
      }

      // Vocativos o muletillas sueltas («Mamá», «Ah») no son información.
      if (wordCount(clause) <= 1 && !/^(si|no)$/.test(n.replace(/[^a-z]/g, ""))) return;
      let matches = LEXICON.filter((e) => fieldIds.has(e.field) && e.re.test(n));
      let viaContext = false;
      const short = wordCount(clause) <= 10 || /^(si|no)\b/.test(n);
      if (matches.length === 0 && context && short && ci === 0) {
        const nq = norm(context.text);
        matches = LEXICON.filter((e) => fieldIds.has(e.field) && e.re.test(nq));
        viaContext = matches.length > 0;
      }
      if (matches.some((m) => !m.weak)) matches = matches.filter((m) => !m.weak);
      if (family && fieldIds.has("familiares")) {
        // Un antecedente familiar nunca se atribuye al paciente.
        matches = [{ field: "familiares", re: FAMILY_RE }];
      }
      if (matches.length === 0) return;

      const uncertain = UNCERTAIN_RE.test(n);
      const negated = !uncertain
        ? NEGATION_RE.test(n)
        : NEGATION_RE.test(n.replace(UNCERTAIN_RE, ""));
      const classification: Classification = family
        ? "familiar"
        : negated
          ? "negado"
          : HISTORIC_RE.test(n)
            ? "historico"
            : "actual";

      const seen = new Set<string>();
      for (const m of matches) {
        if (seen.has(m.field)) continue;
        seen.add(m.field);
        const def = byConcept.get(m.field)!;
        const info = conceptInfo(m.field);
        const reasons: ReviewReason[] = [...baseReasons];
        if (uncertain) reasons.push("incertidumbre");
        if (def.critical || info?.critical) reasons.push("critico");
        if (m.field === "medicamentos" && (n.match(DOSE_RE) || n.match(FREQ_RE))) reasons.push("dosis");

        let value: string;
        if (classification === "negado") {
          value = `Niega ${m.neg ?? def.negationLabel ?? info?.negationLabel ?? def.label.toLowerCase()}`;
        } else if (viaContext) {
          value = `Responde «${cleanQuote(clause)}» a «${context!.text.trim()}»`;
        } else {
          value = `${prefix(role)} «${cleanQuote(clause)}»`;
        }
        const key = typeof m.key === "function" ? m.key(n) : m.key;
        items.push({
          id: `${seg.id}:${ci}:${def.id}`,
          fieldId: def.id,
          value,
          classification,
          evidence: [ev(seg, rawClause, viaContext || negated ? context : undefined)],
          reasons: unique(reasons),
          corrected,
          key,
        });
      }
    });
  });

  markContradictions(items);
  return items;
}

function ev(seg: Segment, quote: string, context?: Segment): Evidence {
  return {
    segmentId: seg.id,
    quote: quote.trim(),
    start: seg.start,
    context: context ? { segmentId: context.id, quote: context.text.trim() } : undefined,
  };
}

function unique<T>(a: T[]): T[] {
  return [...new Set(a)];
}

function tokens(s: string, re: RegExp): string {
  return [...norm(s).matchAll(re)].map((m) => m[0].trim()).sort().join("|");
}

/** Marca versiones distintas del mismo dato dentro de un campo. */
export function markContradictions(items: ProposalItem[]) {
  const byField = new Map<string, ProposalItem[]>();
  for (const it of items) {
    if (it.classification === "familiar") continue;
    const k = `${it.fieldId}::${it.key ?? ""}`;
    byField.set(k, [...(byField.get(k) ?? []), it]);
  }
  for (const group of byField.values()) {
    if (group.length < 2) continue;
    const flag = (a: ProposalItem, b: ProposalItem) => {
      for (const x of [a, b]) if (!x.reasons.includes("contradiccion")) x.reasons.push("contradiccion");
    };
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.classification === "historico" || b.classification === "historico") continue;
        // Afirmación frente a negación explícita del mismo dato.
        if ((a.classification === "negado") !== (b.classification === "negado")) {
          flag(a, b);
          continue;
        }
        // Medicamentos: misma droga con dosis o frecuencia distintas.
        if (a.reasons.includes("critico") && a.key) {
          const qa = a.evidence[0].quote;
          const qb = b.evidence[0].quote;
          const fa = tokens(qa, FREQ_RE);
          const fb = tokens(qb, FREQ_RE);
          const da = tokens(qa, DOSE_RE);
          const db = tokens(qb, DOSE_RE);
          if ((fa && fb && fa !== fb) || (da && db && da !== db)) flag(a, b);
        }
      }
    }
  }
}
