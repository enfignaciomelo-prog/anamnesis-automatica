export function PrivacyScreen({ onBack }: { onBack: () => void }) {
  return (
    <main className="privacy">
      <button className="link back" onClick={onBack}>
        Volver
      </button>
      <h1>Qué datos se usan y dónde</h1>
      <p className="lede">
        En esta etapa la aplicación funciona en modo demostración: no activa el micrófono y la
        entrevista es ficticia.
      </p>

      <h2>Por proveedor</h2>
      <table className="providers">
        <thead>
          <tr>
            <th scope="col">Servicio</th>
            <th scope="col">Qué recibiría</th>
            <th scope="col">Estado</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Servidor de la aplicación</th>
            <td>Transcripción, borrador y decisiones del profesional, en memoria.</td>
            <td>Activo (demo)</td>
          </tr>
          <tr>
            <th scope="row">Deepgram (transcripción)</th>
            <td>El audio de la entrevista, en tiempo real, para convertirlo en texto.</td>
            <td>Pendiente (etapa 3). Hoy no recibe nada.</td>
          </tr>
          <tr>
            <th scope="row">Claude de Anthropic (extracción)</th>
            <td>El texto transcrito y los campos de la plantilla, para proponer el llenado.</td>
            <td>Pendiente (etapa 4). Hoy no recibe nada.</td>
          </tr>
          <tr>
            <th scope="row">Base de datos PostgreSQL</th>
            <td>Cuentas, plantillas y entrevistas cifradas en reposo.</td>
            <td>Pendiente (etapa 5).</td>
          </tr>
        </tbody>
      </table>

      <h2>Compromisos</h2>
      <ul className="plain">
        <li>El audio no se guarda.</li>
        <li>El navegador no guarda datos clínicos: al cerrar la página, solo quedan en el servidor.</li>
        <li>El modo sin conexión guarda únicamente la estructura de la aplicación, nunca entrevistas.</li>
        <li>Cada profesional ve solo sus entrevistas; el servidor lo verifica en cada solicitud.</li>
        <li>Los registros técnicos no contienen texto clínico.</li>
        <li>Las entrevistas se eliminan según el plazo de retención que elijas, o cuando las borras.</li>
        <li>Las claves de los proveedores viven solo en el servidor.</li>
      </ul>
      <p className="muted">
        Antes de usar datos reales, valida este tratamiento con tu establecimiento (Ley 20.584 y
        normativa de protección de datos personales).
      </p>
    </main>
  );
}
