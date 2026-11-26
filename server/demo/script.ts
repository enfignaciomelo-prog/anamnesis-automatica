/**
 * Entrevista FICTICIA para el modo demostración. No corresponde a ninguna
 * persona real. Los números de hablante imitan la diarización de un proveedor:
 * no dicen quién es quién; eso lo indica el profesional.
 */
export interface ScriptLine {
  speaker: number;
  text: string;
}

export const DEMO_SCRIPT: ScriptLine[] = [
  { speaker: 1, text: "Buenos días, ¿cuál es el motivo de su consulta hoy?" },
  { speaker: 2, text: "Vengo porque ando con mucha sed y orino harto, hace como tres semanas." },
  { speaker: 1, text: "¿Tiene alguna enfermedad diagnosticada?" },
  { speaker: 2, text: "Sí, tengo diabetes hace ocho años y presión alta." },
  { speaker: 1, text: "¿Qué medicamentos toma?" },
  { speaker: 2, text: "Metformina de 850, dos veces al día, y losartán 50 en la mañana." },
  { speaker: 3, text: "Mamá, pero el doctor le subió la metformina a tres veces al día." },
  { speaker: 1, text: "¿Es alérgica a algún medicamento?" },
  { speaker: 2, text: "No, a ninguno que yo sepa." },
  { speaker: 1, text: "¿Ha tenido alguna cirugía?" },
  { speaker: 2, text: "Me operaron de la vesícula hace como quince años." },
  { speaker: 1, text: "¿Hay enfermedades en su familia?" },
  { speaker: 2, text: "Mi mamá era diabética y mi papá murió de un infarto." },
  { speaker: 1, text: "¿Fuma?" },
  { speaker: 2, text: "Fumé hasta los cuarenta, ahora no fumo." },
  { speaker: 1, text: "¿Y alcohol?" },
  { speaker: 2, text: "Una copa de vino los fines de semana, perdón, mejor dicho una vez al mes." },
  { speaker: 1, text: "¿Ha tenido dolor en el pecho o falta de aire?" },
  { speaker: 2, text: "Dolor en el pecho no, pero me canso al subir escaleras." },
  { speaker: 2, text: "Ah, y se me duermen los pies en la noche." },
];
