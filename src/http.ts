import { SifendeApiError, SifendeConexionError, SifendeTimeoutError } from './errores.js';
import { VERSION } from './version.js';

export type Ambiente = 'PROD' | 'DEV' | 'SANDBOX';

export interface OpcionesCliente {
  /** API key del contribuyente: `sk_live_…`, `sk_test_…` o `sk_sandbox_…`. */
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Tiempo máximo por intento. Por defecto 30 s. */
  timeoutMs?: number;
  /** Reintentos ante fallas transitorias. Por defecto 2. */
  maxReintentos?: number;
}

export interface OpcionesSolicitud {
  signal?: AbortSignal;
}

export interface OpcionesIdempotentes extends OpcionesSolicitud {
  /** Si no se indica, el SDK genera un UUID v4 y lo reusa en sus reintentos. */
  idempotencyKey?: string;
}

export interface Solicitud {
  metodo: 'GET' | 'POST' | 'PUT' | 'DELETE';
  ruta: string;
  query?: Record<string, string | number | boolean | undefined> | undefined;
  cuerpo?: unknown;
  idempotencyKey?: string | undefined;
  autenticar?: boolean | undefined;
  /** Accept de una descarga (PDF, XML, PNG). Sin `binario`, el éxito se lee como texto. */
  acepta?: string | undefined;
  binario?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface Respuesta<T> {
  status: number;
  headers: Headers;
  datos: T;
}

export const URL_BASE = 'https://api.sifende.com.py';

// Accept de cada descarga. Incluyen JSON porque los errores, y el 202 del KuDE, vienen en JSON.
export const ACEPTA_PDF = 'application/pdf, application/json, application/problem+json';
export const ACEPTA_XML = 'application/xml, application/json, application/problem+json';
export const ACEPTA_PNG = 'image/png, application/json, application/problem+json';

const PREFIJOS: Record<string, Ambiente> = {
  sk_live_: 'PROD',
  sk_test_: 'DEV',
  sk_sandbox_: 'SANDBOX',
};

// Códigos que la guía de idempotencia indica repetir con la misma clave.
const CODIGOS_REINTENTABLES = new Set(['idempotency-in-progress', 'idempotency-upstream-unknown']);

export class ClienteHttp {
  readonly ambiente: Ambiente | undefined;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxReintentos: number;

  constructor(opciones: OpcionesCliente) {
    if (!opciones.apiKey?.trim()) throw new TypeError('Falta la API key de Sifende');
    this.apiKey = opciones.apiKey.trim();
    this.ambiente = Object.entries(PREFIJOS).find(([prefijo]) => this.apiKey.startsWith(prefijo))?.[1];
    this.baseUrl = (opciones.baseUrl ?? URL_BASE).replace(/\/+$/, '');
    if (!URL.canParse(this.baseUrl)) throw new TypeError(`baseUrl no es una URL válida: ${this.baseUrl}`);
    this.fetch = opciones.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opciones.timeoutMs ?? 30_000;
    if (!(Number.isFinite(this.timeoutMs) && this.timeoutMs > 0)) {
      throw new RangeError(`timeoutMs debe ser un número positivo: ${this.timeoutMs}`);
    }
    this.maxReintentos = opciones.maxReintentos ?? 2;
    if (!(Number.isInteger(this.maxReintentos) && this.maxReintentos >= 0)) {
      throw new RangeError(`maxReintentos debe ser un entero mayor o igual a 0: ${this.maxReintentos}`);
    }
  }

  url(ruta: string, query?: Solicitud['query']): string {
    const url = new URL(`${this.baseUrl}${ruta}`);
    for (const [clave, valor] of Object.entries(query ?? {})) {
      if (valor !== undefined) url.searchParams.set(clave, String(valor));
    }
    return url.toString();
  }

  async solicitar<T>(solicitud: Solicitud): Promise<Respuesta<T>> {
    // Se arma una sola vez: todos los intentos envían los mismos bytes bajo la misma Idempotency-Key.
    const url = this.url(solicitud.ruta, solicitud.query);
    const init = this.preparar(solicitud);

    for (let intento = 0; ; intento++) {
      let respuesta: Response;
      let datos: unknown;
      try {
        // El intento abarca la lectura del cuerpo: un corte o un timeout a mitad de la respuesta es una falla de
        // conexión como cualquier otra.
        const limite = AbortSignal.timeout(this.timeoutMs);
        respuesta = await this.fetch(url, {
          ...init,
          signal: solicitud.signal ? AbortSignal.any([solicitud.signal, limite]) : limite,
        });
        datos = await leerCuerpo(respuesta, solicitud.binario === true && respuesta.ok && respuesta.status !== 202);
      } catch (error) {
        if (solicitud.signal?.aborted) throw error;
        const reintentable = solicitud.metodo === 'GET' || solicitud.idempotencyKey !== undefined;
        if (reintentable && intento < this.maxReintentos) {
          await esperar(demora(intento), solicitud.signal);
          continue;
        }
        throw errorDeConexion(error, solicitud.idempotencyKey);
      }

      if (respuesta.ok) return { status: respuesta.status, headers: respuesta.headers, datos: datos as T };

      const error = new SifendeApiError({
        status: respuesta.status,
        cuerpo: datos,
        headers: respuesta.headers,
        idempotencyKey: solicitud.idempotencyKey,
      });
      if (intento < this.maxReintentos && esReintentable(error, solicitud)) {
        await esperar(error.reintentarEn !== undefined ? error.reintentarEn * 1000 : demora(intento), solicitud.signal);
        continue;
      }
      throw error;
    }
  }

  private preparar(solicitud: Solicitud): RequestInit {
    const headers = new Headers({
      Accept: solicitud.acepta ?? 'application/json',
      'User-Agent': `sifende-sdk-ts/${VERSION}`,
    });
    if (solicitud.autenticar !== false) headers.set('Authorization', `Bearer ${this.apiKey}`);
    if (solicitud.idempotencyKey !== undefined) headers.set('Idempotency-Key', solicitud.idempotencyKey);
    if (solicitud.cuerpo !== undefined) headers.set('Content-Type', 'application/json');

    return {
      method: solicitud.metodo,
      headers,
      body: solicitud.cuerpo === undefined ? null : JSON.stringify(solicitud.cuerpo),
    };
  }
}

function esReintentable(error: SifendeApiError, solicitud: Solicitud): boolean {
  if (error.status === 429) return true;
  if (error.codigo !== undefined && CODIGOS_REINTENTABLES.has(error.codigo)) return true;
  if (error.status === 503 && error.codigo === 'evento-nominacion-error') return true;
  return solicitud.metodo === 'GET' && [500, 502, 503, 504].includes(error.status);
}

async function leerCuerpo(respuesta: Response, binario: boolean): Promise<unknown> {
  if (binario) return new Uint8Array(await respuesta.arrayBuffer());
  const texto = await respuesta.text();
  if (texto === '') return undefined;
  if (/json/i.test(respuesta.headers.get('content-type') ?? '')) {
    try {
      return JSON.parse(texto);
    } catch (error) {
      // Un error HTTP conserva el texto para diagnosticarlo; un éxito ilegible no puede pasar por el DTO esperado.
      if (respuesta.ok) throw new RespuestaIlegible(texto.slice(0, 200), { cause: error });
      return texto;
    }
  }
  return texto;
}

class RespuestaIlegible extends Error {}

function errorDeConexion(error: unknown, idempotencyKey: string | undefined): SifendeConexionError {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new SifendeTimeoutError('La API de Sifende no respondió a tiempo', { cause: error, idempotencyKey });
  }
  if (error instanceof RespuestaIlegible) {
    return new SifendeConexionError('La API de Sifende respondió un JSON que no se pudo leer', {
      cause: error,
      idempotencyKey,
    });
  }
  return new SifendeConexionError('No se pudo conectar con la API de Sifende', { cause: error, idempotencyKey });
}

function demora(intento: number): number {
  const base = Math.min(8_000, 500 * 2 ** intento);
  return base / 2 + Math.random() * (base / 2);
}

export function esperar(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolver, rechazar) => {
    if (signal?.aborted) return rechazar(signal.reason);
    const temporizador = setTimeout(() => {
      signal?.removeEventListener('abort', alAbortar);
      resolver();
    }, ms);
    function alAbortar() {
      clearTimeout(temporizador);
      rechazar(signal?.reason);
    }
    signal?.addEventListener('abort', alAbortar, { once: true });
  });
}
