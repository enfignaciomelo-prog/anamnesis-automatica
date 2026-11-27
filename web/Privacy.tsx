export function PrivacyScreen({ onBack }: { onBack: () => void }) {
  return (
    <main className="privacy">
      <button className="link back" onClick={onBack}>
        Volver
      </button>
      <h1>Qué datos se usan y dónde</h1>
      <p className="lede">
        La demostración reproduce entrevistas ficticias. En modo cuentas, si se habilita la
        transcripción en vivo, la aplicación pide consentimiento antes de activar el micrófono.
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
            <td>Transcripción, borrador y decisiones del profesional. En modo cuentas se guardan en PostgreSQL.</td>
            <td>Activo</td>
          </tr>
          <tr>
            <th scope="row">Deepgram (transcripción)</th>
            <td>El audio de la entrevista, en tiempo real, para convertirlo en texto.</td>
            <td>Disponible en modo cuentas cuando se habilita la transcripción en vivo.</td>
          </tr>
          <tr>
            <th scope="row">Claude de Anthropic (llenado asistido)</th>
            <td>
              El texto transcrito (con el rol de cada hablante) y los campos de la plantilla, para proponer el llenado. Nunca
              el audio ni tu identidad.
            </td>
            <td>
              Solo en modo cuentas, si el servidor lo activa (CLAUDE_FILL=true) y tú lo pides con «Completar con Claude». En la
              demostración no recibe nada.
            </td>
          </tr>
          <tr>
            <th scope="row">Supabase (PostgreSQL, São Paulo)</th>
            <td>Cuentas, plantillas, archivos de plantillas y anamnesis guardadas, asociadas a su propietario.</td>
            <td>Disponible en modo cuentas (versión de pruebas, datos ficticios).</td>
          </tr>
          <tr>
            <th scope="row">Resend (correo)</th>
            <td>Tu correo y los enlaces de verificación o restablecimiento de contraseña. Nunca datos clínicos.</td>
            <td>Disponible en modo cuentas.</td>
          </tr>
        </tbody>
      </table>

      <h2>Compromisos</h2>
      <ul className="plain">
        <li>La aplicación envía el audio a Deepgram y no guarda grabaciones. Solicita excluir ese audio del programa de mejora de modelos del proveedor.</li>
        <li>
          El navegador no guarda datos clínicos: se mantienen en memoria solo mientras usas la app. Única excepción: si
          preparas el dispositivo para trabajar sin conexión, los borradores que escribas se guardan cifrados con tu frase
          de desbloqueo y se sincronizan con tu cuenta al volver la conexión. Los borradores guardados solo en este
          dispositivo se eliminan en el corte diario, aunque no se hayan sincronizado.
        </li>
        <li>
          A las 23:59 (hora de Chile) vence la sesión y se limpian los datos temporales del dispositivo si la app está
          activa, o al volver a abrirla. No se puede garantizar un borrado puntual con la app cerrada. Las anamnesis
          guardadas permanecen en tu cuenta. Los documentos descargados debes eliminarlos tú.
        </li>
        <li>La caché sin conexión guarda únicamente la estructura de la aplicación, nunca entrevistas.</li>
        <li>Cada profesional ve solo sus entrevistas; el servidor lo verifica en cada solicitud.</li>
        <li>Los registros técnicos no contienen texto clínico.</li>
        <li>
          Las anamnesis guardadas en tu cuenta no se eliminan automáticamente, salvo que actives y confirmes la eliminación
          del historial; también puedes borrarlas tú.
        </li>
        <li>Las claves de los proveedores viven solo en el servidor.</li>
      </ul>
      <p className="muted">
        Antes de usar datos reales, valida este tratamiento con tu establecimiento (Ley 20.584 y
        normativa de protección de datos personales).
      </p>
    </main>
  );
}
