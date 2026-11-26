import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Segment, SpeakerRole } from "../../shared/types";
import { GENERIC_TEMPLATE } from "../../shared/template-generic";
import { DEMO_SCRIPT } from "../../server/demo/script";
import { extractDemo } from "../../server/extraction/demoExtractor";
import { computeFields } from "../../server/extraction/merge";

const ROLES: Record<number, SpeakerRole> = { 1: "profesional", 2: "paciente", 3: "acompanante" };

function segs(lines: { speaker: number; text: string }[]): Segment[] {
  return lines.map((l, i) => ({ id: `s${i + 1}`, speaker: l.speaker, text: l.text, start: i * 3, end: i * 3 + 2 }));
}

function run(lines: { speaker: number; text: string }[], roles = ROLES) {
  const s = segs(lines);
  const items = extractDemo(s, roles, GENERIC_TEMPLATE);
  return { s, items, fields: computeFields(GENERIC_TEMPLATE, items, {}) };
}

describe("extractor de demostración", () => {
  const { s, items, fields } = run(DEMO_SCRIPT);

  it("cada propuesta tiene respaldo literal presente en la transcripción", () => {
    assert.ok(items.length > 0);
    for (const it of items) {
      assert.ok(it.evidence.length > 0, it.id);
      for (const e of it.evidence) {
        assert.ok(s.some((seg) => seg.id === e.segmentId && seg.text.includes(e.quote)), `${it.id}: ${e.quote}`);
      }
    }
  });

  it("lo no mencionado queda No referido y no se convierte en negación", () => {
    for (const id of ["actividad_fisica", "gineco", "otros_sistemas", "observaciones"]) {
      assert.equal(fields[id].status, "no_referido", id);
      assert.equal(fields[id].items.length, 0, id);
    }
  });

  it("diferencia antecedentes familiares de los del paciente", () => {
    assert.ok(fields.familiares.items.length >= 2);
    assert.ok(fields.familiares.items.every((i) => i.classification === "familiar"));
    // «Mi mamá era diabética» no aparece en los mórbidos del paciente.
    assert.ok(!fields.morbidos.items.some((i) => i.evidence[0].quote.includes("mamá")));
  });

  it("distingue histórico, actual y negación explícita", () => {
    const cls = fields.tabaco.items.map((i) => i.classification).sort();
    assert.deepEqual(cls, ["historico", "negado"]);
    assert.equal(fields.quirurgicos.items[0].classification, "historico");
    const cardio = fields.cardiorrespiratorio.items;
    assert.ok(cardio.some((i) => i.classification === "negado" && i.value === "Niega dolor torácico"));
    assert.ok(cardio.some((i) => i.classification === "actual" && /me canso/i.test(i.value)));
  });

  it("medicamentos y alergias siempre requieren revisión", () => {
    assert.equal(fields.medicamentos.status, "requiere_revision");
    assert.ok(fields.medicamentos.reasons.includes("critico"));
    assert.ok(fields.medicamentos.reasons.includes("dosis"));
    assert.equal(fields.alergias.status, "requiere_revision");
  });

  it("detecta la contradicción de dosis y la marca como dicha por acompañante", () => {
    assert.ok(fields.medicamentos.reasons.includes("contradiccion"));
    assert.ok(fields.medicamentos.reasons.includes("acompanante"));
  });

  it("negación con duda queda en revisión", () => {
    const a = fields.alergias.items[0];
    assert.equal(a.classification, "negado");
    assert.ok(a.reasons.includes("incertidumbre"));
    assert.equal(a.evidence[0].context?.quote, "¿Es alérgica a algún medicamento?");
  });

  it("detecta la autocorrección y conserva lo descartado", () => {
    const al = fields.alcohol.items[0];
    assert.ok(al.corrected);
    assert.match(al.corrected!.discardedQuote, /copa de vino/);
    assert.match(al.value, /una vez al mes/i);
  });

  it("no inventa diagnósticos: no hay mórbidos que no se hayan dicho", () => {
    const txt = fields.morbidos.items.map((i) => i.value).join(" ").toLowerCase();
    assert.ok(!/infarto|neuropat|insuficiencia/.test(txt));
  });

  it("sin hablantes asignados, todo queda en revisión", () => {
    const r = run(DEMO_SCRIPT, {});
    for (const f of Object.values(r.fields)) {
      if (f.items.length) {
        assert.equal(f.status, "requiere_revision", f.fieldId);
        assert.ok(f.reasons.includes("hablante_sin_asignar"));
      }
    }
  });

  it("negación seguida de afirmación del mismo dato es contradicción", () => {
    const r = run([
      { speaker: 1, text: "¿Es alérgico a algún medicamento?" },
      { speaker: 2, text: "No, a ninguno." },
      { speaker: 2, text: "Ah no, soy alérgico a la penicilina." },
    ]);
    assert.ok(r.fields.alergias.reasons.includes("contradiccion"));
  });

  it("las preguntas del profesional nunca generan datos", () => {
    const r = run([{ speaker: 1, text: "¿Toma metformina o es alérgico a algo?" }]);
    assert.equal(r.items.length, 0);
  });

  describe("casos pedidos por el profesional", () => {
    const r = run([
      { speaker: 1, text: "¿Hay enfermedades en su familia?" },
      { speaker: 2, text: "Mi mamá tiene diabetes, yo no." },
      { speaker: 1, text: "¿Qué medicamentos toma?" },
      { speaker: 2, text: "Antes tomaba losartán." },
      { speaker: 2, text: "Ahora tomo metformina, creo que son 500 mg." },
      { speaker: 1, text: "¿Alergias?" },
      { speaker: 2, text: "Creo que soy alérgica a la penicilina." },
    ]);

    it("«Mi mamá tiene diabetes, yo no»: familiar y negación del paciente", () => {
      assert.equal(r.fields.familiares.items[0].classification, "familiar");
      assert.match(r.fields.familiares.items[0].value, /Mi mamá tiene diabetes/);
      const m = r.fields.morbidos.items;
      assert.equal(m.length, 1);
      assert.equal(m[0].classification, "negado");
      assert.match(m[0].value, /^Niega diabetes/);
    });

    it("«Antes tomaba losartán»: histórico, no tratamiento actual", () => {
      const los = r.fields.medicamentos.items.find((i) => /losart/i.test(i.value))!;
      assert.equal(los.classification, "historico");
      const met = r.fields.medicamentos.items.find((i) => /metformina/i.test(i.value))!;
      assert.equal(met.classification, "actual");
    });

    it("dosis y alergia dudosas quedan para revisión", () => {
      assert.equal(r.fields.medicamentos.status, "requiere_revision");
      assert.ok(r.fields.medicamentos.reasons.includes("incertidumbre"));
      assert.ok(r.fields.medicamentos.reasons.includes("dosis"));
      assert.equal(r.fields.alergias.status, "requiere_revision");
      assert.ok(r.fields.alergias.reasons.includes("incertidumbre"));
    });

    it("lo no mencionado queda No referido", () => {
      for (const id of ["tabaco", "alcohol", "quirurgicos", "cardiorrespiratorio", "gineco"])
        assert.equal(r.fields[id].status, "no_referido", id);
    });
  });
});
