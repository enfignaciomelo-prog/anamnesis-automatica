/**
 * Cifrado local con Web Crypto (sin criptografía propia):
 * - Frase de desbloqueo → PBKDF2-SHA-256 (600.000 iteraciones, sal aleatoria) → clave que envuelve.
 * - Clave de datos AES-GCM de 256 bits, aleatoria, guardada solo envuelta
 *   (AES-GCM). Una vez abierta, no es exportable y vive solo en memoria.
 * - Cada registro se cifra con AES-GCM, IV aleatorio de 12 bytes y datos
 *   asociados (espacio + identificador) para impedir que se intercambien registros.
 * La frase NO es la contraseña de la cuenta y nunca se guarda.
 */

export const PBKDF2_ITERATIONS = 600_000;

export interface WrappedKey {
  salt: Uint8Array;
  iterations: number;
  iv: Uint8Array;
  wrapped: Uint8Array;
}

export interface Sealed {
  iv: Uint8Array;
  data: Uint8Array;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("La frase de desbloqueo no es correcta.");
    this.name = "WrongPassphraseError";
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
/** Copia en un ArrayBuffer propio (tipos estrictos de Web Crypto). */
const buf = (u: Uint8Array) => new Uint8Array(u).buffer as ArrayBuffer;

async function kekFrom(passphrase: string, salt: Uint8Array, iterations: number) {
  const base = await subtle().importKey("raw", enc.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/** Crea una clave de datos nueva y la devuelve abierta y envuelta con la frase. */
export async function createKey(passphrase: string, iterations = PBKDF2_ITERATIONS) {
  const salt = random(16);
  const iv = random(12);
  const extractable = await subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const kek = await kekFrom(passphrase, salt, iterations);
  const wrapped = new Uint8Array(await subtle().wrapKey("raw", extractable, kek, { name: "AES-GCM", iv: buf(iv) }));
  // La clave en uso no es exportable.
  const key = await unwrap(passphrase, { salt, iterations, iv, wrapped });
  return { key, wrapped: { salt, iterations, iv, wrapped } satisfies WrappedKey };
}

export async function unwrap(passphrase: string, w: WrappedKey): Promise<CryptoKey> {
  const kek = await kekFrom(passphrase, w.salt, w.iterations);
  try {
    return await subtle().unwrapKey(
      "raw",
      buf(w.wrapped),
      kek,
      { name: "AES-GCM", iv: buf(w.iv) },
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    // La etiqueta de autenticación de AES-GCM no coincide: frase incorrecta.
    throw new WrongPassphraseError();
  }
}

export async function seal(key: CryptoKey, aad: string, value: unknown): Promise<Sealed> {
  const iv = random(12);
  const data = await subtle().encrypt(
    { name: "AES-GCM", iv: buf(iv), additionalData: buf(enc.encode(aad)) },
    key,
    buf(enc.encode(JSON.stringify(value))),
  );
  return { iv, data: new Uint8Array(data) };
}

export async function unseal<T>(key: CryptoKey, aad: string, s: Sealed): Promise<T> {
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: buf(s.iv), additionalData: buf(enc.encode(aad)) },
    key,
    buf(s.data),
  );
  return JSON.parse(dec.decode(plain)) as T;
}

/** Etiqueta del profesional para encontrar su espacio sin guardar su identificador en claro. */
export async function ownerTag(professionalId: string) {
  const h = new Uint8Array(await subtle().digest("SHA-256", enc.encode(`aa-offline:${professionalId}`)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId() {
  return globalThis.crypto.randomUUID();
}
