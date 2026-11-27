# Voz e IA sin conexión: evaluación de factibilidad

Estado: **solo evaluación**. No hay nada implementado. Decisión del responsable: capacidad posterior por evaluar.
Fecha: 27-11-2026.

## Resumen

| Opción | ¿Funciona sin internet en iPhone (Safari)? | Recomendación |
|---|---|---|
| Dictado del navegador (Web Speech API de Safari) | No garantizado | Descartar para datos clínicos |
| Whisper en el navegador (Transformers.js + WebGPU) | Técnicamente posible desde iOS 26 | Piloto de medición con audio ficticio antes de decidir |
| IA de llenado en el dispositivo (modelo de lenguaje local) | No razonable en un teléfono hoy | No recomendado |
| Extractor de reglas actual ejecutado en el dispositivo | Sí | Posible, pero es de demostración: no reemplaza a Claude |

**Recomendación:** mantener el modo sin conexión **manual** (implementado en la etapa 3) y, si se quiere avanzar,
hacer un piloto acotado de Whisper en el navegador con audio ficticio para medir calidad en español, velocidad,
batería y temperatura en los iPhone reales del CESFAM.

## 1. Dictado del navegador (Web Speech API)

- Safari expone `webkitSpeechRecognition`, pero según pruebas publicadas en agosto de 2026 sigue usando el
  reconocedor antiguo de Apple: pide permiso para **enviar los datos a Apple** y **no funciona sin conexión**.
  Fuente: [addpipe, «A Quick Look at Apple's SpeechAnalyzer API»](https://blog.addpipe.com/apple-speechanalyzer-api/).
- La opción estándar para exigir reconocimiento local (`processLocally`) **no está disponible en Safari de iOS**
  (hasta 27.0, según [caniuse](https://caniuse.com/mdn-api_speechrecognition_processlocally)).
- Conclusión: no sirve para trabajar sin conexión, y enviaría audio a un tercero no incluido en la tabla de
  proveedores. Descartado.

## 2. Whisper en el navegador

- Safari de iOS 26 incorporó WebGPU, lo que permite ejecutar modelos como Whisper en el teléfono con
  bibliotecas como Transformers.js ([resumen](https://appdevelopermagazine.com/webgpu-in-ios-26/)).
- Puntos a medir antes de decidir (no verificados todavía en iPhone):
  - **Descarga del modelo:** de decenas a cientos de MB; se guarda en el navegador (no contiene datos clínicos).
  - **Calidad en español clínico:** los modelos pequeños cometen más errores; el modelo útil puede ser demasiado
    pesado para el teléfono.
  - **Tiempo real:** latencia, batería y temperatura durante 15–30 minutos de entrevista.
  - **Separación de hablantes:** no hay una solución madura de diarización en el navegador; las reglas clínicas
    dependen de saber quién habla (paciente, acompañante, profesional).
  - **Memoria de Safari:** iOS puede cerrar la pestaña si usa demasiada memoria; la escucha no funciona en
    segundo plano.
- Regla que se mantiene: el audio no se guarda; solo la transcripción, cifrada, igual que los borradores manuales.

## 3. IA de llenado en el dispositivo

- Un modelo de lenguaje que cabe en un teléfono no ofrece la confiabilidad necesaria para clasificar negaciones,
  antecedentes familiares y contradicciones con respaldo literal. No recomendado.
- Alternativa realista: transcribir sin conexión (si el piloto de Whisper resulta) y **llenar con Claude al
  sincronizar**, siempre con revisión humana.

## Piloto propuesto (si el responsable lo aprueba)

1. Página de prueba aislada, solo con audio ficticio leído por el equipo.
2. Modelos Whisper de distintos tamaños; medir errores por palabra en español, tiempo por minuto de audio,
   batería y temperatura en 2–3 modelos de iPhone del CESFAM.
3. Informe con resultados y una recomendación de seguir o no.
